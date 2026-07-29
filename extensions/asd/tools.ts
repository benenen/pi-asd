/**
 * 六个工具的实际逻辑。
 *
 * 这里不 import pi —— 依赖全靠注入，所以整层能用假 exec 测，尤其是 kill 守卫
 * 那两条拒绝路径（必须证明"一次 asd kill 都没发生"）。
 */

import type { Asd } from "./cli.ts";
import type { Registry } from "./registry.ts";
import { formatDuration, type WatcherPool } from "./watcher.ts";

export interface ToolResult {
  text: string;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface AgentPreset {
  /** `escapedTask` 已经过 shellEscape，直接拼进去。 */
  command(escapedTask: string): string;
  /** 是否注入 PI_SPAWNED / PI_PARENT_SESSION —— 只有 pi 子 agent 认这些。 */
  piChild: boolean;
}

export const PRESETS: Record<string, AgentPreset> = {
  pi: { command: (t) => `pi ${t}`, piChild: true },
  claude: { command: (t) => `claude --dangerously-skip-permissions ${t}`, piChild: false },
  codex: { command: (t) => `codex ${t}`, piChild: false },
};

/** 单引号包裹；内部单引号用 `'\''` 这套 POSIX 写法断开再接上。 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 从 `asd list --json` 的 `command`（pty 的前台进程）认出它跑的是哪个 agent 预设。
 *
 * 认不出来就返回 undefined。**这是个安全判断，不是便利判断**：认不出多半意味着
 * 那是个裸 shell，把任务描述 `send` 进去会被当成命令执行。宁可拒绝也不猜。
 */
export function agentOfCommand(
  command: string,
  presets: Record<string, AgentPreset>,
): string | undefined {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? "";
  return base.length > 0 && Object.hasOwn(presets, base) ? base : undefined;
}

export function buildSpawnCommand(o: {
  agent: string;
  task: string;
  parentSession?: string;
  /** 预设表；缺省用模块级 `PRESETS`。测试（尤其 e2e）可以传自己的一份，不碰全局状态。 */
  presets?: Record<string, AgentPreset>;
}): string {
  const presets = o.presets ?? PRESETS;
  const preset = presets[o.agent];
  if (!preset) throw new Error(`不认识的 agent：${o.agent}`);
  const parts: string[] = [];
  if (preset.piChild) {
    parts.push("PI_SPAWNED=1");
    if (o.parentSession !== undefined) {
      parts.push(`PI_PARENT_SESSION=${shellEscape(o.parentSession)}`);
    }
  }
  parts.push(preset.command(shellEscape(o.task)));
  return parts.join(" ");
}

export interface ToolConfig {
  defaultAgent: string;
  defaultCwd: string;
  followTimeout: string;
  /** boss 自己的 session 文件，spawn pi 子 agent 时传下去。 */
  parentSession?: string;
  /**
   * 预设表；缺省用模块级 `PRESETS`。
   *
   * 只给测试用（尤其 e2e 需要一个不用真起 claude/pi 的假 agent 预设）——
   * 直接改模块级 `PRESETS` 会污染所有共享它的测试/调用方，这个字段让调用方
   * 传一份自己的表，不碰全局状态。
   */
  presets?: Record<string, AgentPreset>;
}

export interface ToolDeps {
  asd: Asd;
  registry: Registry;
  watchers: WatcherPool;
  config: ToolConfig;
  now: () => number;
}

export interface SpawnParams {
  task: string;
  /**
   * 指名把任务交给这个**已经存在**的 session（可以不是 pi-asd 建的）。
   * 给了它就走收养路径，不做自动复用、也不新建。
   */
  session?: string;
  name?: string;
  cwd?: string;
  agent?: string;
  watch?: boolean;
  reuse?: boolean;
}

export interface Tools {
  spawn(p: SpawnParams): Promise<ToolResult>;
  agents(): Promise<ToolResult>;
  candidates(p: { cwd?: string }): Promise<ToolResult>;
  peek(p: { session: string; scrollback?: number }): Promise<ToolResult>;
  follow(p: { session: string; mode?: "settle" | "end"; timeout?: string }): Promise<ToolResult>;
  steer(p: { session: string; message: string }): Promise<ToolResult>;
  kill(p: { session: string }): Promise<ToolResult>;
}

const TASK_PREVIEW_MAX = 80;

function err(text: string): ToolResult {
  return { text, isError: true };
}

function preview(task: string): string {
  const line = task.replace(/\s+/g, " ").trim();
  return line.length <= TASK_PREVIEW_MAX ? line : `${line.slice(0, TASK_PREVIEW_MAX)}…`;
}

export function createTools(deps: ToolDeps): Tools {
  const { asd, registry, watchers, config, now } = deps;
  const presets = config.presets ?? PRESETS;

  /**
   * 并发 spawn 之间的临界区屏障：正在处理中、还没落盘到 registry 的 session
   * 名字（复用目标的名字，或者刚 allocateName 出来还没 asd create 完的新名字）。
   *
   * pi 扩展的并发工具执行模型下，同一条助手消息里的多个 `asd_spawn` 是并发跑
   * 的，会在同一份 `await asd.list()` 快照上各自决策 —— 不设这道屏障，两个
   * 并发 spawn 可能抢中同一个空闲 agent（都 send 进去，后者覆盖前者的任务），
   * 或者撞同一个新名字（第二个 `asd new` 被拒）。这个集合只活在这一个
   * `createTools` 实例的闭包里，不是模块级全局，避免多个实例互相干扰。
   */
  const reserved = new Set<string>();

  /** 台账里没有就拒绝 —— peek / follow / steer 共用。 */
  function requireKnown(session: string): ToolResult | undefined {
    if (registry.get(session) !== undefined) return undefined;
    const known = registry.names();
    return err(
      `"${session}" 不是本次 spawn 出来的 agent，不会碰它。` +
        `当前台账：${known.length > 0 ? known.join(" / ") : "（空）"}`,
    );
  }

  /** session 在 asd 里没了：清台账、停 watcher，返回一句说明。 */
  function dropGone(session: string): ToolResult {
    registry.remove(session);
    watchers.stop(session);
    return { text: `"${session}" 的 session 已结束，已从台账移除。` };
  }

  function rewatch(session: string, want: boolean): boolean {
    watchers.stop(session);
    const watching = want ? watchers.watch(session) : false;
    registry.setWatching(session, watching);
    return watching;
  }

  /**
   * 指名收养一个已存在的空闲 session。任何校验不过都不发送任何东西。
   *
   * 屏障必须在第一次 `await` 之前**同步**占住：`reserved.has` 检查和
   * `reserved.add` 中间不能有任何 await 缝隙，否则两个并发收养同一个 session
   * 的请求会都通过入口检查（这里以前就是这么错的 —— `reserved.add` 挪到了
   * `await asd.list()`/`await asd.cards()` 之后，两次并发调用都能挤过
   * `reserved.has` 那道同步检查，各自 await 完再各自 `send`，导致同一个
   * session 背靠背收到两段不相关的任务文本）。占位之后所有校验失败/成功的
   * 分支都用同一层 `try/finally` 收尾，不再叠一层嵌套的 try/finally。
   */
  async function adopt(session: string, task: string, wantWatch: boolean): Promise<ToolResult> {
    if (reserved.has(session)) {
      return err(`"${session}" 正在被另一次 spawn 处理，稍后再试。`);
    }
    reserved.add(session);
    try {
      const live = await asd.list();
      const info = live.find((s) => s.session === session);
      if (info === undefined) {
        return err(`asd 里没有叫 "${session}" 的 session。先用 asd_candidates 看看哪些能接活。`);
      }
      if (info.running) {
        return err(`"${session}" 正在干活，不会打断它。等它闲下来，或者另开一个。`);
      }
      const agent = agentOfCommand(info.command, presets);
      if (agent === undefined) {
        return err(
          `认不出 "${session}" 里跑的是哪个 agent（前台进程是 ${info.command}）。` +
            `往裸 shell 里送任务描述会被当命令执行，所以拒绝。`,
        );
      }
      const cards = await asd.cards();
      const card = cards.find((c) => c.session === session);
      if (card === undefined) {
        return err(`拿不到 "${session}" 的 card（工作目录），不会盲发任务。asd card 只对本地 daemon 可用。`);
      }

      const known = registry.get(session);
      if (!(await asd.send(session, task))) {
        if (known !== undefined) {
          registry.remove(session);
          watchers.stop(session);
        }
        return err(`"${session}" 的 session 已经不在了。`);
      }
      if (known === undefined) {
        registry.add({
          session,
          task,
          cwd: card.cwd,
          agent,
          createdAt: now(),
          // 不是我们建的 —— asd_kill 从此永远拒绝它。
          createdByUs: false,
          watching: false,
        });
      } else {
        known.task = task;
      }
      const watching = rewatch(session, wantWatch);
      const mine = known?.createdByUs === true;
      return {
        text:
          `任务已送给 "${session}"（${agent}，${card.cwd}）。` +
          (mine ? "" : `这个 session 不是 pi-asd 建的，asd_kill 不会结束它。`) +
          (watching ? "watcher 已挂上，它停下来时结果会自动推给你。" : ""),
        details: { session, agent, cwd: card.cwd, adopted: !mine, watching },
      };
    } finally {
      reserved.delete(session);
    }
  }

  return {
    async spawn(p) {
      if (typeof p.task !== "string" || p.task.trim().length === 0) {
        return err("task 不能为空 —— 派给 agent 的任务描述必须自包含。");
      }
      // 指名收养：走完就返回，不做自动复用、也不新建。
      if (p.session !== undefined) {
        return await adopt(p.session, p.task, p.watch !== false);
      }
      const agent = p.agent ?? config.defaultAgent;
      if (!presets[agent]) {
        return err(`不认识的 agent "${agent}"。可选：${Object.keys(presets).join(" / ")}`);
      }
      const cwd = p.cwd ?? config.defaultCwd;
      const wantWatch = p.watch !== false;

      const live = await asd.list();
      const liveMap = new Map(live.map((s) => [s.session, s]));

      // 本次 spawn 预留的名字/session —— 无论成功、失败、还是复用转新建的
      // 中途改道，收尾时都必须放行，否则一次失败就永久占住一个名字。
      let held: string | undefined;
      try {
        if (p.reuse !== false) {
          // 并发的另一个 spawn 可能已经在这份快照上预订了某个空闲 agent ——
          // 从候选池里摘掉，避免两边挑中同一个 session（registry.pickReusable
          // 对不在 map 里的条目本来就会跳过，不需要改它的签名）。
          const available = new Map(liveMap);
          for (const s of reserved) available.delete(s);

          const target = registry.pickReusable(
            {
              name: p.name === undefined ? undefined : registry.candidateName(p.name),
              agent,
              cwd,
            },
            available,
          );
          if (target !== undefined) {
            held = target.session;
            reserved.add(held);
            if (await asd.send(target.session, p.task)) {
              target.task = p.task;
              const watching = rewatch(target.session, wantWatch);
              return {
                text:
                  `复用空闲 agent "${target.session}"（${agent}，${cwd}），任务已送入。` +
                  (watching ? "watcher 已重挂，它停下来时结果会自动推给你。" : ""),
                details: { session: target.session, agent, cwd, reused: true, watching },
              };
            }
            // send 说 session 没了 —— 清掉它、放行预留，继续往下走新建。
            registry.remove(target.session);
            watchers.stop(target.session);
            reserved.delete(held);
            held = undefined;
          }
        }

        // 并发的另一个 spawn 可能已经预留了一个候选名字 —— 并进 taken，逼
        // allocateName 避开它，不然两边会算出同一个名字、第二次 asd new 被拒。
        const taken = new Set([...liveMap.keys(), ...reserved]);
        const name = registry.allocateName(p.name, taken);
        held = name;
        reserved.add(held);
        const cmd = buildSpawnCommand({
          agent,
          task: p.task,
          parentSession: config.parentSession,
          presets,
        });
        const session = await asd.create({ name, cwd, cmd });
        registry.add({
          session,
          task: p.task,
          cwd,
          agent,
          createdAt: now(),
          createdByUs: true,
          watching: false,
        });
        const watching = rewatch(session, wantWatch);
        return {
          text:
            `已 spawn agent "${session}"（${agent}，${cwd}）。` +
            (watching ? "watcher 已挂上，它停下来时结果会自动推给你。" : ""),
          details: { session, agent, cwd, command: cmd, reused: false, watching },
        };
      } finally {
        if (held !== undefined) reserved.delete(held);
      }
    },

    async agents() {
      if (registry.size === 0) return { text: "没有 spawn 出来的 agent。", details: { count: 0 } };

      const live = await asd.list();
      const liveMap = new Map(live.map((s) => [s.session, s]));
      const gone = registry.reconcile(new Set(liveMap.keys()));
      for (const g of gone) watchers.stop(g.session);

      const lines = registry.list().map((r) => {
        const info = liveMap.get(r.session)!;
        const state = info.running ? "running" : `idle ${formatDuration(info.idle_ms)}`;
        const w = r.watching ? " watcher" : "";
        return `${r.session} [${state}${w}] (${r.agent}, ${r.cwd}): ${preview(r.task)}`;
      });
      const goneLine =
        gone.length > 0 ? `\n已结束：${gone.map((g) => g.session).join(" / ")}` : "";

      return {
        text: (lines.length > 0 ? lines.join("\n") : "没有存活的 agent。") + goneLine,
        details: { count: lines.length, ended: gone.map((g) => g.session) },
      };
    },

    async candidates(p) {
      const [cards, live] = await Promise.all([asd.cards(), asd.list()]);
      const cardBy = new Map(cards.map((c) => [c.session, c]));

      const rows: {
        session: string;
        cwd: string;
        docs: string[];
        title: string;
        agent: string;
        idleMs: number;
        mine: boolean;
      }[] = [];
      for (const info of live) {
        if (info.running) continue;
        const agent = agentOfCommand(info.command, presets);
        if (agent === undefined) continue;
        const card = cardBy.get(info.session);
        if (card === undefined) continue;
        if (p.cwd !== undefined && card.cwd !== p.cwd) continue;
        rows.push({
          session: info.session,
          cwd: card.cwd,
          docs: card.docs,
          title: info.title,
          agent,
          idleMs: info.idle_ms,
          // "mine" 是"asd_kill 能不能碰它"的判据，不是"台账里有没有它"——
          // 收养来的 session 也在台账里，但 createdByUs 是 false，仍然不能 kill。
          mine: registry.get(info.session)?.createdByUs === true,
        });
      }
      rows.sort((a, b) => b.idleMs - a.idleMs);

      if (rows.length === 0) {
        return {
          text:
            p.cwd === undefined
              ? "没有空闲且能接活的 session。"
              : `${p.cwd} 下没有空闲且能接活的 session。`,
          details: { count: 0 },
        };
      }

      const lines = rows.map((r) => {
        const head = `${r.session}（${r.agent}，闲了 ${formatDuration(r.idleMs)}${
          r.mine ? "" : "，不是本 boss 建的：收养后不能 kill"
        }）`;
        const parts = [head, `  目录：${r.cwd}`];
        if (r.docs.length > 0) parts.push(`  文档：${r.docs.join(" ")}`);
        if (r.title.length > 0) parts.push(`  正在做：${r.title}`);
        return parts.join("\n");
      });
      return {
        text: lines.join("\n"),
        details: { count: rows.length, sessions: rows.map((r) => r.session) },
      };
    },

    async peek(p) {
      const bad = requireKnown(p.session);
      if (bad) return bad;
      const screen = await asd.peek(p.session, p.scrollback);
      if (screen === null) return dropGone(p.session);
      return { text: screen, details: { session: p.session } };
    },

    async follow(p) {
      const bad = requireKnown(p.session);
      if (bad) return bad;
      const outcome = await asd.follow(p.session, {
        forever: p.mode === "end",
        timeout: p.timeout ?? config.followTimeout,
      });
      if (outcome.kind === "gone") return dropGone(p.session);

      const screen = await asd.peek(p.session);
      const head =
        outcome.kind === "timeout"
          ? `"${p.session}" 还在忙（follow 超时）。`
          : `"${p.session}" 已停下。`;
      return {
        text:
          `${head}\n--- 过程输出 ---\n${outcome.text}\n` +
          `--- 最后一屏 ---\n${screen ?? "(session 已消失)"}`,
        details: { session: p.session, outcome: outcome.kind },
      };
    },

    async steer(p) {
      const bad = requireKnown(p.session);
      if (bad) return bad;
      if (!(await asd.send(p.session, p.message))) return dropGone(p.session);
      const watching = rewatch(p.session, true);
      return {
        text: `已把消息送给 "${p.session}"。${watching ? "watcher 已重挂。" : ""}`,
        details: { session: p.session, watching },
      };
    },

    async kill(p) {
      // 硬不变量：只有台账里、且确实是 pi-asd 自己新建的 session 才允许 kill。
      // 这个判断必须在任何 asd 调用之前。
      const decision = registry.canKill(p.session);
      if (!decision.ok) {
        if (decision.reason === "unknown") {
          return err(
            `"${p.session}" 不是本次 spawn 出来的 agent，不会 kill。` +
              `当前台账：${decision.known.length > 0 ? decision.known.join(" / ") : "（空）"}`,
          );
        }
        return err(`"${p.session}" 不是 pi-asd 新建的 session，绝不 kill。`);
      }

      watchers.stop(p.session);
      const existed = await asd.kill(p.session);
      registry.remove(p.session);
      return {
        text: existed ? `已 kill "${p.session}"。` : `"${p.session}" 已经不在了，已从台账移除。`,
        details: { session: p.session, existed },
      };
    },
  };
}
