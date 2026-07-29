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

export function buildSpawnCommand(o: {
  agent: string;
  task: string;
  parentSession?: string;
}): string {
  const preset = PRESETS[o.agent];
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
  name?: string;
  cwd?: string;
  agent?: string;
  watch?: boolean;
  reuse?: boolean;
}

export interface Tools {
  spawn(p: SpawnParams): Promise<ToolResult>;
  agents(): Promise<ToolResult>;
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

  return {
    async spawn(p) {
      if (typeof p.task !== "string" || p.task.trim().length === 0) {
        return err("task 不能为空 —— 派给 agent 的任务描述必须自包含。");
      }
      const agent = p.agent ?? config.defaultAgent;
      if (!PRESETS[agent]) {
        return err(`不认识的 agent "${agent}"。可选：${Object.keys(PRESETS).join(" / ")}`);
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
        const cmd = buildSpawnCommand({ agent, task: p.task, parentSession: config.parentSession });
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
