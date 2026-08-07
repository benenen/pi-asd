import { test } from "node:test";
import assert from "node:assert/strict";
import { createAsd, type Exec, type ExecResult, type SessionInfo } from "../extensions/asd/cli.ts";
import { Registry } from "../extensions/asd/registry.ts";
import { WatcherPool } from "../extensions/asd/watcher.ts";
import {
  agentOfCommand,
  bashInteractive,
  bossStartMessage,
  buildSpawnCommand,
  createTools,
  looksIdle,
  PRESETS,
  screenHasText,
  parseBossDefault,
  REUSE_MIN_IDLE_MS,
  resolveAgentArg,
  resolveNavKeys,
  shellEscape,
  withAlias,
  withEnv,
  type AgentPreset,
  type Tools,
} from "../extensions/asd/tools.ts";
import { resolveWorkspaceBase } from "../extensions/asd/config.ts";
import { sessionsToReap } from "../extensions/asd/reaper.ts";

interface Harness {
  tools: Tools;
  registry: Registry;
  watchers: WatcherPool;
  calls: string[][];
  /** asd list 会吐出来的 session。 */
  live: SessionInfo[];
  /** mkdirp 被调用过的目录，按调用顺序。 */
  mkdirs: string[];
}

function info(session: string, o: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session,
    status: "idle",
    command: "bash",
    title: "",
    pid: 1,
    cols: 80,
    rows: 24,
    created_ms: 0,
    idle_ms: 0,
    running: false,
    attached_clients: 0,
    ...o,
  };
}

function card(session: string, cwd: string, docs: string[] = []): {
  session: string;
  status: string;
  cwd: string;
  docs: string[];
} {
  return { session, status: "idle", cwd, docs };
}

interface ScreenFixture {
  screen: string;
  cursor: { row: number; col: number };
  cols?: number;
}

interface StyledScreenFixture extends ScreenFixture {
  faintRanges: { row: number; startCol: number; endCol: number }[];
}

/** fake `asd peek` 同时支持 raw 和 `--json`；默认光标在最后一个可见字符后。 */
function peekStdout(
  args: string[],
  screen: string,
  cursor?: { row: number; col: number },
  cols = 181,
  faintRanges?: StyledScreenFixture["faintRanges"],
): string {
  if (!args.includes("--json")) return screen;
  const lines = screen.split("\n");
  // 真 `peek --json` 会省略 raw screen 尾部的空白行，但 cursor 仍指向完整终端行。
  const rendered = screen.replace(/\n+$/, "");
  const snapshot: Record<string, unknown> = {
    session: args[1],
    title: "",
    rows: lines.length,
    cols,
    cursor: cursor ?? { row: lines.length - 1, col: lines.at(-1)?.length ?? 0 },
    screen: rendered,
  };
  if (args.includes("--styles")) {
    snapshot.faint_ranges = (faintRanges ?? []).map((range) => ({
      row: range.row,
      start_col: range.startCol,
      end_col: range.endCol,
    }));
  }
  return JSON.stringify(snapshot);
}

/**
 * 假 exec：按子命令决定回什么。live 数组由测试直接改，改完下一次 asd list 就生效。
 * follow 永远挂住不返回 —— watcher 的行为在 watcher.test.ts 里测过了，这里只关心
 * "有没有挂上"。
 */
function harness(
  o: {
    live?: SessionInfo[];
    cards?: ReturnType<typeof card>[];
    bossSession?: string;
    newEchoes?: string;
    /**
     * 认定"停下来等输入"所需的最短静默，默认 0。
     *
     * 这一组测试关心的是复用/候选/收养的**判定逻辑**，不是那道静默门槛，所以
     * 默认把门槛放到 0（等价于旧的"只看 running"）。要用真实门槛就**显式传**
     * `REUSE_MIN_IDLE_MS` —— 传 undefined 会被这里的 `?? 0` 吃掉，拿到的还是 0。
     * 门槛本身有它自己的一组测试，见文件末尾"静默门槛"那一节。
     */
    reuseMinIdleMs?: number;
    /** 假屏幕永不回显送进去的文本 —— 模拟"文本被别的 UI 吃了"。 */
    swallowText?: boolean;
    /** 前几次 peek 回这些内容（模拟启动期界面），用完之后回正常屏幕。 */
    startupScreens?: string[];
    /**
     * 正文送出后，前几次 peek 依次回这些屏幕。用来模拟长粘贴仍在逐帧渲染；
     * 用完之后才回完整输入框。
     */
    echoScreens?: string[];
    /** echoScreens 没走完之前按 Enter，一律只当输入框换行，不算提交。 */
    requireEchoScreensBeforeSubmit?: boolean;
    /** Enter 的提交行为：默认提交；newline 模拟粘贴换行，ignored 模拟尚未处理按键。 */
    enterBehavior?:
      | "submit"
      | "newline-once"
      | "newline-always"
      | "ignored-once"
      | "ignored"
      | "mutated"
      | "mutated-prompt"
      | "cleared"
      | "cleared-prompt"
      | "whitespace-mutated"
      | "newline-structural-mutation"
      | "history"
      | "history-prompt";
    /** 第一颗 composer Enter 时 session 已消失，asd send 返回退出码 3。 */
    goneOnEnter?: boolean;
    /** 第一次 Enter 后弹出模态框（已经提交，但绝不能再补 Enter）。 */
    dialogAfterFirstEnter?: boolean;
    /** 正常输入框之前固定显示的历史内容。 */
    screenPrefix?: string;
    /** 正文 ACK 后固定显示的屏幕；函数形态可以按真正发送的 payload 模拟裁剪。 */
    screenAfterText?: string | ((text: string) => string);
    /** 光标不在屏幕末行的 TUI（例如 pi 的横线输入框）专用快照。 */
    snapshotBeforeText?: ScreenFixture;
    /** 同一屏幕的样式快照，只在 `peek --json --styles` 时返回。 */
    styledSnapshotBeforeText?: StyledScreenFixture;
    /** 模拟安装的 asd 太老，尚不认识 `peek --styles`。 */
    stylesUnsupported?: boolean;
    snapshotAfterText?: ScreenFixture | ((text: string) => ScreenFixture);
    /** 屏幕永远停在信任对话框上 —— 模拟"送了键也过不去"。 */
    stuckOnDialog?: boolean;
    /** peek 直接抛错 —— 验证单个失败不会搞掉整张表。 */
    peekThrows?: boolean;
    /** asd rename 的结果。 */
    renameOutcome?: "ok" | "gone" | "unsupported" | "failed";
    /** 透传给子 agent 的环境变量。 */
    spawnEnv?: Record<string, string>;
    /** 覆盖预设表（测别名映射用）。 */
    presets?: Record<string, AgentPreset>;
  } = {},
): Harness {
  const calls: string[][] = [];
  const live = o.live ?? [];

  /** session → 最近一次 --text 送进去的内容，供假 peek 回显。 */
  const typed = new Map<string, string>();
  /** 已真正提交的 session；假屏幕用 WORKING 表示 agent 开始执行。 */
  const submitted = new Set<string>();
  /** 曾经提交过的 session；下一次输入时旧 WORKING 仍留在历史区。 */
  const completed = new Set<string>();
  const enterCounts = new Map<string, number>();
  const dialogSessions = new Set<string>();
  const historySessions = new Set<string>();
  const promptHistorySessions = new Set<string>();
  const mutatedPromptSessions = new Set<string>();
  const submittedText = new Map<string, string>();
  const inputPrefix = o.screenPrefix ?? "› ";
  /** peek 调用次数，给 startupScreens 排队用。 */
  let peeks = 0;
  let echoPeeks = 0;
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
    switch (args[0]) {
      case "list":
        return ok(JSON.stringify(live));
      case "card":
        return ok(JSON.stringify(o.cards ?? []));
      case "new":
        // 一些测试需要模拟 asd 没有原样使用请求的名字（比如它自己也做了
        // 避重/改写），回显一个跟请求不同的名字。
        return ok(`${o.newEchoes ?? args[1]}\n`);
      case "peek": {
        if (o.peekThrows) throw new Error("peek 炸了");
        if (args.includes("--styles")) {
          if (o.stylesUnsupported) {
            return { stdout: "", stderr: "unexpected argument '--styles'", code: 2 };
          }
          const fixture = o.styledSnapshotBeforeText;
          if (fixture === undefined) throw new Error("没有准备 styled peek 夹具");
          return ok(
            peekStdout(
              args,
              fixture.screen,
              fixture.cursor,
              fixture.cols,
              fixture.faintRanges,
            ),
          );
        }
        if (o.stuckOnDialog)
          return ok(peekStdout(args, "❯ 1. Yes, I trust this folder\n  2. No, exit\n Enter to confirm"));
        if (dialogSessions.has(args[1]!)) {
          return ok(peekStdout(args, "❯ 1. Allow this action\n  2. Cancel\n Enter to confirm · Esc to cancel"));
        }
        const startup = o.startupScreens ?? [];
        if (peeks < startup.length) return ok(peekStdout(args, startup[peeks++]!));
        peeks += 1;
        if (
          !typed.has(args[1]!) &&
          !submitted.has(args[1]!) &&
          !completed.has(args[1]!) &&
          o.snapshotBeforeText !== undefined
        ) {
          const fixture = o.snapshotBeforeText;
          return ok(peekStdout(args, fixture.screen, fixture.cursor, fixture.cols));
        }
        const echoScreens = o.echoScreens ?? [];
        if (typed.has(args[1]!) && echoPeeks < echoScreens.length) {
          return ok(peekStdout(args, echoScreens[echoPeeks++]!));
        }
        if (typed.has(args[1]!) && o.screenAfterText !== undefined) {
          const sentText = typed.get(args[1]!)!;
          const screen =
            typeof o.screenAfterText === "function"
              ? o.screenAfterText(sentText)
              : o.screenAfterText;
          return ok(peekStdout(args, screen));
        }
        if (typed.has(args[1]!) && o.snapshotAfterText !== undefined) {
          const sentText = typed.get(args[1]!)!;
          const fixture =
            typeof o.snapshotAfterText === "function"
              ? o.snapshotAfterText(sentText)
              : o.snapshotAfterText;
          return ok(peekStdout(args, fixture.screen, fixture.cursor, fixture.cols));
        }
        if (historySessions.has(args[1]!)) {
          // 任务已从 composer 移到历史区，但还没画出 Working；整屏归一化文字
          // 与提交前相同，只有任务之前的空白布局变了。
          return ok(
            peekStdout(args, `SCREEN:${args[1]}\n• ${typed.get(args[1]!) ?? ""}\n${inputPrefix}`),
          );
        }
        if (promptHistorySessions.has(args[1]!)) {
          return ok(peekStdout(args, `SCREEN:${args[1]}\n> ${typed.get(args[1]!) ?? ""}\n> `));
        }
        // 投递校验会 peek 确认文本进了输入框 —— 假屏幕必须模拟这个行为，
        // 否则每一次 deliver() 都会判成"没投进去"。
        const echoed = o.swallowText ? "" : (typed.get(args[1]!) ?? "");
        if (submitted.has(args[1]!)) {
          // agent 输出完一帧以后，光标回到下一行的空 composer；旧实现把 WORKING
          // 和下一次输入挤在同一行，会让“重新指名交任务”的夹具制造假旧草稿。
          return ok(
            peekStdout(
              args,
              `SCREEN:${args[1]}\n• ${submittedText.get(args[1]!) ?? ""}\nWORKING\n${inputPrefix}`,
            ),
          );
        }
        const previousOutput = completed.has(args[1]!) ? "WORKING\n" : "";
        const currentInputPrefix = mutatedPromptSessions.has(args[1]!) ? "❯ " : inputPrefix;
        const renderedEcho = echoed.replaceAll("\n", "\n  ");
        return ok(
          peekStdout(args, `SCREEN:${args[1]}\n${previousOutput}${currentInputPrefix}${renderedEcho}`),
        );
      }
      case "send": {
        const session = args[1]!;
        if (args[2] === "--text") {
          typed.set(session, args[3] ?? "");
          submitted.delete(session);
          historySessions.delete(session);
          promptHistorySessions.delete(session);
          echoPeeks = 0;
        }
        if (args[2] === "--key" && args[3] === "Enter") {
          // 启动期对话框/nav 的 Enter 没有任务正文，不是 composer 提交。
          if (!typed.has(session)) return ok();
          if (o.goneOnEnter) return { stdout: "", stderr: "no such session", code: 3 };
          const count = (enterCounts.get(session) ?? 0) + 1;
          enterCounts.set(session, count);
          if (o.dialogAfterFirstEnter && count === 1) {
            typed.delete(session);
            dialogSessions.add(session);
          } else {
            const echoStillMoving =
              o.requireEchoScreensBeforeSubmit === true && echoPeeks < (o.echoScreens?.length ?? 0);
            const behavior = o.enterBehavior ?? "submit";
            const newlineOnly =
              echoStillMoving || behavior === "newline-always" || (behavior === "newline-once" && count === 1);
            if (behavior === "history") {
              historySessions.add(session);
            } else if (behavior === "history-prompt") {
              promptHistorySessions.add(session);
            } else if (behavior === "ignored" || (behavior === "ignored-once" && count === 1)) {
              // TUI 尚未处理 Enter，屏幕和输入框都完全没变。
            } else if (behavior === "mutated") {
              // Enter 没提交，外部 attach 反而抢先在 composer 前面插入了字符。
              // 唯一 proof 仍然在当前 composer，只是全文不再精确相等。
              typed.set(session, `X${typed.get(session) ?? ""}`);
            } else if (behavior === "mutated-prompt") {
              // 模拟 TUI 同时换 prompt 字形且改写 composer：原锚点无法识别，
              // 但唯一 proof 还清清楚楚留在可见输入里。
              typed.set(session, `X${typed.get(session) ?? ""}`);
              mutatedPromptSessions.add(session);
            } else if (behavior === "cleared") {
              // 外部 attach 在 Enter 之后抢先清空 composer；proof 消失但任务并未提交。
              typed.delete(session);
            } else if (behavior === "cleared-prompt") {
              // 清空同时 UI 换了 prompt 字形，原 anchor 无法再识别。
              typed.delete(session);
              mutatedPromptSessions.add(session);
            } else if (behavior === "whitespace-mutated") {
              // proof 仍在，但正文里的真实空格被外部 attach 改写。
              typed.set(session, (typed.get(session) ?? "").replace("检查提交", "检查 提交"));
            } else if (behavior === "newline-structural-mutation") {
              // 第一颗 Enter 插入换行时，外部 attach 同时写入过去会被噪声规则删掉的字符。
              typed.set(session, `${(typed.get(session) ?? "").replace("检查提交", "检查>提交")}\n`);
            } else if (newlineOnly) {
              typed.set(session, `${typed.get(session) ?? ""}\n`);
            } else {
              submittedText.set(session, typed.get(session) ?? "");
              typed.delete(session);
              submitted.add(session);
              completed.add(session);
            }
          }
        }
        return ok();
      }
      case "rename": {
        if (o.renameOutcome === "gone") return { stdout: "", stderr: "no such session", code: 3 };
        if (o.renameOutcome === "unsupported")
          return { stdout: "", stderr: "error: unrecognized subcommand 'rename'", code: 2 };
        if (o.renameOutcome === "failed")
          return { stdout: "", stderr: "session 'x' already exists", code: 1 };
        return ok(`${args[2]}\n`);
      }
      case "kill":
        return ok();
      case "follow":
        return new Promise<ExecResult>(() => {});
      default:
        throw new Error(`没准备好的子命令：${args.join(" ")}`);
    }
  };

  // enterDelayMs: 0 —— send 现在分两次发（正文、Enter），单测不该真睡 300ms
  const asd = createAsd(exec, { enterDelayMs: 0 });
  const registry = new Registry("pi-");
  const watchers = new WatcherPool({ asd, notify: () => {}, timeout: "30m", now: () => 0 });
  const mkdirs: string[] = [];
  const tools = createTools({
    asd,
    registry,
    watchers,
    config: {
      defaultAgent: "pi",
      workspaceBase: "/base",
      followTimeout: "30m",
      parentSession: "/s.jsonl",
      bossSession: o.bossSession,
      reuseMinIdleMs: o.reuseMinIdleMs ?? 0,
      spawnEnv: o.spawnEnv,
      presets: o.presets,
    },
    mkdirp: async (d) => {
      mkdirs.push(d);
    },
    now: () => 0,
    // deliver()/prepare() 会真的等（回显 400ms、启动轮询 700ms）——单测不能真睡
    sleep: async () => {},
  });

  return { tools, registry, watchers, calls, live, mkdirs };
}

/** 这次跑过的 asd 子命令名。注意一次逻辑送达现在是两条 send（正文 + Enter）。 */
function subcommands(h: Harness): string[] {
  return h.calls.map((c) => c[0]);
}

/**
 * 真正"送达"了几次 —— 只数带 `--text` 的那条 send。
 *
 * `send` 现在分两次发（正文一次、`--key Enter` 一次，见 cli.ts 的
 * ENTER_DELAY_MS），所以再拿 `subcommands().filter(c => c === "send").length`
 * 当"送达次数"就会翻倍。想表达"恰好送达一次"的断言必须用这个。
 */
function deliveries(h: Harness): string[][] {
  return h.calls.filter((c) => c[0] === "send" && c.includes("--text"));
}

/** 补发的回车调用。 */
function enterKeys(h: Harness): string[][] {
  return h.calls.filter((c) => c[0] === "send" && c.includes("--key"));
}

function styledPeeks(h: Harness): string[][] {
  return h.calls.filter((c) => c[0] === "peek" && c.includes("--styles"));
}

/**
 * 制造"两个并发 spawn 共享同一份 asd list 快照"的假 exec。
 *
 * pi 扩展是并发工具执行模型：同一条助手消息里的多个 `asd_spawn` 会并发跑，
 * 各自 `await asd.list()` 拿到的很可能是同一份快照。前 `barrierCount` 次
 * `list` 调用会互相卡住，直到凑够 `barrierCount` 个才一起放行——这样能稳定
 * 复现"两边在同一份快照上做决策"的临界区交叠，不用赌具体的微任务调度顺序。
 * 凑够之后的 list 调用（比如某个测试里失败重试时追加的一次顺序调用）照常
 * 立即返回，不再等人。
 */
function raceHarness(o: { live?: SessionInfo[]; barrierCount?: number } = {}): Harness {
  const calls: string[][] = [];
  const live = o.live ?? [];
  const barrierCount = o.barrierCount ?? 2;
  let listCalls = 0;
  let waiting: Array<() => void> = [];

  /** session → 最近一次 --text 送进去的内容，供假 peek 回显。 */
  const typed = new Map<string, string>();
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
    switch (args[0]) {
      case "list": {
        listCalls += 1;
        if (listCalls <= barrierCount) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length >= barrierCount) {
              const batch = waiting;
              waiting = [];
              for (const r of batch) r();
            }
          });
        }
        return ok(JSON.stringify(live));
      }
      case "new":
        return ok(`${args[1]}\n`);
      case "peek":
        // 投递校验会 peek 确认文本进了输入框 —— 假屏幕必须模拟这个行为，
        // 否则每一次 deliver() 都会判成"没投进去"。
        return ok(peekStdout(args, `SCREEN:${args[1]}\n› ${typed.get(args[1]!) ?? ""}`));
      case "send":
        if (args[2] === "--text") typed.set(args[1]!, args[3] ?? "");
        return ok();
      case "rename":
        return ok(`${args[2]}\n`);
      case "kill":
        return ok();
      case "follow":
        return new Promise<ExecResult>(() => {});
      default:
        throw new Error(`没准备好的子命令：${args.join(" ")}`);
    }
  };

  // enterDelayMs: 0 —— send 现在分两次发（正文、Enter），单测不该真睡 300ms
  const asd = createAsd(exec, { enterDelayMs: 0 });
  const registry = new Registry("pi-");
  const watchers = new WatcherPool({ asd, notify: () => {}, timeout: "30m", now: () => 0 });
  const mkdirs: string[] = [];
  const tools = createTools({
    asd,
    registry,
    watchers,
    config: {
      defaultAgent: "pi",
      workspaceBase: "/base",
      followTimeout: "30m",
      parentSession: "/s.jsonl",
      reuseMinIdleMs: 0,
    },
    mkdirp: async (d) => {
      mkdirs.push(d);
    },
    now: () => 0,
    // deliver()/prepare() 会真的等（回显 400ms、启动轮询 700ms）——单测不能真睡
    sleep: async () => {},
  });

  return { tools, registry, watchers, calls, live, mkdirs };
}

test("shellEscape 用单引号包住并转义内部单引号", () => {
  assert.equal(shellEscape("go"), "'go'");
  assert.equal(shellEscape("it's"), "'it'\\''s'");
  assert.equal(shellEscape("a b; rm -rf /"), "'a b; rm -rf /'");
});

test("buildSpawnCommand 只给 pi 子 agent 注入 PI_SPAWNED / PI_PARENT_SESSION", () => {
  const pi = buildSpawnCommand({ agent: "pi", task: "go", parentSession: "/s.jsonl" });
  assert.match(pi, /^PI_SPAWNED=1 PI_PARENT_SESSION='\/s\.jsonl' pi 'go'$/);

  const claude = buildSpawnCommand({ agent: "claude", task: "go", parentSession: "/s.jsonl" });
  assert.equal(claude, "claude --dangerously-skip-permissions 'go'");
  assert.doesNotMatch(claude, /PI_SPAWNED/);
});

test("buildSpawnCommand 没有 parentSession 时不写那个变量", () => {
  assert.equal(buildSpawnCommand({ agent: "pi", task: "go" }), "PI_SPAWNED=1 pi 'go'");
});

test("spawn 台账为空时新建 session 并挂 watcher", async () => {
  const h = harness();
  const r = await h.tools.spawn({ task: "修 auth" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(subcommands(h), ["list", "new", "follow"]);
  assert.deepEqual(h.registry.names(), ["pi-agent1"]);
  assert.equal(h.watchers.isWatching("pi-agent1"), true);
  h.watchers.stopAll();
});

test("spawn 给了 name 就用它做 session 名", async () => {
  const h = harness();
  await h.tools.spawn({ task: "t", name: "auth fix" });
  assert.deepEqual(h.registry.names(), ["pi-auth-fix"]);
  h.watchers.stopAll();
});

test("spawn 命中空闲 agent 时走 send 而不是 new", async () => {
  const h = harness({ live: [info("pi-agent1", { running: false, idle_ms: 9_000 })] });
  h.registry.add({
    session: "pi-agent1",
    task: "旧任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const r = await h.tools.spawn({ task: "新任务" });
  assert.match(r.text, /复用/);
  assert.equal(subcommands(h).includes("new"), false, "命中复用就不能新建");
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 1, "正常提交只按一次 Enter");
  assert.ok(subcommands(h).filter((c) => c === "peek").length >= 2, "提交前后都必须观察屏幕");
  assert.equal(h.registry.get("pi-agent1")?.task, "新任务");
  assert.equal(h.watchers.isWatching("pi-agent1"), true);
  h.watchers.stopAll();
});

// C1 回归：指名交过任务的用户 session 记进台账时 createdByUs 是 false —— 一次
// **没有点名**任何 session 的普通 asd_spawn 绝不能把它当成自己人自动复用。
// 复现的是审查报告里那个场景：boss 先指名把任务交给了 "mem"，之后再随手 spawn 一个
// 没点名的任务，如果 pickReusable 只看 agent/cwd/running，"mem" 会被当成
// 空闲的自己人，任务被 send 进用户正在用的终端。
test("spawn 不会把指名交过任务的用户 session 自动复用 —— 即使 agent/cwd 都匹配、且空闲", async () => {
  const h = harness({ live: [info("mem", { running: false, command: "claude", idle_ms: 999_999 })] });
  h.registry.add({
    session: "mem",
    task: "上一轮交给它的任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: false,
  });

  const r = await h.tools.spawn({ task: "新任务，没点名任何 session" });
  assert.equal(r.isError, undefined, r.text);
  assert.ok(
    subcommands(h).includes("new"),
    "台账里唯一匹配的候选是指名交过任务的，必须走新建，不能走 send",
  );
  assert.ok(!subcommands(h).includes("send"), "绝不能把任务 send 进指名交过任务的用户 session");
  assert.equal(h.registry.get("mem")?.task, "上一轮交给它的任务", "指名交过任务的记录的任务不该被这次 spawn 覆盖");
  h.watchers.stopAll();
});

test("spawn 遇到还在忙的 agent 不复用，另开一个", async () => {
  const h = harness({ live: [info("pi-agent1", { running: true })] });
  h.registry.add({
    session: "pi-agent1",
    task: "旧",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  await h.tools.spawn({ task: "新" });
  assert.ok(subcommands(h).includes("new"));
  assert.equal(h.registry.size, 2);
  h.watchers.stopAll();
});

test("spawn 的 reuse:false 强制新建", async () => {
  const h = harness({ live: [info("pi-agent1", { running: false, idle_ms: 9_000 })] });
  h.registry.add({
    session: "pi-agent1",
    task: "旧",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  await h.tools.spawn({ task: "新", reuse: false });
  assert.ok(subcommands(h).includes("new"));
  assert.ok(!subcommands(h).includes("send"));
  h.watchers.stopAll();
});

test("spawn 的 watch:false 不挂 watcher", async () => {
  const h = harness();
  await h.tools.spawn({ task: "t", watch: false });
  assert.deepEqual(subcommands(h), ["list", "new"]);
  assert.equal(h.watchers.isWatching("pi-agent1"), false);
});

test("resolveWorkspaceBase 未设置 / 空串 / 纯空白都回落到默认", () => {
  assert.equal(resolveWorkspaceBase(undefined, "/fallback"), "/fallback");
  assert.equal(resolveWorkspaceBase("", "/fallback"), "/fallback");
  assert.equal(resolveWorkspaceBase("   ", "/fallback"), "/fallback");
});

test("resolveWorkspaceBase 给了就用给的，去掉首尾空白", () => {
  assert.equal(resolveWorkspaceBase("/w/agents", "/fallback"), "/w/agents");
  assert.equal(resolveWorkspaceBase("  /w/agents  ", "/fallback"), "/w/agents");
});

test("spawn 不给 cwd 时在 <base>/<session 名> 里开工，并且先建目录", async () => {
  const h = harness();
  const r = await h.tools.spawn({ task: "t", name: "one", watch: false });
  assert.equal(r.isError, undefined, r.text);
  assert.deepEqual(h.mkdirs, ["/base/pi-one"]);
  const newCall = h.calls.find((c) => c[0] === "new");
  assert.ok(newCall, "应当调用了 asd new");
  assert.equal(newCall[newCall.indexOf("--cwd") + 1], "/base/pi-one");
  assert.equal(h.registry.get("pi-one")?.cwd, "/base/pi-one");
});

test("spawn 给了 cwd 就原样用，而且不替他建目录", async () => {
  const h = harness();
  await h.tools.spawn({ task: "t", name: "one", cwd: "/explicit", watch: false });
  assert.deepEqual(h.mkdirs, [], "显式给的路径打错了应当让 asd new 大声失败，不要悄悄建出来");
  const newCall = h.calls.find((c) => c[0] === "new");
  assert.equal(newCall![newCall!.indexOf("--cwd") + 1], "/explicit");
});

test("两次都不给 cwd 时，第二次能复用第一次的 agent（目录不同也照样复用）", async () => {
  const h = harness();
  await h.tools.spawn({ task: "第一个", name: "one", watch: false });
  // 让它变成 asd 里存在且空闲的
  h.live.push(info("pi-one", { running: false, idle_ms: 5000 }));

  const second = await h.tools.spawn({ task: "第二个", watch: false });
  assert.match(second.text, /复用/);
  assert.equal(h.calls.filter((c) => c[0] === "new").length, 1, "第二次不该再 new");
  assert.equal(h.registry.get("pi-one")?.task, "第二个");
});

test("给了 cwd 时复用仍然要求目录精确相等", async () => {
  const h = harness({ live: [info("pi-one", { running: false, idle_ms: 5000 })] });
  h.registry.add({
    session: "pi-one",
    task: "旧",
    cwd: "/base/pi-one",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  await h.tools.spawn({ task: "新", cwd: "/somewhere/else", watch: false });
  assert.ok(h.calls.some((c) => c[0] === "new"), "目录不同就该新建而不是复用");
});

test("spawn 拒绝空 task 和不认识的 agent，且完全不碰 asd", async () => {
  const h = harness();
  const empty = await h.tools.spawn({ task: "  " });
  assert.equal(empty.isError, true);
  const bad = await h.tools.spawn({ task: "t", agent: "gemini" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /pi|claude|codex/);
  assert.deepEqual(h.calls, []);
});

test("agents 台账为空时不打 asd", async () => {
  const h = harness();
  const r = await h.tools.agents();
  assert.match(r.text, /没有/);
  assert.deepEqual(h.calls, []);
});

test("list 直接列出 asd 里的全部 session，台账为空也不漏", async () => {
  const h = harness({
    live: [
      info("user-shell", { title: "手工会话" }),
      info("pi-a", { title: "子 agent" }),
    ],
  });

  const r = await h.tools.list();

  assert.match(r.text, /user-shell/);
  assert.match(r.text, /pi-a/);
  assert.equal(r.details?.count, 2);
  assert.deepEqual(r.details?.sessions, ["user-shell", "pi-a"]);
  assert.deepEqual(subcommands(h), ["list"], "清单不能顺手读取用户 session 的屏幕");
  assert.doesNotMatch(r.text, /手工会话|子 agent|SCREEN:/, "只展示 session 名，不暴露标题或屏幕内容");
});

test("list 没有 session 时返回明确的空清单", async () => {
  const h = harness();
  const r = await h.tools.list();

  assert.match(r.text, /没有 asd session/);
  assert.deepEqual(r.details, { count: 0, sessions: [] });
  assert.deepEqual(subcommands(h), ["list"]);
});

test("同一轮 agent 执行里 list 只查询一次；下一轮才重新放行", async () => {
  const h = harness({ live: [info("one")] });

  const first = await h.tools.list();
  const repeated = await h.tools.list();

  assert.equal(first.isError, undefined);
  assert.equal(repeated.isError, true);
  assert.match(repeated.text, /每轮 agent 执行只能调用一次/);
  assert.equal(subcommands(h).filter((c) => c === "list").length, 1, "拒绝路径不能再查询 daemon");

  h.tools.resetListAllowance();
  const nextTurn = await h.tools.list();
  assert.equal(nextTurn.isError, undefined);
  assert.equal(subcommands(h).filter((c) => c === "list").length, 2);
});

test("同一轮并发调用 list 也只有一个能碰 daemon", async () => {
  const h = harness({ live: [info("one")] });

  const results = await Promise.all([h.tools.list(), h.tools.list()]);

  assert.equal(results.filter((r) => r.isError !== true).length, 1);
  assert.equal(results.filter((r) => r.isError === true).length, 1);
  assert.equal(subcommands(h).filter((c) => c === "list").length, 1);
});

test("agents 列出存活的并摘掉已经没了的", async () => {
  const h = harness({ live: [info("pi-a", { running: true })] });
  for (const s of ["pi-a", "pi-b"]) {
    h.registry.add({
      session: s,
      task: "t",
      cwd: "/w",
      agent: "pi",
      createdAt: 0,
      createdByUs: true,
    });
  }
  const r = await h.tools.agents();
  assert.match(r.text, /pi-a/);
  // 状态词从 running/idle 改成了 在动/安静：idle 读起来像"闲着=做完了"，
  // 而它只是终端没动静 —— boss 据此断定成败正是"无限重发任务"的来源。
  assert.match(r.text, /在动/);
  assert.match(r.text, /已结束.*pi-b/s);
  assert.deepEqual(h.registry.names(), ["pi-a"]);
});

// I1 回归：AgentRecord 不再记 watching，agents() 必须读 WatcherPool 的活
// 状态。watcher 自然收尾（比如跑满超时，规格要求"不重挂"）只会清 WatcherPool
// 自己的 #running，不会回写台账 —— 旧实现读的是台账里那份从 spawn 时就再
// 没更新过的快照，会一直说"watcher 已挂"，即使早就没人在等了。
test("agents 里的 watcher 状态跟着 WatcherPool 的活状态走，不是台账里那份陈旧快照", async () => {
  const h = harness();
  const spawned = await h.tools.spawn({ task: "t", name: "a" });
  assert.equal(spawned.isError, undefined, spawned.text);
  const session = String(spawned.details?.session);
  // spawn 完之后把它加进假 asd 的 live 列表 —— 不然接下来 agents() 自己那次
  // `asd list` 会发现这个刚建的 session"不存在"，直接把它当成已结束摘掉。
  h.live.push(info(session, { running: false }));
  assert.equal(h.watchers.isWatching(session), true);

  const before = await h.tools.agents();
  assert.match(before.text, / watcher\]/, "刚 spawn 完，watcher 确实挂着");

  // 模拟 watcher 自然收尾（例如跑满超时，规格要求"不重挂"）—— 这只会清
  // WatcherPool 自己的 #running，不经过 tools.ts 的任何函数。
  h.watchers.stop(session);
  assert.equal(h.watchers.isWatching(session), false);

  const after = await h.tools.agents();
  assert.doesNotMatch(after.text, / watcher\]/, "watcher 已经不在跑了，不该再说「watcher 已挂」");
});

test("steer 送消息并重挂 watcher", async () => {
  const h = harness({ live: [info("pi-a")] });
  h.registry.add({
    session: "pi-a",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  const r = await h.tools.steer({ session: "pi-a", message: "换个思路" });
  assert.equal(r.isError, undefined);
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 1, "正常提交只按一次 Enter");
  assert.ok(subcommands(h).filter((c) => c === "peek").length >= 2, "提交前后都必须观察屏幕");
  assert.equal(h.watchers.isWatching("pi-a"), true);
  h.watchers.stopAll();
});

test("steer 拒绝空白消息，不能提交只有内部 proof 的空 turn", async () => {
  const h = harness({ live: [info("pi-a")] });
  h.registry.add({
    session: "pi-a",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const r = await h.tools.steer({ session: "pi-a", message: " \n\t " });
  assert.equal(r.isError, true);
  assert.match(r.text, /message 不能为空/);
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0);
});

test("并发 steer 同一 session 时只有一次可以进入投递状态机", async () => {
  const h = harness({ live: [info("pi-a")] });
  h.registry.add({
    session: "pi-a",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const [r1, r2] = await Promise.all([
    h.tools.steer({ session: "pi-a", message: "消息 A" }),
    h.tools.steer({ session: "pi-a", message: "消息 B" }),
  ]);
  assert.equal([r1, r2].filter((r) => r.isError === undefined).length, 1);
  assert.equal([r1, r2].filter((r) => r.isError === true).length, 1);
  assert.equal(deliveries(h).length, 1, "同一 composer 不能并发写入两份 payload");
  assert.equal(enterKeys(h).length, 1);
  h.watchers.stopAll();
});

test("follow 给现存 session 挂后台 watcher 后立即返回", async () => {
  const h = harness({ live: [info("mem")] });

  const result = await Promise.race([
    h.tools.follow({ session: "mem" }),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]);

  if (result === "blocked") assert.fail("工具调用不能等后台 asd follow 结束");
  assert.equal(result.isError, undefined, result.text);
  assert.match(result.text, /立即返回/);
  assert.match(result.text, /自动推送/);
  assert.deepEqual(result.details, {
    session: "mem",
    watching: true,
    alreadyWatching: false,
  });
  assert.equal(h.watchers.isWatching("mem"), true);
  assert.equal(h.registry.get("mem"), undefined, "后台监视不能让外部 session 进入复用/回收台账");
  assert.deepEqual(subcommands(h), ["list", "follow"]);
  h.watchers.stopAll();
});

test("follow 重复注册同一个 session 时立即返回且不重挂 watcher", async () => {
  const h = harness({ live: [info("mem")] });
  h.watchers.watch("mem");

  const r = await h.tools.follow({ session: "mem" });

  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /已经在后台监视中/);
  assert.deepEqual(r.details, {
    session: "mem",
    watching: true,
    alreadyWatching: true,
  });
  assert.deepEqual(subcommands(h), ["follow"], "重复注册不能再查 daemon 或启动第二个 follow");
  h.watchers.stopAll();
});

test("steer 对台账外的名字直接拒绝，不碰 asd", async () => {
  const h = harness();
  const r = await h.tools.steer({ session: "mem", message: "x" });
  assert.equal(r.isError, true);
  assert.deepEqual(h.calls, []);
});

test("peek 允许读取台账外、由用户显式点名的 session", async () => {
  const h = harness({ live: [info("mem")] });

  const r = await h.tools.peek({ session: "mem" });

  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /^SCREEN:mem/);
  assert.deepEqual(subcommands(h), ["peek"]);
});

test("follow 拒绝不存在的 session，不留下后台 watcher", async () => {
  const h = harness();

  const r = await h.tools.follow({ session: "ghost" });

  assert.equal(r.isError, true);
  assert.match(r.text, /没有叫 "ghost" 的 session/);
  assert.equal(h.watchers.isWatching("ghost"), false);
  assert.deepEqual(subcommands(h), ["list"]);
});

test("peek 返回屏幕内容", async () => {
  const h = harness({ live: [info("pi-a")] });
  h.registry.add({
    session: "pi-a",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  const r = await h.tools.peek({ session: "pi-a" });
  // 假屏幕形如 `SCREEN:<name>\n<最近送进去的文本>`（见 harness 的 peek 分支）
  assert.match(r.text, /^SCREEN:pi-a/);
});

test("kill 放行台账里自己建的", async () => {
  const h = harness();
  h.registry.add({
    session: "pi-a",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  const r = await h.tools.kill({ session: "pi-a" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(subcommands(h), ["kill"]);
  assert.equal(h.registry.size, 0);
});

test("kill 拒绝台账外的名字，并且一次 asd kill 都没发生", async () => {
  const h = harness();
  h.registry.add({
    session: "pi-a",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  const r = await h.tools.kill({ session: "mem" });
  assert.equal(r.isError, true);
  assert.match(r.text, /不是本次|不会 kill/);
  assert.equal(h.calls.length, 0, "拒绝路径上不该有任何 asd 调用");
  assert.ok(!subcommands(h).includes("kill"));
});

test("kill 拒绝 createdByUs 为 false 的记录，并且一次 asd kill 都没发生", async () => {
  const h = harness();
  h.registry.add({
    session: "pi-borrowed",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: false,
  });
  const r = await h.tools.kill({ session: "pi-borrowed" });
  assert.equal(r.isError, true);
  assert.match(r.text, /不是 pi-asd 新建/);
  assert.equal(h.calls.length, 0, "拒绝路径上不该有任何 asd 调用");
  assert.equal(h.registry.size, 1, "被拒绝的记录不该被摘掉");
});

test("agentOfCommand 从前台进程认出 agent，认不出裸 shell", () => {
  const p = { pi: { command: (t: string) => `pi ${t}`, piChild: true } };
  assert.equal(agentOfCommand("pi", p), "pi");
  assert.equal(agentOfCommand("/usr/local/bin/pi --resume", p), "pi");
  assert.equal(agentOfCommand("bash", p), undefined);
  assert.equal(agentOfCommand("sh -c 'echo hi'", p), undefined);
  assert.equal(agentOfCommand("", p), undefined);
});

// 回归：codex 全军漏出 asd_candidates / 交不了任务。两条真实的前缀，实测数据：
//
//   token（用户手起的 codex）：node /root/.nvm/versions/node/v24.16.0/bin/codex
//   review（pi-asd 自己 spawn 的 codex）：
//     HTTPS_PROXY='…' IS_SANDBOX='1' … codex '长期 codex 员工…'
//
// 只看第一个 token 的老实现分别拿到 "node" 和 "31172'"（`HTTPS_PROXY='http://…:31172'`
// 被 `split("/").pop()` 切成了这样），两个都不在 PRESETS 里 → 一律当裸 shell 拒掉。
test("agentOfCommand 跳过环境变量前缀", () => {
  const p = { codex: { command: (t: string) => `codex ${t}`, piChild: false } };
  assert.equal(agentOfCommand("IS_SANDBOX='1' codex '干活'", p), "codex");
  // 值里带 `/` —— 老实现正是栽在这里（basename 取到了端口号）
  assert.equal(agentOfCommand("HTTPS_PROXY='http://h:31172' codex", p), "codex");
  // 值里带空格：按空白切会把它切成两半，必须认引号
  assert.equal(agentOfCommand("A='x y' B=2 codex", p), "codex");
  // pi 预设自己就会拼出 PI_SPAWNED= 前缀
  assert.equal(agentOfCommand("PI_SPAWNED=1 PI_PARENT_SESSION='s' codex", p), "codex");
  // 剥掉前缀之后还是裸 shell 的，照旧拒绝
  assert.equal(agentOfCommand("IS_SANDBOX='1' bash", p), undefined);
  assert.equal(agentOfCommand("A=1 B=2", p), undefined);
});

test("agentOfCommand 认得出解释器起的 agent", () => {
  const p = { codex: { command: (t: string) => `codex ${t}`, piChild: false } };
  assert.equal(agentOfCommand("node /root/.nvm/versions/node/v24.16.0/bin/codex", p), "codex");
  assert.equal(agentOfCommand("node --enable-source-maps /usr/lib/codex", p), "codex");
  assert.equal(agentOfCommand("node /opt/codex.mjs --resume", p), "codex");
  assert.equal(agentOfCommand("IS_SANDBOX='1' node /usr/lib/codex", p), "codex");
  // 解释器跑的不是认识的 agent —— 还是不认
  assert.equal(agentOfCommand("node /usr/lib/webpack", p), undefined);
  assert.equal(agentOfCommand("node", p), undefined);
  // 只剥一层：解释器后面又是个 shell，绝不能顺着往下找
  assert.equal(agentOfCommand("node /usr/lib/foo codex", p), undefined);
});

test("candidates 只留空闲、能认出 agent、且有 card 的", async () => {
  const h = harness({
    live: [
      info("busy", { running: true, command: "claude --dangerously-skip-permissions" }),
      info("shell", { running: false, command: "bash", idle_ms: 9_000 }),
      info("nocard", { running: false, command: "claude", idle_ms: 9_000 }),
      info("good", { running: false, command: "claude --dangerously-skip-permissions", idle_ms: 100 }),
    ],
    cards: [card("busy", "/w"), card("shell", "/w"), card("good", "/w/proj", ["README.md"])],
  });
  const r = await h.tools.candidates({});
  assert.match(r.text, /good/);
  assert.doesNotMatch(r.text, /busy/);
  assert.doesNotMatch(r.text, /shell/);
  assert.doesNotMatch(r.text, /nocard/);
  assert.match(r.text, /\/w\/proj/);
  assert.match(r.text, /README\.md/);
});

test("candidates 按闲得最久排在前面", async () => {
  const h = harness({
    live: [
      info("short", { running: false, command: "claude", idle_ms: 1_000 }),
      info("long", { running: false, command: "claude", idle_ms: 90_000 }),
    ],
    cards: [card("short", "/w"), card("long", "/w")],
  });
  const r = await h.tools.candidates({});
  assert.ok(r.text.indexOf("long") < r.text.indexOf("short"), "闲最久的应当排在前面");
});

test("candidates 的 cwd 过滤是精确匹配", async () => {
  const h = harness({
    live: [
      info("here", { running: false, command: "claude" }),
      info("there", { running: false, command: "claude" }),
    ],
    cards: [card("here", "/w/a"), card("there", "/w/b")],
  });
  const r = await h.tools.candidates({ cwd: "/w/a" });
  assert.match(r.text, /here/);
  assert.doesNotMatch(r.text, /there/);
});

test("candidates 标出哪些不是本 boss 建的", async () => {
  const h = harness({
    live: [info("mine", { running: false, command: "claude" })],
    cards: [card("mine", "/w")],
  });
  h.registry.add({
    session: "mine",
    task: "t",
    cwd: "/w",
    agent: "claude",
    createdAt: 0,
    createdByUs: true,
  });
  const own = await h.tools.candidates({});
  assert.doesNotMatch(own.text, /不能 kill/);

  const h2 = harness({
    live: [info("theirs", { running: false, command: "claude" })],
    cards: [card("theirs", "/w")],
  });
  const foreign = await h2.tools.candidates({});
  assert.match(foreign.text, /不能 kill/);
});

test("candidates 里已经指名交过任务的 session（在台账里但 createdByUs=false）仍然标不能 kill", async () => {
  const h = harness({
    live: [info("mem", { running: false, command: "claude" })],
    cards: [card("mem", "/w/mem")],
  });
  // 模拟"已经被指名交过一次任务"：在台账里，但不是我们建的。
  h.registry.add({
    session: "mem",
    task: "上一轮的任务",
    cwd: "/w/mem",
    agent: "claude",
    createdAt: 0,
    createdByUs: false,
  });
  const r = await h.tools.candidates({});
  assert.match(r.text, /不能 kill/, "mine 的判据必须是 createdByUs，不是「在不在台账里」");
});

test("candidates 一个都没有时明确说明", async () => {
  const h = harness();
  const r = await h.tools.candidates({});
  assert.match(r.text, /没有/);
});

test("spawn 指名交给：送任务、以 createdByUs=false 记账、挂 watcher", async () => {
  const h = harness({
    live: [info("mem", { running: false, command: "claude --dangerously-skip-permissions" })],
    cards: [card("mem", "/w/mem", ["README.md"])],
  });
  const r = await h.tools.spawn({ task: "查一下这个", session: "mem" });
  assert.equal(r.isError, undefined, r.text);
  assert.ok(subcommands(h).includes("send"));
  assert.ok(!subcommands(h).includes("new"), "指名交给不该新建 session");
  const rec = h.registry.get("mem");
  assert.equal(rec?.createdByUs, false);
  assert.equal(rec?.agent, "claude");
  assert.equal(rec?.cwd, "/w/mem");
  assert.match(r.text, /关不掉它|不是 pi-asd 自己创建的/);
  assert.equal(h.watchers.isWatching("mem"), true);
  h.watchers.stopAll();
});

test("spawn 拒绝把任务交给正在干活的 session，且不发送任何东西", async () => {
  const h = harness({
    live: [info("busy", { running: true, command: "claude" })],
    cards: [card("busy", "/w")],
  });
  const r = await h.tools.spawn({ task: "t", session: "busy" });
  assert.equal(r.isError, true);
  assert.ok(!subcommands(h).includes("send"));
  assert.equal(h.registry.size, 0);
});

test("spawn 拒绝把任务交给裸 shell —— 任务描述会被当命令执行", async () => {
  const h = harness({
    live: [info("shell", { running: false, command: "bash" })],
    cards: [card("shell", "/w")],
  });
  const r = await h.tools.spawn({ task: "rm 掉旧日志", session: "shell" });
  assert.equal(r.isError, true);
  assert.match(r.text, /bash/);
  assert.ok(!subcommands(h).includes("send"), "拒绝路径上绝不能 send");
  assert.equal(h.registry.size, 0);
});

test("spawn 拒绝把任务交给 asd 里不存在的 session", async () => {
  const h = harness();
  const r = await h.tools.spawn({ task: "t", session: "ghost" });
  assert.equal(r.isError, true);
  assert.ok(!subcommands(h).includes("send"));
  assert.ok(!subcommands(h).includes("new"), "名字不存在时绝不能顺手新建一个");
  assert.equal(h.registry.size, 0);
});

// 名字不存在时，模型最容易自作主张：改派给一个看起来差不多的 session，或者
// 拿这个名字新建一个 —— 两种用户都会以为任务进了它点名的那个会话。报错里必须
// 把"别改派、别新建、去问用户"说死，光说"没找到"挡不住模型自己往下走。
test("不存在的 session：报错要指明别改派、别新建、去问用户", async () => {
  const h = harness();
  const r = await h.tools.spawn({ task: "t", session: "ghost" });
  assert.match(r.text, /ghost/, "要点出是哪个名字没找到");
  assert.match(r.text, /别改派给别的/);
  assert.match(r.text, /别拿这个名字新建/);
  assert.match(r.text, /asd_candidates/, "要指路到 candidates");
  assert.match(r.text, /让它来定|告诉用户/, "要把决定权交回用户");
});

test("正在干活的 session：报错要把决定权交回用户，而不是建议自己另开", async () => {
  const h = harness({
    live: [info("busy", { running: true, command: "claude" })],
    cards: [card("busy", "/w")],
  });
  const r = await h.tools.spawn({ task: "t", session: "busy" });
  assert.match(r.text, /不会打断它/);
  assert.match(r.text, /告诉用户/);
  assert.match(r.text, /让它决定/);
  assert.ok(!subcommands(h).includes("new"), "目标正忙时也不能顺手新建");
});

// M5：代码层面兜底，不能把任务交给 boss 自己所在的 session。提示词里也这么说，但
// 那只是"建议"——config.bossSession 是 index.ts 从 $ASD_SESSION 读出来注入
// 的，tools.ts 自己不读 process.env（保持依赖注入边界）。
test("spawn 拒绝把任务交给 boss 自己所在的 session，且完全不碰 asd", async () => {
  const h = harness({
    bossSession: "boss-self",
    live: [info("boss-self", { running: false, command: "claude" })],
    cards: [card("boss-self", "/w")],
  });
  const r = await h.tools.spawn({ task: "t", session: "boss-self" });
  assert.equal(r.isError, true);
  assert.match(r.text, /不能把任务交给自己/);
  assert.deepEqual(h.calls, [], "拒绝路径上不该有任何 asd 调用");
  assert.equal(h.registry.size, 0);
});

test("指名交过任务的 session 永远不能被 kill —— 守卫承重", async () => {
  const h = harness({
    live: [info("mem", { running: false, command: "claude" })],
    cards: [card("mem", "/w/mem")],
  });
  await h.tools.spawn({ task: "t", session: "mem", watch: false });
  assert.equal(h.registry.get("mem")?.createdByUs, false);

  const before = h.calls.length;
  const r = await h.tools.kill({ session: "mem" });
  assert.equal(r.isError, true);
  assert.match(r.text, /不是 pi-asd 新建/);
  assert.equal(h.calls.length, before, "kill 拒绝路径上不该有任何新的 asd 调用");
  assert.equal(h.registry.size, 1, "被拒绝的记录不该被摘掉");
});

test("并发指名交给同一个 session：只有一次真正送达，另一次被屏障挡下", async () => {
  const h = harness({
    live: [info("mem", { running: false, command: "claude --dangerously-skip-permissions" })],
    cards: [card("mem", "/w/mem")],
  });

  // 屏障必须在第一次 await 之前同步占住，顺序 await 两次测不出这条缝隙 ——
  // 必须用 Promise.all 真并发触发。
  const [r1, r2] = await Promise.all([
    h.tools.spawn({ task: "任务A", session: "mem" }),
    h.tools.spawn({ task: "任务B", session: "mem" }),
  ]);

  const results = [r1, r2];
  const ok = results.filter((r) => r.isError === undefined);
  const rejected = results.filter((r) => r.isError === true);
  assert.equal(ok.length, 1, "两次并发把任务交给同一个 session，只能有一次真正成功");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].text, /正在被另一次 spawn 处理/);
  assert.equal(
    deliveries(h).length,
    1,
    "只应该真正送达一次 —— 不能把两段不相关的任务文本都敲进目标 session",
  );
  h.watchers.stopAll();
});

test("指名 spawn 与 steer 并发写同一 session 时共享同一输入预留", async () => {
  const h = harness({
    live: [info("mem", { running: false, command: "claude" })],
    cards: [card("mem", "/w/mem")],
  });
  h.registry.add({
    session: "mem",
    task: "旧任务",
    cwd: "/w/mem",
    agent: "claude",
    createdAt: 0,
    createdByUs: false,
  });

  const [steered, spawned] = await Promise.all([
    h.tools.steer({ session: "mem", message: "补充要求" }),
    h.tools.spawn({ task: "新任务", session: "mem", watch: false }),
  ]);
  assert.equal([spawned, steered].filter((r) => r.isError === undefined).length, 1);
  const rejected = [spawned, steered].filter((r) => r.isError === true);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.text, /正在被另一次.*处理/, "必须由共享输入预留在写正文前拒绝");
  assert.equal(deliveries(h).length, 1, "spawn 和 steer 也不能把两份正文合成一个 turn");
  assert.equal(enterKeys(h).length, 1);
  h.watchers.stopAll();
});

test("指名交给的早退路径（目标正忙）之后，预留会被释放，下一次仍能真正送达", async () => {
  const h = harness({
    live: [info("busy", { running: true, command: "claude" })],
    cards: [card("busy", "/w")],
  });
  const r1 = await h.tools.spawn({ task: "t1", session: "busy" });
  assert.equal(r1.isError, true);
  assert.ok(!subcommands(h).includes("send"));

  // 它后来空下来了。
  h.live[0].running = false;
  const r2 = await h.tools.spawn({ task: "t2", session: "busy" });
  assert.equal(r2.isError, undefined, r2.text);
  assert.ok(
    subcommands(h).includes("send"),
    "如果预留没释放，第二次会被「正在被另一次 spawn 处理」挡住，走不到 send",
  );
  h.watchers.stopAll();
});

// --- 并发 spawn ---
//
// pi 的并发工具执行模型下，同一条助手消息里的多个 `asd_spawn` 是并发跑的，
// boss mode 的提示词又鼓励"拆成独立子任务立刻 spawn"，所以并发 spawn 是主
// 路径而不是边角情况。下面三个测试必须用 `Promise.all` 真并发触发，顺序
// await 两次测不出 `await asd.list()` 之后、`asd.send`/`asd.create` 之前
// 那段 await 间隙里的竞态。

test("并发 spawn 抢同一个空闲 agent：只有一个复用，另一个新建，落在两个不同的 session 上", async () => {
  const h = raceHarness({ live: [info("pi-agent1", { running: false, idle_ms: 9_000 })] });
  h.registry.add({
    session: "pi-agent1",
    task: "旧",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const [r1, r2] = await Promise.all([
    h.tools.spawn({ task: "任务A" }),
    h.tools.spawn({ task: "任务B" }),
  ]);

  const subs = subcommands(h);
  assert.equal(deliveries(h).length, 1, "应该恰好一次复用（一次送达）");
  assert.equal(subs.filter((c) => c === "new").length, 1, "应该恰好一次新建（new）");
  const sessions = [r1, r2].map((r) => r.details?.session);
  assert.equal(new Set(sessions).size, 2, "两次 spawn 不能落在同一个 session 上");
  h.watchers.stopAll();
});

test("并发 spawn 都显式传同一个 name：拿到两个不同的 session 名，不会对同一个名字发两次 asd new", async () => {
  const h = raceHarness();

  const [r1, r2] = await Promise.all([
    h.tools.spawn({ task: "任务A", name: "x" }),
    h.tools.spawn({ task: "任务B", name: "x" }),
  ]);

  const newCalls = h.calls.filter((c) => c[0] === "new");
  assert.equal(newCalls.length, 2, "台账里没有可复用的，两次都该走新建");
  const newNames = newCalls.map((c) => c[1]);
  assert.equal(new Set(newNames).size, 2, "不能对同一个名字发两次 asd new");
  const sessions = [r1, r2].map((r) => r.details?.session);
  assert.equal(new Set(sessions).size, 2, "两次 spawn 必须拿到两个不同的 session 名");
  assert.ok(sessions.includes("pi-x"));
  h.watchers.stopAll();
});

// M7：新建路径上 `reserved` 必须同时占住 `allocateName` 算出的候选名字，
// 以及 `asd new` 实际回显的 session 名 —— 如果两者不一致（asd 自己也做了
// 避重/改写），只占前者会在两者之间露出一条缝隙，让屏障守错键。这里直接
// 断言：请求名字和回显名字不同时，registry 落账用的是回显值，且这次 spawn
// 完成后两个名字都不再占着 reserved（不会永久卡住）。
test("spawn 新建时请求的名字和 asd 回显的名字不一致，registry 记的是回显值", async () => {
  const h = harness({ newEchoes: "pi-echoed-different" });
  const r = await h.tools.spawn({ task: "t", name: "requested" });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(r.details?.session, "pi-echoed-different");
  assert.deepEqual(h.registry.names(), ["pi-echoed-different"]);
  assert.equal(h.registry.get("pi-requested"), undefined);
  h.watchers.stopAll();
});

test("spawn 抛异常时预留会被释放，下一次还能拿到同一个名字", async () => {
  const calls: string[][] = [];
  let newAttempts = 0;
  /** session → 最近一次 --text 送进去的内容，供假 peek 回显。 */
  const typed = new Map<string, string>();
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
    switch (args[0]) {
      case "list":
        return ok(JSON.stringify([]));
      case "new":
        newAttempts += 1;
        // 第一次 asd new 故意失败，逼 spawn() 抛异常。
        return newAttempts === 1 ? { stdout: "", stderr: "boom", code: 1 } : ok(`${args[1]}\n`);
      case "peek":
        // 投递校验会 peek 确认文本进了输入框 —— 假屏幕必须模拟这个行为，
        // 否则每一次 deliver() 都会判成"没投进去"。
        return ok(peekStdout(args, `SCREEN:${args[1]}\n› ${typed.get(args[1]!) ?? ""}`));
      case "send":
        if (args[2] === "--text") typed.set(args[1]!, args[3] ?? "");
        return ok();
      case "rename":
        return ok(`${args[2]}\n`);
      case "kill":
        return ok();
      case "follow":
        return new Promise<ExecResult>(() => {});
      default:
        throw new Error(`没准备好的子命令：${args.join(" ")}`);
    }
  };

  // enterDelayMs: 0 —— send 现在分两次发（正文、Enter），单测不该真睡 300ms
  const asd = createAsd(exec, { enterDelayMs: 0 });
  const registry = new Registry("pi-");
  const watchers = new WatcherPool({ asd, notify: () => {}, timeout: "30m", now: () => 0 });
  const tools = createTools({
    asd,
    registry,
    watchers,
    config: {
      defaultAgent: "pi",
      workspaceBase: "/base",
      followTimeout: "30m",
      parentSession: "/s.jsonl",
      reuseMinIdleMs: 0,
    },
    mkdirp: async () => {},
    now: () => 0,
  });

  await assert.rejects(() => tools.spawn({ task: "t1", name: "x" }));
  const r2 = await tools.spawn({ task: "t2", name: "x" });
  assert.equal(r2.isError, undefined);
  assert.equal(
    r2.details?.session,
    "pi-x",
    "第一次失败必须放行预留，第二次才能仍然拿到同一个名字（证明 finally 生效）",
  );
  watchers.stopAll();
});

test("resolveAgentArg 空参数回到基线，不沿用上一次", () => {
  const p = { pi: { command: (t: string) => `pi ${t}`, piChild: true } };
  assert.deepEqual(resolveAgentArg("", "pi", p), { ok: true, agent: "pi" });
  assert.deepEqual(resolveAgentArg("   ", "pi", p), { ok: true, agent: "pi" });
});

test("resolveAgentArg 认得出预设表里的名字，并去掉首尾空白", () => {
  const p = {
    pi: { command: (t: string) => `pi ${t}`, piChild: true },
    claude: { command: (t: string) => `claude ${t}`, piChild: false },
  };
  assert.deepEqual(resolveAgentArg("claude", "pi", p), { ok: true, agent: "claude" });
  assert.deepEqual(resolveAgentArg("  claude  ", "pi", p), { ok: true, agent: "claude" });
});

test("resolveAgentArg 拒绝不认识的名字并列出可选项", () => {
  const p = {
    pi: { command: (t: string) => `pi ${t}`, piChild: true },
    claude: { command: (t: string) => `claude ${t}`, piChild: false },
  };
  const r = resolveAgentArg("gemini", "pi", p);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.message : "", /gemini/);
  assert.match(r.ok === false ? r.message : "", /pi/);
  assert.match(r.ok === false ? r.message : "", /claude/);
});

test("parseBossDefault 未设置 / 空串 / 纯空白都是关闭，且都算「没设置」", () => {
  assert.deepEqual(parseBossDefault(undefined), { enabled: false, configured: false });
  assert.deepEqual(parseBossDefault(""), { enabled: false, configured: false });
  assert.deepEqual(parseBossDefault("   "), { enabled: false, configured: false });
});

test("parseBossDefault 认这四个真值，且忽略大小写和首尾空白", () => {
  for (const v of ["1", "true", "on", "yes", "TRUE", "On", " yes "]) {
    assert.equal(parseBossDefault(v).enabled, true, `${v} 应当是开启`);
    assert.equal(parseBossDefault(v).configured, true, `${v} 应当算设置过`);
  }
});

test("parseBossDefault 认这些假值", () => {
  for (const v of ["0", "false", "off", "no", "FALSE"]) {
    assert.deepEqual(parseBossDefault(v), { enabled: false, configured: true }, `${v} 应当是关闭`);
  }
});

test("parseBossDefault 对认不出的值关闭，但把原值带出来供提醒", () => {
  const r = parseBossDefault("enable");
  assert.equal(r.enabled, false);
  assert.equal(r.unrecognized, "enable");
});

/**
 * 回归：`PI_ASD_BOSS=`（空串）曾经会把配置文件里的 `bossMode.autoStart` 无声压掉。
 *
 * 起因是 index.ts 用 `process.env.PI_ASD_BOSS !== undefined` 判断"用户设了没"，
 * 而空串是 `""` 不是 `undefined` —— 判断通过，于是走 env 分支拿到 enabled=false，
 * 配置文件根本没机会生效。`configured` 就是为了让调用方问对这个问题。
 */
test("回归：空串不算「设置过」——配置文件的 autoStart 必须还能生效", () => {
  // 这三个值都来自现实：.env 里的空行、`docker -e PI_ASD_BOSS=`、没展开的 shell 变量
  for (const raw of ["", "   ", undefined]) {
    const d = parseBossDefault(raw);
    assert.equal(d.configured, false, `${JSON.stringify(raw)} 不该算设置过`);

    // 模拟 index.ts 的取值：configured 为假时必须回落到配置文件
    const fromConfigFile = true;
    const bossMode = d.configured ? d.enabled : fromConfigFile;
    assert.equal(bossMode, true, `${JSON.stringify(raw)} 时配置文件的 autoStart 应当生效`);
  }
});

test("回归：认不出的值算「设置过」——强制关闭，不让配置文件在背后打开它", () => {
  // 这条路径会弹"boss mode 保持关闭"的提醒，配置文件若能把它打开，那句提醒就成了谎话
  const d = parseBossDefault("enable");
  assert.equal(d.configured, true);
  const bossMode = d.configured ? d.enabled : true;
  assert.equal(bossMode, false, "认不出的值必须压过配置文件，保持关闭");
});

test("显式假值也算「设置过」——env 关掉时配置文件不能把它打开", () => {
  const d = parseBossDefault("0");
  assert.equal(d.configured, true);
  const bossMode = d.configured ? d.enabled : true;
  assert.equal(bossMode, false, "PI_ASD_BOSS=0 必须压过配置文件的 autoStart");
});

test("bossStartMessage 三种情况分得清", () => {
  // 原本关着 —— 这是"打开了"
  const opened = bossStartMessage({ wasOn: false, from: "pi", to: "pi" });
  assert.match(opened, /已打开/);
  assert.match(opened, /pi/);

  // 原本就开着、agent 没变 —— 不能说"设为"，那暗示发生了改变
  const noop = bossStartMessage({ wasOn: true, from: "pi", to: "pi" });
  assert.match(noop, /已经开着/);
  assert.match(noop, /仍是 pi/);
  assert.doesNotMatch(noop, /设为/);

  // 原本就开着、agent 换了 —— 要把前后都说清楚
  const switched = bossStartMessage({ wasOn: true, from: "claude", to: "pi" });
  assert.match(switched, /已经开着/);
  assert.match(switched, /claude/);
  assert.match(switched, /pi/);
});

// --- 静默门槛（REUSE_MIN_IDLE_MS）---
//
// 实测 asd 0.1.9：`running`（和 `status`）恒等于"idle_ms 小于约 2 秒"，是
// "终端最近有动静"，**不是"进程在执行"**。一个跑着 `sleep 8` 的 session 在
// 第 3.7 秒报的就是 running:false / status:idle。所以只看 running 的话，一个
// 沉默思考了两秒多的 agent 会被当成空闲：被自动复用、或者被列进 candidates，
// 任务直接 send 进去打断它。
//
// 上面那一组测试把门槛设成 0（它们测的是判定逻辑本身），这一节用真实默认值。

test("looksIdle 要求连续静默够久，不只看 running", () => {
  // running=true：终端刚有动静，明确排除
  assert.equal(looksIdle(info("a", { running: true, idle_ms: 500 })), false);
  // running=false 但只静了 3 秒 —— 正是 `sleep 8` 跑到一半的样子，必须排除
  assert.equal(looksIdle(info("a", { running: false, idle_ms: 3_000 })), false);
  assert.equal(looksIdle(info("a", { running: false, idle_ms: REUSE_MIN_IDLE_MS - 1 })), false);
  // 到点了
  assert.equal(looksIdle(info("a", { running: false, idle_ms: REUSE_MIN_IDLE_MS })), true);
  assert.equal(looksIdle(info("a", { running: false, idle_ms: 600_000 })), true);
});

test("looksIdle 的门槛可以覆盖 —— 但覆盖成 0 就退回旧的「只看 running」", () => {
  assert.equal(looksIdle(info("a", { running: false, idle_ms: 0 }), 0), true);
  assert.equal(looksIdle(info("a", { running: true, idle_ms: 0 }), 0), false);
});

test("回归：只静默了几秒的自家 agent 不会被自动复用，走新建", async () => {
  // 默认门槛（15s），agent 只静了 3 秒 —— 可能还在沉默地跑命令
  const h = harness({ reuseMinIdleMs: REUSE_MIN_IDLE_MS, live: [info("pi-agent1", { idle_ms: 3_000 })] });
  h.registry.add({
    session: "pi-agent1",
    task: "上一个任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const r = await h.tools.spawn({ task: "新任务" });
  assert.ok(subcommands(h).includes("new"), "静默不够久就必须新建，不能复用");
  assert.ok(!subcommands(h).includes("send"), "绝不能把任务 send 进可能还在干活的 agent");
  assert.equal(h.registry.get("pi-agent1")?.task, "上一个任务", "原任务不该被覆盖");
  assert.doesNotMatch(r.text, /复用/);
  h.watchers.stopAll();
});

test("静默够久的自家 agent 照常复用 —— 门槛不该把功能整个废掉", async () => {
  const h = harness({ reuseMinIdleMs: REUSE_MIN_IDLE_MS, live: [info("pi-agent1", { idle_ms: 60_000 })] });
  h.registry.add({
    session: "pi-agent1",
    task: "上一个任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const r = await h.tools.spawn({ task: "新任务" });
  assert.match(r.text, /复用/);
  assert.ok(!subcommands(h).includes("new"));
  h.watchers.stopAll();
});

test("回归：只静默了几秒的 session 不进 candidates 列表", async () => {
  const h = harness({
    reuseMinIdleMs: REUSE_MIN_IDLE_MS,
    live: [
      info("thinking", { command: "claude", idle_ms: 3_000 }),
      info("really-idle", { command: "claude", idle_ms: 60_000 }),
    ],
    cards: [card("thinking", "/w/a"), card("really-idle", "/w/b")],
  });
  const r = await h.tools.candidates({});
  assert.doesNotMatch(r.text, /thinking/, "静默不够久的不能列成候选，boss 一交任务就打断它");
  assert.match(r.text, /really-idle/);
});

test("回归：指名交给只静默了几秒的 session 会被拒绝，且说清为什么", async () => {
  const h = harness({
    reuseMinIdleMs: REUSE_MIN_IDLE_MS,
    live: [info("mem", { command: "claude", idle_ms: 3_000 })],
    cards: [card("mem", "/w/mem")],
  });
  const r = await h.tools.spawn({ task: "t", session: "mem" });
  assert.equal(r.isError, true);
  assert.ok(!subcommands(h).includes("send"), "拒绝路径上绝不能 send");
  assert.match(r.text, /才安静了/);
  assert.match(r.text, /看不出是等输入还是在沉默地跑命令/);
  assert.match(r.text, /告诉用户/, "决定权交回用户");
  assert.equal(h.registry.size, 0);
});

test("running=true 的目标仍然报「正在干活」，两种情况文案分得开", async () => {
  const h = harness({
    reuseMinIdleMs: REUSE_MIN_IDLE_MS,
    live: [info("busy", { command: "claude", running: true, idle_ms: 500 })],
    cards: [card("busy", "/w")],
  });
  const r = await h.tools.spawn({ task: "t", session: "busy" });
  assert.equal(r.isError, true);
  assert.match(r.text, /正在干活/);
  assert.doesNotMatch(r.text, /才安静了/);
});

// --- 投递校验 + 启动期对话框 ---
//
// 两条都是在修同一个病：**发射后不管**。
// `asd send` 返回 true 只代表 asd 把字节排进了 session 的队列（daemon 是
// `let _ = tx.send(...)` 之后无条件 Ack），既不代表 agent 收到、更不代表它开始
// 干活。pi-asd 以前拿它当"已送达"，于是任务丢了也照报「已派出 xxx」。

test("screenHasText 归一化空白再比 —— TUI 会折行/缩进", () => {
  assert.equal(screenHasText("│ 查一下今天的\n│ 新闻，写三条", "查一下今天的新闻，写三条"), true);
  assert.equal(screenHasText("  查 一 下 今 天 的 新 闻 ，写三条  ", "查一下今天的新闻，写三条"), true);
  assert.equal(screenHasText("完全不相干的屏幕内容", "查一下今天的新闻"), false);
});

/**
 * 长任务只按开头一段做特征：拿整段去比，输入框一旦折行/截断就必然假阴性，
 * 而假阴性会把一次成功的投递误报成"未投递成功"。代价是特征那段必须完整出现 ——
 * 屏幕上连开头都看不全时仍然判为没投进去，这是有意的保守。
 */
test("screenHasText 只按开头一段做特征，长任务不要求整段都在屏幕上", () => {
  const long = "查一下今天的新闻，然后" + "补".repeat(500);
  const head = "查一下今天的新闻，然后" + "补".repeat(20); // 覆盖得住特征长度

  assert.equal(screenHasText(`│ ${head} …`, long), true, "开头够长就算命中，不要求整段 500 字都在");
  assert.equal(screenHasText("│ 查一下今天 …", long), false, "只露出几个字不算 —— 宁可保守");
});

test("screenHasText 空文本不算命中 —— 免得空串到处 includes 成真", () => {
  assert.equal(screenHasText("随便什么", ""), false);
  assert.equal(screenHasText("随便什么", "   "), false);
});

/**
 * 核心回归：asd 已 ACK、但文本没出现在屏幕上时必须**如实报不确定**，而且
 * **绝不能按回车**。ACK 只证明 daemon 排过队，不能据此断言任务一定没进去；
 * 所以这属于 submit 未知态，不能自动改派。
 */
test("回归：ACK 后文本没出现在屏幕上 → submit 报错、不记台账、不按回车", async () => {
  const h = harness({
    live: [info("mem", { command: "claude", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    // 屏幕永远回显不出送进去的文本 —— 模拟"文本被别的 UI 吃了"
    swallowText: true,
  });
  const r = await h.tools.spawn({ task: "查一下新闻", session: "mem" });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit", "ACK 后没回显仍不能证明正文没进 PTY");
  assert.match(r.text, /任务未投递成功/);
  assert.match(r.text, /没有出现在/);
  assert.equal(h.registry.size, 0, "没投进去就不能记台账 —— 记了就等于宣称已派出");
  assert.equal(enterKeys(h).length, 0, "校验没过就绝不能按回车");
});

test("ACK 后正文从未回显却出现无关对话框时不授予外部 session 控制权", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    echoScreens: ["❯ 1. Allow unrelated action\n  2. Cancel\n Enter to confirm · Esc to cancel"],
    swallowText: true,
  });

  const r = await h.tools.spawn({ task: "检查安全边界", session: "mem" });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(h.registry.size, 0, "没有正文屏幕证据时不能把外部 session 纳入台账");
  assert.equal(h.watchers.isWatching("mem"), false, "不能为无关对话框启动 watcher");
  assert.equal(enterKeys(h).length, 0, "无关对话框上绝不能发送 Enter");
});

test("发送前已有模态框属于 text 失败，正文和 Enter 都不能发送", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    stuckOnDialog: true,
  });

  const r = await h.tools.spawn({ task: "查一下新闻", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0);
});

test("composer 已有旧草稿时新任务被追加也不能按 Enter", async () => {
  const head = "任务正文里的提示符不能冒充真正输入框".repeat(2);
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› OLD-DRAFT:",
  });

  const r = await h.tools.spawn({ task: `${head}\n› ${head}`, session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text", "发送前已确认旧草稿存在，任务正文根本不应写入");
  assert.equal(deliveries(h).length, 0, "不能先追加正文再判断 composer 是否干净");
  assert.equal(enterKeys(h).length, 0, "否则会把用户旧草稿和新任务拼在一起提交");
});

test("多行旧草稿末行恰好是空提示符时不能冒充新 composer", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "> OLD-DRAFT\n> ",
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "连续的上一行仍是草稿内容，不能发送正文");
  assert.equal(enterKeys(h).length, 0);
});

for (const marker of ["›", "❯"]) {
  test(`多行旧草稿末行是空 ${marker} 时同样不能冒充新 composer`, async () => {
    const h = harness({
      live: [info("mem", { command: "codex", idle_ms: 60_000 })],
      cards: [card("mem", "/w/mem")],
      screenPrefix: `${marker} OLD-DRAFT\n  ${marker} `,
    });

    const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
    assert.equal(r.isError, true);
    assert.equal(r.details?.phase, "text");
    assert.equal(deliveries(h).length, 0, "prompt 字形不能作为跳过旧草稿检查的特权");
    assert.equal(enterKeys(h).length, 0);
  });
}

test("多行旧草稿以普通续行和空光标行结尾时也不能发送正文", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› OLD-DRAFT\ncontinued draft\n",
  });

  const r = await h.tools.spawn({ task: "> 执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "空 continuation 上方仍属于同一个旧 composer");
  assert.equal(enterKeys(h).length, 0);
});

test("多行旧草稿内部有空行时不能把末尾空光标误认成新 composer", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› OLD-DRAFT first paragraph\n\ncontinued draft\n",
  });

  const r = await h.tools.spawn({ task: "> 执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "草稿内部空行不是 composer 生命周期边界，正文都不能追加");
  assert.equal(enterKeys(h).length, 0);
});

test("多行旧草稿内部有纯边框 continuation 时也不能发送正文", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› OLD-DRAFT first paragraph\n│\ncontinued draft\n",
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "纯边框行也可能是草稿内容，不能当作可靠分隔");
  assert.equal(enterKeys(h).length, 0);
});

test("composer 里只有 Markdown 引用符也不是空输入", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› >",
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "文本指纹会忽略 >，但 composer 判空绝不能忽略用户输入");
  assert.equal(enterKeys(h).length, 0);
});

test("无提示符输入行已有旧草稿时 shell fallback 也不能按 Enter", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "OLD-DRAFT:",
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0, "plain fallback 只能从空输入行开始，不能提交旧草稿");
});

test("无提示符多行旧草稿以空 continuation 结尾时正文也不能写入", async () => {
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "OLD-DRAFT first line\ncontinued draft\n",
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "空光标行不足以证明 pi 的无 prompt 输入框为空");
  assert.equal(enterKeys(h).length, 0);
});

test("pi 横线框内已有多行旧草稿时，即使光标行为空也不能写入", async () => {
  const frame = "─".repeat(80);
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: `HISTORY\n${frame}\nOLD-DRAFT first line\ncontinued draft\n\n${frame}\nstatus`,
      cursor: { row: 4, col: 0 },
      cols: 80,
    },
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "必须检查上下框之间的整个输入区，不能只看 cursor 行");
  assert.equal(enterKeys(h).length, 0);
});

test("Codex 光标右侧还有旧草稿时不能把 placeholder 规则用于可编辑正文", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: "› OLD-DRAFT\n\n  gpt-5.6-sol · Context 0% used",
      cursor: { row: 0, col: 2 },
      cols: 80,
    },
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "光标左边虽为空，右边旧草稿仍属于同一输入框");
  assert.equal(enterKeys(h).length, 0);
});

test("Codex 光标下方还有多行旧草稿时发送前必须检查整个 composer", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: "› \n  OLD-DRAFT below cursor\n\n  tab to queue message            100% context left",
      cursor: { row: 0, col: 2 },
      cols: 80,
    },
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "cursor 之后的 continuation 也可能是未提交草稿");
  assert.equal(enterKeys(h).length, 0);
});

test("Codex 草稿里的 footer 文案不能截断 composer 并藏掉后续旧内容", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen:
        "› \n\n  tab to queue message\n  OLD-DRAFT below fake footer\n\n  gpt-5.6-sol · Context 0% used",
      cursor: { row: 0, col: 2 },
      cols: 181,
    },
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "只有屏幕底部真实 footer 能界定 composer 下边界");
  assert.equal(enterKeys(h).length, 0);
});

test("pi 框内用户输入的横线不能冒充上框并藏掉旧草稿", async () => {
  const frame = "─".repeat(80);
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: `HISTORY\n${frame}\nOLD-DRAFT\n--------------------\n\n${frame}\nstatus`,
      cursor: { row: 4, col: 0 },
      cols: 80,
    },
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "ASCII 正文横线不能缩短输入区的上边界");
  assert.equal(enterKeys(h).length, 0);
});

test("pi 框内出现第二条全宽横线时边界有歧义，保守拒绝投递", async () => {
  const frame = "─".repeat(80);
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: `HISTORY\n${frame}\nOLD-DRAFT\n${frame}\n\n${frame}\nstatus`,
      cursor: { row: 4, col: 0 },
      cols: 80,
    },
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "多个候选上框无法可靠定位 composer，不能猜最近一条");
  assert.equal(enterKeys(h).length, 0);
});

test("pi 光标下方还有旧草稿时发送前必须检查上下框之间全部内容", async () => {
  const frame = "─".repeat(80);
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: `HISTORY\n${frame}\n\nOLD-DRAFT below cursor\n${frame}\nstatus`,
      cursor: { row: 2, col: 0 },
      cols: 80,
    },
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0);
});

test("pi 发送前 composer 已裁顶时，即使可见行为空也不能追加正文", async () => {
  const frame = "─".repeat(80);
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      // 上框已明确说还藏着 2 行旧草稿；可见空行不能冒充空 composer。
      screen: `HISTORY\n${"─── ↑ 2 more ".padEnd(80, "─")}\n\n${frame}\nstatus`,
      cursor: { row: 2, col: 0 },
      cols: 80,
    },
  });

  const r = await h.tools.spawn({ task: "不能追加到隐藏草稿", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0, "判空时已知道有隐藏行，连正文都不能写");
  assert.equal(enterKeys(h).length, 0);
});

test("pi proof 只画在光标右侧时不能冒充已经进入 composer", async () => {
  const frame = "─".repeat(80);
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: `HISTORY\n${frame}\n\n${frame}\nstatus`,
      cursor: { row: 2, col: 0 },
      cols: 80,
    },
    snapshotAfterText: (sentText) => ({
      screen: `HISTORY\n${frame}\n${sentText.replaceAll("\n", " ")}\n${frame}\nstatus`,
      cursor: { row: 2, col: 0 },
      cols: 80,
    }),
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 0, "proof 必须位于真实光标之前，右侧预览不能授权 Enter");
});

test("中文双宽字符不能让 JS slice 越过光标并吞进右侧 proof", async () => {
  const frame = "─".repeat(300);
  const task = "中文任务".repeat(30);
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: `HISTORY\n${frame}\n\n${frame}\nstatus`,
      cursor: { row: 2, col: 0 },
      cols: 300,
    },
    snapshotAfterText: (sentText) => ({
      screen: `HISTORY\n${frame}\n${sentText.replaceAll("\n", " ")}\n${frame}\nstatus`,
      cursor: { row: 2, col: [...task].length * 2 },
      cols: 300,
    }),
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(enterKeys(h).length, 0, "光标还在 proof 左侧，不能因 CJK cell 宽度误判");
});

for (const [label, grapheme] of [
  ["国旗", "🇨🇳"],
  ["keycap", "1️⃣"],
] as const) {
  test(`${label} emoji 的双列宽度不能让光标右侧 proof 被误收`, async () => {
    const frame = "─".repeat(300);
    const beforeCursor = grapheme.repeat(100);
    const h = harness({
      live: [info("mem", { command: "pi", idle_ms: 60_000 })],
      cards: [card("mem", "/w/mem")],
      snapshotBeforeText: {
        screen: `HISTORY\n${frame}\n\n${frame}\nstatus`,
        cursor: { row: 2, col: 0 },
        cols: 300,
      },
      snapshotAfterText: (sentText) => ({
        screen: `HISTORY\n${frame}\n${beforeCursor} ${sentText.replaceAll("\n", " ")}\n${frame}\nstatus`,
        cursor: { row: 2, col: 200 },
        cols: 300,
      }),
    });

    const r = await h.tools.spawn({ task: "任务", session: "mem", watch: false });
    assert.equal(r.isError, true);
    assert.equal(r.details?.phase, "submit");
    assert.equal(enterKeys(h).length, 0, `${label} 应按 2 cells 计算，proof 仍在 cursor 右侧`);
  });
}

test("已登记 session 发送前卡在模态框时保留台账和 watcher", async () => {
  const h = harness({
    live: [info("pi-a", { command: "pi", idle_ms: 60_000 })],
    cards: [card("pi-a", "/w")],
    stuckOnDialog: true,
  });
  h.registry.add({
    session: "pi-a",
    task: "旧任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  h.watchers.watch("pi-a");

  const r = await h.tools.spawn({ task: "新任务", session: "pi-a", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.ok(h.registry.get("pi-a") !== undefined, "模态框不是 session gone，不能丢掉 kill/nav 权限");
  assert.equal(h.watchers.isWatching("pi-a"), true, "投递没发生，不应擅自停止既有 watcher");
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0);
  h.watchers.stopAll();
});

test("回归：投递成功时照常记台账、挂 watcher", async () => {
  const h = harness({
    live: [info("mem", { command: "claude", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
  });
  const r = await h.tools.spawn({ task: "查一下新闻", session: "mem" });

  assert.equal(r.isError, undefined, r.text);
  assert.equal(h.registry.get("mem")?.createdByUs, false);
  assert.equal(enterKeys(h).length, 1, "校验过了才按回车");
  h.watchers.stopAll();
});

for (const placeholder of [
  "Use /skills to list available skills",
  "Write tests for @filename",
  "Implement {feature}",
]) {
  test(`Codex 动态 faint placeholder「${placeholder}」不按旧草稿处理`, async () => {
    const screen = `HISTORY\n› ${placeholder}\n\n  gpt-5.6-sol · Context 0% used`;
    const cursor = { row: 1, col: 2 };
    const h = harness({
      live: [info("mem", { command: "codex", idle_ms: 60_000 })],
      cards: [card("mem", "/w/mem")],
      snapshotBeforeText: {
        screen,
        cursor,
        cols: 181,
      },
      styledSnapshotBeforeText: {
        screen,
        cursor,
        cols: 181,
        faintRanges: [{ row: 1, startCol: 2, endCol: 2 + placeholder.length }],
      },
      snapshotAfterText: (sentText) => {
        const rendered = sentText.replaceAll("\n", "\n  ");
        const lines = rendered.split("\n");
        return {
          screen: `HISTORY\n› ${rendered}\n\n  gpt-5.6-sol · Context 0% used`,
          cursor: { row: lines.length, col: 2 + lines.at(-1)!.length },
          cols: 181,
        };
      },
    });

    const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
    assert.equal(r.isError, undefined, r.text);
    assert.equal(styledPeeks(h).length, 1, "未知文案必须靠终端样式识别，不能靠固定列表");
    assert.equal(deliveries(h).length, 1);
    assert.equal(enterKeys(h).length, 1);
  });
}

test("与动态 placeholder 字面相同的普通样式旧草稿仍拒绝投递", async () => {
  const placeholder = "Use /skills to list available skills";
  const screen = `HISTORY\n› ${placeholder}\n\n  gpt-5.6-sol · Context 0% used`;
  const cursor = { row: 1, col: 2 };
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: { screen, cursor, cols: 181 },
    styledSnapshotBeforeText: { screen, cursor, cols: 181, faintRanges: [] },
  });

  const r = await h.tools.spawn({ task: "不能覆盖旧草稿", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(styledPeeks(h).length, 1);
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0);
});

test("placeholder 只有部分字符是 faint 时不能当空输入框", async () => {
  const placeholder = "Use skills safely";
  const screen = `HISTORY\n› ${placeholder}\n\n  gpt-5.6-sol · Context 0% used`;
  const cursor = { row: 1, col: 2 };
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: { screen, cursor, cols: 181 },
    styledSnapshotBeforeText: {
      screen,
      cursor,
      cols: 181,
      faintRanges: [{ row: 1, startCol: 2, endCol: 5 }],
    },
  });

  const r = await h.tools.spawn({ task: "不能覆盖混合样式草稿", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0);
});

test("中文动态 placeholder 按终端 cell 范围识别", async () => {
  const placeholder = "解释这个代码库";
  const screen = `HISTORY\n› ${placeholder}\n\n  gpt-5.6-sol · Context 0% used`;
  const cursor = { row: 1, col: 2 };
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: { screen, cursor, cols: 181 },
    styledSnapshotBeforeText: {
      screen,
      cursor,
      cols: 181,
      faintRanges: [{ row: 1, startCol: 2, endCol: 2 + [...placeholder].length * 2 }],
    },
    snapshotAfterText: (sentText) => {
      const rendered = sentText.replaceAll("\n", "\n  ");
      const lines = rendered.split("\n");
      return {
        screen: `HISTORY\n› ${rendered}\n\n  gpt-5.6-sol · Context 0% used`,
        cursor: { row: lines.length, col: 2 + lines.at(-1)!.length },
        cols: 181,
      };
    },
  });

  const r = await h.tools.spawn({ task: "执行中文任务", session: "mem", watch: false });

  assert.equal(r.isError, undefined, r.text);
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 1);
});

test("styled peek 与发送前纯文本快照不一致时失败闭合", async () => {
  const placeholder = "Implement {feature}";
  const screen = `HISTORY\n› ${placeholder}\n\n  gpt-5.6-sol · Context 0% used`;
  const cursor = { row: 1, col: 2 };
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: { screen, cursor, cols: 181 },
    styledSnapshotBeforeText: {
      screen: screen.replace(placeholder, "REAL-DRAFT"),
      cursor,
      cols: 181,
      faintRanges: [{ row: 1, startCol: 2, endCol: 12 }],
    },
  });

  const r = await h.tools.spawn({ task: "不能追着变化写", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0);
});

test("样式复核时出现模态框绝不发送正文或任何按键", async () => {
  const placeholder = "Implement {feature}";
  const screen = `HISTORY\n› ${placeholder}\n\n  gpt-5.6-sol · Context 0% used`;
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: { screen, cursor: { row: 1, col: 2 }, cols: 181 },
    styledSnapshotBeforeText: {
      screen: "❯ 1. Allow this action\n  2. Cancel\n Enter to confirm · Esc to cancel",
      cursor: { row: 0, col: 0 },
      cols: 181,
      faintRanges: [],
    },
  });

  const r = await h.tools.spawn({ task: "不能确认模态框", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.match(r.text, /对话框/);
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0);
});

test("畸形样式范围作为 text 阶段失败处理，不发送正文或按键", async () => {
  const placeholder = "Implement {feature}";
  const screen = `HISTORY\n› ${placeholder}\n\n  gpt-5.6-sol · Context 0% used`;
  const cursor = { row: 1, col: 2 };
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: { screen, cursor, cols: 181 },
    styledSnapshotBeforeText: {
      screen,
      cursor,
      cols: 181,
      faintRanges: [{ row: 1, startCol: 2, endCol: 999 }],
    },
  });

  const r = await h.tools.spawn({ task: "不能信任坏 JSON", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "text");
  assert.match(r.text, /无法验证/);
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0);
});

test("旧 asd 没有样式快照能力时给出升级提示且绝不探测输入框", async () => {
  const placeholder = "Implement {feature}";
  const screen = `HISTORY\n› ${placeholder}\n\n  gpt-5.6-sol · Context 0% used`;
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: { screen, cursor: { row: 1, col: 2 }, cols: 181 },
    stylesUnsupported: true,
  });

  const r = await h.tools.spawn({ task: "需要新 asd", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.match(r.text, /升级 asd/);
  assert.equal(deliveries(h).length, 0);
  assert.equal(enterKeys(h).length, 0, "不支持样式时不能用 Space/Backspace/Enter 猜测");
});

test("正常历史 prompt 上方仍有旧任务时，底部空 composer 仍可接新任务", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› earlier question\nanswer already finished\n\n› ",
  });

  const r = await h.tools.spawn({ task: "执行下一项任务", session: "mem", watch: false });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(deliveries(h).length, 1, "历史区不能让正常的既有 session 永久无法派活");
  assert.equal(enterKeys(h).length, 1);
});

test("长任务仍在逐帧回显时不提交，等屏幕稳定后才按 Enter", async () => {
  const task = `长任务：${"继续检查所有模块。".repeat(40)}`;
  const head = task.slice(0, 40);
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    echoScreens: [
      `SCREEN:mem\n${head} 第一帧`,
      `SCREEN:mem\n${head} 第二帧`,
      `SCREEN:mem\n${task}`,
    ],
    requireEchoScreensBeforeSubmit: true,
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, undefined, r.text);
  const screen = await h.tools.peek({ session: "mem" });
  assert.match(screen.text, /WORKING/, "必须等完整回显稳定后，Enter 才会真正提交");
  assert.equal(deliveries(h).length, 1, "等待回显期间不能重发正文");
});

test("判空与 sendText 之间出现并发旧草稿时 proof 后缀不能授权 Enter", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› ",
    screenAfterText: (sentText) =>
      `SCREEN:mem\n› OLD-DRAFT inserted concurrently:${sentText.replaceAll("\n", "\n  ")}`,
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(deliveries(h).length, 1, "正文 ACK 后是未知态，不能自动重发");
  assert.equal(enterKeys(h).length, 0, "非明确裁顶视图必须与完整 payload 精确相等");
});

test("判空与 sendText 之间并发输入 > 时，结构字符也必须当作草稿内容", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› ",
    screenAfterText: (sentText) =>
      `SCREEN:mem\n› >${sentText.replaceAll("\n", "\n  ")}`,
  });

  const r = await h.tools.spawn({ task: "执行新任务", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(deliveries(h).length, 1, "sendText ACK 后不能自动重发正文");
  assert.equal(enterKeys(h).length, 0, "prompt 已结构化剔除，composer 里额外的 > 不能再当噪声删掉");
});

test("判空与 sendText 之间并发插入真实空格时不能被布局归一化吞掉", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› ",
    screenAfterText: (sentText) =>
      `SCREEN:mem\n› ${sentText.replace("检查提交证据", "检查 提交证据").replaceAll("\n", "\n  ")}`,
  });

  const r = await h.tools.spawn({ task: "检查提交证据", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(enterKeys(h).length, 0, "用户正文里的空格不是 TUI 布局，不能授权 Enter");
});

test("判空与 sendText 之间并发插入短行换行时不能冒充终端软换行", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› ",
    screenAfterText: (sentText) =>
      `SCREEN:mem\n› ${sentText.replace("检查提交证据", "检查\n  提交证据").replaceAll("\n\n", "\n  \n  ")}`,
  });

  const r = await h.tools.spawn({ task: "检查提交证据", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(enterKeys(h).length, 0, "未占满终端的短行断开是用户换行，不是软换行");
});

test("Codex 裁顶没有隐藏行计数时只见尾部 proof 仍保守拒绝提交", async () => {
  const task = Array.from({ length: 40 }, (_, i) => `UNIQUE-LINE-${i + 1}`).join("\n");
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› ",
    screenAfterText: (sentText) => `SCREEN:mem\n› ↑ 35 more\n  ${sentText.slice(-80)}`,
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 0, "没有明确裁顶结构时 proof 后缀不足以排除并发旧草稿");
});

test("pi 长任务裁顶后只有尾部证据时保守拒绝提交", async () => {
  const frame = "─".repeat(80);
  const task = Array.from({ length: 30 }, (_, i) => `PI-LINE-${i + 1}`).join("\n");
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: `HISTORY\n${frame}\n\n${frame}\nstatus`,
      cursor: { row: 2, col: 0 },
      cols: 80,
    },
    snapshotAfterText: (sentText) => {
      const visible = sentText.split("\n").slice(-2);
      return {
        screen: `HISTORY\n${"─── ↑ 29 more ".padEnd(80, "─")}\n${visible.join("\n")}\n${frame}\nstatus`,
        cursor: { row: 3, col: visible.at(-1)!.length },
        cols: 80,
      };
    },
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 0, "被裁掉的首部无法做精确全文校验，不能授权 Enter");
});

test("pi 裁顶时旧草稿与 payload 首行合并且隐藏行数不变，仍不能按 Enter", async () => {
  const frame = "─".repeat(80);
  const task = Array.from({ length: 30 }, (_, i) => `PI-LINE-${i + 1}`).join("\n");
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: `HISTORY\n${frame}\n\n${frame}\nstatus`,
      cursor: { row: 2, col: 0 },
      cols: 80,
    },
    snapshotAfterText: (sentText) => {
      const visible = sentText.split("\n").slice(-2);
      return {
        // OLD: 和 payload 首行共用一个终端行；↑ 29 more 仍然完全对得上。
        // 可见尾部与 proof 也都没变，所以裁顶视图根本不足以排除这个竞态。
        screen: `HISTORY\n${"─── ↑ 29 more ".padEnd(80, "─")}\n${visible.join("\n")}\n${frame}\nstatus`,
        cursor: { row: 3, col: visible.at(-1)!.length },
        cols: 80,
      };
    },
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(deliveries(h).length, 1, "正文仍只能 --text 一次");
  assert.equal(enterKeys(h).length, 0, "裁顶后不能凭尾部 proof 和隐藏行数猜测全文");
});

test("pi 裁顶隐藏行数多出一行时同样不能按 Enter", async () => {
  const frame = "─".repeat(80);
  const task = Array.from({ length: 30 }, (_, i) => `PI-LINE-${i + 1}`).join("\n");
  const h = harness({
    live: [info("mem", { command: "pi", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    snapshotBeforeText: {
      screen: `HISTORY\n${frame}\n\n${frame}\nstatus`,
      cursor: { row: 2, col: 0 },
      cols: 80,
    },
    snapshotAfterText: (sentText) => {
      const visible = sentText.split("\n").slice(-2);
      return {
        // payload 共 31 行、当前可见 2 行，正常应为 ↑ 29 more；30 说明还藏着一行。
        screen: `HISTORY\n${"─── ↑ 30 more ".padEnd(80, "─")}\n${visible.join("\n")}\n${frame}\nstatus`,
        cursor: { row: 3, col: visible.at(-1)!.length },
        cols: 80,
      };
    },
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 0, "隐藏行数是否对得上都不足以授权裁顶 composer 提交");
});

test("合法多行任务里的 Markdown 引用符不能被误认成新的 composer 起点", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› ",
    screenAfterText: (sentText) => `SCREEN:mem\n› ${sentText.replaceAll("\n", "\n  ")}`,
  });
  const task = "先检查问题并记录完整证据\n> 再汇报最终结果";

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 1, "任务内部的 > 不是新的输入框，正常任务仍应提交");
});

test("合法多行任务里与根 prompt 相同的字形也按真实缩进正常提交", async () => {
  const task = "FIRST PART\n› SECOND PART";
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› ",
    screenAfterText: (sentText) => `SCREEN:mem\n› ${sentText.replaceAll("\n", "\n  ")}`,
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 1);
});

test("历史里有同任务但当前 composer 是别的草稿时绝不能按 Enter", async () => {
  const task = "历史任务特征不能越过当前 composer 命中";
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: `${task}\nOUTPUT\n\n› `,
    screenAfterText: `SCREEN:mem\n› ${task}\nOUTPUT\n\n› OTHER-DRAFT`,
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(deliveries(h).length, 1, "正文始终只允许送一次");
  assert.equal(enterKeys(h).length, 0, "历史命中不能授权提交当前 OTHER-DRAFT");
});

test("历史前缀和当前 composer 后缀不能拼成一份完整任务", async () => {
  const task = "FIRST PART\n› SECOND PART";
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "FIRST PART\n\n› ",
    screenAfterText: "SCREEN:mem\n› FIRST PART\n\n› SECOND PART",
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 0, "发送前当前 prompt 必须锚定，不能跨 composer 拼接证据");
});

test("不同 prompt 字形的当前后缀也不能与历史前缀拼接", async () => {
  const task = "FIRST PART\n> SECOND PART";
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "FIRST PART\n\n› ",
    screenAfterText: "SCREEN:mem\n› FIRST PART\n\n> SECOND PART",
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 0, "第 0 列的另一个 prompt 是当前 composer，不是正文续行");
});

test("第一次 Enter 被当成粘贴换行时，稳定后补一次 Enter 并真正提交", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› ",
    enterBehavior: "newline-once",
  });

  const r = await h.tools.spawn({ task: "检查整个仓库并汇报", session: "mem", watch: false });
  assert.equal(r.isError, undefined, r.text);
  const screen = await h.tools.peek({ session: "mem" });
  assert.match(screen.text, /WORKING/, "补发的 Enter 应把仍在输入框里的任务提交出去");
  assert.equal(enterKeys(h).length, 2, "只允许补一次 Enter");
  assert.equal(deliveries(h).length, 1, "补发只补 Enter，不能重发正文");
});

test("正常提交只按一次 Enter，不走补发路径", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
  });

  const r = await h.tools.spawn({ task: "正常执行这项任务", session: "mem", watch: false });
  assert.equal(r.isError, undefined, r.text);
  const screen = await h.tools.peek({ session: "mem" });
  assert.match(screen.text, /WORKING/);
  assert.equal(enterKeys(h).length, 1, "屏幕已变化就不能再补 Enter");
  assert.equal(deliveries(h).length, 1);
});

test("首次 Enter 后出现模态框时绝不补 Enter", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    dialogAfterFirstEnter: true,
  });

  const r = await h.tools.spawn({ task: "执行时可能申请权限", session: "mem", watch: false });
  assert.equal(r.isError, true, "对话框来源不明时不能谎报本任务已提交");
  assert.equal(r.details?.phase, "submit");
  const screen = await h.tools.peek({ session: "mem" });
  assert.match(screen.text, /Allow this action/, "模态框应保留给用户决定");
  assert.equal(enterKeys(h).length, 1, "第二颗 Enter 会误确认模态框，绝不能发送");
  assert.equal(deliveries(h).length, 1);
  assert.equal(h.registry.get("mem")?.createdByUs, false, "仍要保留 peek/nav 控制权");
});

test("第一颗 Enter 后屏幕不变时停止自动补键，返回可恢复 submit 状态", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    enterBehavior: "ignored",
  });

  const r = await h.tools.spawn({ task: "等待 TUI 真正处理按键", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(r.details?.pendingComposer, true);
  assert.equal(enterKeys(h).length, 1, "daemon ACK 不能证明消费，完全不变时绝不能自动补键");
  assert.equal(deliveries(h).length, 1);
});

test("第一颗 Enter 被 TUI 完全吞掉时，保留 nav 权后可显式提交", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    enterBehavior: "ignored-once",
  });

  const r = await h.tools.spawn({ task: "commit and push", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(r.details?.pendingComposer, true);
  assert.equal(h.registry.get("mem")?.createdByUs, false);
  assert.equal(enterKeys(h).length, 1, "自动路径只能送第一颗 Enter");
  const recovered = await h.tools.nav({ session: "mem", keys: ["Enter"] });
  assert.equal(recovered.isError, undefined, recovered.text);
  assert.equal(deliveries(h).length, 1, "恢复提交只能补 Enter，不能重发正文");
  assert.equal(enterKeys(h).length, 2, "第二颗来自显式 nav 决策");
  const screen = await h.tools.peek({ session: "mem" });
  assert.match(screen.text, /WORKING/, "显式 Enter 应触发已经在 composer 里的原任务");
});

test("指名投递第一颗 Enter 无效时仍保留监视和 nav 恢复权", async () => {
  const h = harness({
    live: [info("asd", { command: "codex", idle_ms: 60_000 })],
    cards: [card("asd", "/root/workspace/master/asd")],
    enterBehavior: "ignored",
  });

  const spawned = await h.tools.spawn({ task: "commit and push", session: "asd" });

  assert.equal(spawned.isError, true, "第一颗 Enter 未确认时不能谎报成功");
  assert.equal(spawned.details?.phase, "submit");
  assert.equal(spawned.details?.pendingComposer, true, "要标出仍能识别本次 proof 的 composer");
  assert.equal(deliveries(h).length, 1, "失败恢复也不能重复发送正文");
  assert.equal(enterKeys(h).length, 1, "自动路径不能猜测第一颗已被吞掉");
  assert.equal(h.registry.get("asd")?.createdByUs, false, "已修改过的外部 session 必须留在台账");
  assert.equal(h.registry.get("asd")?.task, "commit and push");
  assert.equal(h.watchers.isWatching("asd"), true, "失败画面也要由 watcher 汇报");

  const steered = await h.tools.steer({ session: "asd", message: "不要改动其他文件" });
  assert.equal(steered.isError, true);
  assert.doesNotMatch(steered.text, /不在 pi-asd 监视列表/, "steer 不能再因台账丢失而拒绝");
  assert.match(steered.text, /已有未提交内容/);

  const navigated = await h.tools.nav({ session: "asd", keys: ["Enter"] });
  assert.equal(navigated.isError, undefined, navigated.text);
  assert.equal(enterKeys(h).length, 2, "显式 nav 应能对原正文补 Enter");
  assert.equal(deliveries(h).length, 1, "nav 只能送按键，不能重发正文");
  h.watchers.stopAll();
});

test("首次 Enter 后 composer 被外部改成 X-payload 时，proof 仍在不能冒充已提交", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    enterBehavior: "mutated",
  });

  const r = await h.tools.spawn({ task: "检查提交确认", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.match(r.text, /proof 仍在 composer/);
  assert.equal(r.details?.pendingComposer, false, "变异正文不能标成可恢复的原 composer");
  assert.doesNotMatch(r.text, /asd_nav/, "变异正文不能引导调用方直接提交");
  assert.equal(deliveries(h).length, 1, "正文只能发送一次");
  assert.equal(enterKeys(h).length, 1, "composer 已变异，不能补第二颗 Enter");
});

test("首次 Enter 后外部清空 composer 时不能把 proof 消失当作提交成功", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    enterBehavior: "cleared",
  });

  const r = await h.tools.spawn({ task: "检查提交确认", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.match(r.text, /可能已提交，也可能被外部输入清空/);
  assert.equal(r.details?.pendingComposer, false, "proof 已不在 composer，不能建议直接补 Enter");
  assert.equal(enterKeys(h).length, 1, "清空后的空 composer 绝不能收到第二颗 Enter");
});

test("首次 Enter 后外部清空并切换 prompt 时也不能走整屏变化回退", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    enterBehavior: "cleared-prompt",
  });

  const r = await h.tools.spawn({ task: "检查提交确认", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.match(r.text, /可能已提交，也可能被外部输入清空/);
  assert.equal(r.details?.pendingComposer, false);
  assert.equal(enterKeys(h).length, 1, "结构未知且 proof 消失仍不能补键或报成功");
});

test("首次 Enter 后正文空格被改写时不能标成可恢复的原 composer", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    enterBehavior: "whitespace-mutated",
  });

  const r = await h.tools.spawn({ task: "检查提交确认", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(r.details?.pendingComposer, false, "真实空格变化不能被当成 exact payload");
  assert.equal(enterKeys(h).length, 1, "变异正文不能自动补第二颗 Enter");
});

test("首次 Enter 插入换行时并发写入结构字符也不能触发自动补键", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    enterBehavior: "newline-structural-mutation",
  });

  const r = await h.tools.spawn({ task: "检查提交确认", session: "mem", watch: false });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(r.details?.pendingComposer, false);
  assert.equal(enterKeys(h).length, 1, "`>` 是真实正文变异，不能被噪声规则删掉后补 Enter");
});

test("首次 Enter 后 prompt 换代且变成 X-payload 时，unknown 也必须先查可见 proof", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    enterBehavior: "mutated-prompt",
  });

  const r = await h.tools.spawn({ task: "检查 unknown 回退", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.match(r.text, /proof 仍在 composer/);
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 1, "结构换代不能让仍可见的 proof 绕过 mismatch");
});

test("任务移到历史区且底部 composer 已空时确认已提交，不补第二颗 Enter", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    enterBehavior: "history",
  });

  const r = await h.tools.spawn({ task: "任务文字会进入历史区", session: "mem", watch: false });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(enterKeys(h).length, 1, "唯一 proof 已离开 composer 就是提交证据，不能误补 Enter");
  assert.equal(deliveries(h).length, 1);
});

test("第一颗 Enter 后任务进入带提示符历史且底部 composer 为空时不能补 Enter", async () => {
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› ",
    enterBehavior: "history-prompt",
  });

  const r = await h.tools.spawn({ task: "任务已经进入历史区", session: "mem", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(enterKeys(h).length, 1, "底部 composer 为空说明任务不在那里，绝不能补第二颗 Enter");
  assert.equal(deliveries(h).length, 1);
});

test("历史区已有相同任务时仍按唯一 proof 锚定当前 composer 的提交结果", async () => {
  const task = "重复任务前缀必须锁定输入框位置";
  const h = harness({
    live: [info("mem", { command: "codex", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: `• ${task}\n› `,
    enterBehavior: "history",
  });

  const r = await h.tools.spawn({ task, session: "mem", watch: false });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(enterKeys(h).length, 1, "底部 composer 已空，不能锚定旧历史后误补 Enter");
  assert.equal(deliveries(h).length, 1);
});

test("两次 Enter 都没提交时标记 submit 失败，不能把同一任务自动改派到新 session", async () => {
  const h = harness({
    live: [info("pi-a", { command: "pi", idle_ms: 60_000 })],
    screenPrefix: "› ",
    enterBehavior: "newline-always",
  });
  h.registry.add({
    session: "pi-a",
    task: "旧任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const r = await h.tools.spawn({ task: "新任务", agent: "pi", watch: false });
  assert.equal(r.isError, true, "提交没确认时不能转去新建并谎报成功");
  assert.equal(r.details?.phase, "submit");
  assert.match(r.text, /文本已输入.*未确认提交/);
  assert.equal(subcommands(h).includes("new"), false, "文本可能仍在旧输入框，不能改派新 session");
  assert.equal(deliveries(h).length, 1, "不能重发正文");
  assert.equal(enterKeys(h).length, 2, "最多补一次 Enter");
  assert.ok(h.registry.get("pi-a") !== undefined, "未确认提交不能把仍存活的 agent 从台账删掉");
});

test("自己新建的 send 型 session 提交未确认时保留 kill 和 nav 权", async () => {
  const h = harness({ enterBehavior: "ignored" });

  const r = await h.tools.spawn({
    task: "检查新目录",
    agent: "claude",
    reuse: false,
  });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  const [session] = h.registry.names();
  assert.equal(session, "pi-agent1");
  assert.equal(h.registry.get(session!)?.createdByUs, true, "自己 new 的 session 仍归自己管理");
  assert.equal(h.watchers.isWatching(session!), true);

  const navigated = await h.tools.nav({ session: session!, keys: ["Enter"] });
  assert.equal(navigated.isError, undefined, navigated.text);
  const killed = await h.tools.kill({ session: session! });
  assert.equal(killed.isError, undefined, killed.text);
  assert.equal(h.registry.get(session!), undefined);
  h.watchers.stopAll();
});

test("自动复用收到 sendText ACK 但没有回显时不能改派新 session", async () => {
  const h = harness({
    live: [info("pi-a", { command: "pi", idle_ms: 60_000 })],
    swallowText: true,
  });
  h.registry.add({
    session: "pi-a",
    task: "旧任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const r = await h.tools.spawn({ task: "新任务", agent: "pi", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(subcommands(h).includes("new"), false, "ACK 后是否落进 PTY 不确定，不能自动改派");
  assert.equal(deliveries(h).length, 1);
  assert.equal(enterKeys(h).length, 0);
  assert.ok(h.registry.get("pi-a") !== undefined);
});

test("自动复用在 submit 阶段消失时清台账，不能重建幽灵记录", async () => {
  const h = harness({
    live: [info("pi-a", { command: "pi", idle_ms: 60_000 })],
    goneOnEnter: true,
  });
  h.registry.add({
    session: "pi-a",
    task: "旧任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  h.watchers.watch("pi-a");

  const r = await h.tools.spawn({ task: "新任务", agent: "pi" });

  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(h.registry.get("pi-a"), undefined, "已消失的 session 不能因 submit 分支复活");
  assert.equal(h.watchers.isWatching("pi-a"), false);
  assert.equal(subcommands(h).includes("new"), false, "正文已经发送过，不能改派新 session");
});

test("历史区已有任务前缀时状态栏变化不能冒充新正文回显", async () => {
  const task = "相同任务前缀早已出现在历史区";
  const after = `SCREEN:pi-a\n${task}\nSTATUS:1`;
  const h = harness({
    live: [info("pi-a", { command: "pi", idle_ms: 60_000 })],
    screenPrefix: `${task}\nSTATUS:0\n› `,
    echoScreens: [after, after, after, after],
    swallowText: true,
  });
  h.registry.add({
    session: "pi-a",
    task: "旧任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const r = await h.tools.spawn({ task, agent: "pi", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(enterKeys(h).length, 0, "只有状态栏变了，不能对历史区的旧前缀按 Enter");
  assert.equal(subcommands(h).includes("new"), false);
  assert.equal(deliveries(h).length, 1);
});

test("历史重绘多露出一条同任务记录时不能冒充 composer 回显", async () => {
  const task = "重复历史记录不能骗过输入框定位";
  const redrawn = `SCREEN:pi-a\n• ${task}\n• ${task}\n› `;
  const h = harness({
    live: [info("pi-a", { command: "pi", idle_ms: 60_000 })],
    screenPrefix: `• ${task}\n› `,
    echoScreens: [redrawn, redrawn, redrawn, redrawn],
    swallowText: true,
  });
  h.registry.add({
    session: "pi-a",
    task: "旧任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const r = await h.tools.spawn({ task, agent: "pi", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(enterKeys(h).length, 0, "新增命中只在历史区，composer 仍为空，不能按 Enter");
  assert.equal(subcommands(h).includes("new"), false);
  assert.equal(deliveries(h).length, 1);
});

test("历史重绘露出带提示符的同任务记录时仍只认最底部空 composer", async () => {
  const task = "历史用户消息也可能带输入提示符";
  const redrawn = `SCREEN:pi-a\n› ${task}\n› `;
  const h = harness({
    live: [info("pi-a", { command: "pi", idle_ms: 60_000 })],
    screenPrefix: "› ",
    echoScreens: [redrawn, redrawn, redrawn, redrawn],
    swallowText: true,
  });
  h.registry.add({
    session: "pi-a",
    task: "旧任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const r = await h.tools.spawn({ task, agent: "pi", watch: false });
  assert.equal(r.isError, true);
  assert.equal(r.details?.phase, "submit");
  assert.equal(enterKeys(h).length, 0, "最底部 composer 为空，不能继续向上命中历史提示符");
  assert.equal(deliveries(h).length, 1);
});

test("steer 补发 Enter 时正文始终只用 --text 发送一次", async () => {
  const h = harness({
    live: [info("pi-a", { command: "pi", idle_ms: 60_000 })],
    screenPrefix: "› ",
    enterBehavior: "newline-once",
  });
  h.registry.add({
    session: "pi-a",
    task: "旧任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });

  const r = await h.tools.steer({ session: "pi-a", message: "换个思路继续" });
  assert.equal(r.isError, undefined, r.text);
  const screen = await h.tools.peek({ session: "pi-a" });
  assert.match(screen.text, /WORKING/);
  assert.equal(deliveries(h).length, 1, "补发路径不能再送一次正文");
  assert.equal(enterKeys(h).length, 2, "只补一颗 Enter");
  h.watchers.stopAll();
});

test("steer 没投进去时报错，但**不清台账** —— agent 还活着", async () => {
  const h = harness({ live: [info("pi-a", { idle_ms: 60_000 })], swallowText: true });
  h.registry.add({
    session: "pi-a",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  const r = await h.tools.steer({ session: "pi-a", message: "换个思路" });

  assert.equal(r.isError, true);
  assert.match(r.text, /消息未投递成功/);
  assert.ok(h.registry.get("pi-a") !== undefined, "只是没投进去，agent 还在，台账不能清");
  h.watchers.stopAll();
});

test("claude 预设走 send 投递：裸启动，任务不拼进启动命令", async () => {
  const h = harness();
  const r = await h.tools.spawn({ task: "查一下新闻", agent: "claude" });
  assert.equal(r.isError, undefined, r.text);

  const newCall = h.calls.find((c) => c[0] === "new")!;
  const cmdIdx = newCall.indexOf("--cmd");
  const cmd = newCall[cmdIdx + 1]!;
  assert.equal(cmd, "claude --dangerously-skip-permissions", "裸启动，不带任务");
  assert.ok(!cmd.includes("查一下新闻"), "任务绝不能拼进 argv —— 信任对话框会让它永远轮不到执行");
  assert.equal(deliveries(h).length, 1, "任务通过 send 投进去");
  h.watchers.stopAll();
});

test("pi / codex 仍走 argv —— 没有验证过的替代方案就不改它们", async () => {
  for (const agent of ["pi", "codex"]) {
    const h = harness();
    await h.tools.spawn({ task: "查一下新闻", agent });
    const newCall = h.calls.find((c) => c[0] === "new")!;
    const cmd = newCall[newCall.indexOf("--cmd") + 1]!;
    assert.ok(cmd.includes("查一下新闻"), `${agent} 应当把任务拼进 argv`);
    assert.equal(deliveries(h).length, 0, `${agent} 不该走 send`);
    h.watchers.stopAll();
  }
});

/**
 * claude 在未信任目录里会先弹信任确认。它是模态的：盖在输入框上层，任务文本会
 * 送到它后面、回车被它吃掉，而默认选项还可能是"退出" —— session 直接消失。
 */
test("撞上启动期对话框时先按预设的键过掉，再投任务", async () => {
  const h = harness({ startupScreens: ["❯ 1. Yes, I trust this folder\n  2. No, exit"] });
  const r = await h.tools.spawn({ task: "查一下新闻", agent: "claude" });
  assert.equal(r.isError, undefined, r.text);

  // 过对话框的那次 Enter 必须发生在任务文本之前
  const iDialogEnter = h.calls.findIndex((c) => c[0] === "send" && c.includes("--key"));
  const iText = h.calls.findIndex((c) => c[0] === "send" && c.includes("--text"));
  assert.ok(iDialogEnter >= 0, "应当送过一次 Enter 去过对话框");
  assert.ok(iDialogEnter < iText, "过对话框必须在投任务之前，否则任务会打进对话框里");
  h.watchers.stopAll();
});

test("对话框过不掉时如实报错，不记台账", async () => {
  // 屏幕一直停在对话框上 —— 送了键也没过去
  const h = harness({ stuckOnDialog: true });
  const r = await h.tools.spawn({ task: "查一下新闻", agent: "claude" });

  assert.equal(r.isError, true);
  assert.match(r.text, /任务未投递成功/);
  assert.match(r.text, /工作目录信任确认/, "要说清卡在哪个界面上");
  assert.equal(h.registry.size, 0);
  assert.equal(deliveries(h).length, 0, "没过对话框就绝不能投任务");
});

// --- 环境透传 ---
//
// 子 agent 是 asd **daemon** fork 出来的，继承的是 daemon 的环境 —— 那个 daemon
// 可能是几天前从另一个 shell 起来的，跟 pi 的环境毫无关系。
//
// 踩到的实例：本机以 root 运行时，`claude --dangerously-skip-permissions` 在没有
// IS_SANDBOX=1 的情况下直接拒绝启动（"cannot be used with root/sudo privileges"）
// 并立即退出 —— 表现就是 spawn 出来的 session 一秒就消失。用户交互 shell 里有这个
// 变量（clp 别名设的），daemon 里没有。

test("withEnv 把变量拼在命令前面，值走 shellEscape", () => {
  assert.equal(withEnv({ A: "1" }, "claude"), "A='1' claude");
  assert.equal(withEnv({ A: "1", B: "x y" }, "cmd"), "A='1' B='x y' cmd");
  assert.equal(withEnv({ P: "http://h:1?a=b&c=d" }, "cmd"), "P='http://h:1?a=b&c=d' cmd");
  // 带单引号的值不能把命令拼断
  assert.equal(withEnv({ A: "it's" }, "cmd"), "A='it'\\''s' cmd");
});

test("withEnv 没有变量时原样返回，空值不拼进去", () => {
  assert.equal(withEnv(undefined, "claude"), "claude");
  assert.equal(withEnv({}, "claude"), "claude");
  // 空串是"没设置"，拼 `X=''` 进去反而会把子进程里本来有的值覆盖成空
  assert.equal(withEnv({ A: "" }, "claude"), "claude");
});

test("argv 路径把 spawnEnv 拼进启动命令，且在 PI_SPAWNED 之前", async () => {
  const h = harness({ spawnEnv: { IS_SANDBOX: "1" } });
  await h.tools.spawn({ task: "t", agent: "pi" });
  const cmd = h.calls.find((c) => c[0] === "new")![
    h.calls.find((c) => c[0] === "new")!.indexOf("--cmd") + 1
  ]!;
  assert.match(cmd, /^IS_SANDBOX='1' PI_SPAWNED=1 /, `实际：${cmd}`);
  h.watchers.stopAll();
});

/**
 * 回归：裸启动这条路绕开了 buildSpawnCommand，最容易漏掉 env —— 而 claude 恰恰
 * 走这条，也恰恰是最需要 IS_SANDBOX 的那个。
 */
test("回归：send 投递路径（裸启动）同样带上 spawnEnv", async () => {
  const h = harness({ spawnEnv: { IS_SANDBOX: "1", HTTPS_PROXY: "http://p:1" } });
  const r = await h.tools.spawn({ task: "t", agent: "claude" });
  assert.equal(r.isError, undefined, r.text);
  const newCall = h.calls.find((c) => c[0] === "new")!;
  const cmd = newCall[newCall.indexOf("--cmd") + 1]!;
  assert.match(cmd, /IS_SANDBOX='1'/);
  assert.match(cmd, /HTTPS_PROXY='http:\/\/p:1'/);
  assert.match(cmd, /claude --dangerously-skip-permissions$/, "env 在前，裸命令在后");
  h.watchers.stopAll();
});

test("没配 spawnEnv 时命令不变 —— 不给不相干的项目凭空加前缀", async () => {
  const h = harness();
  await h.tools.spawn({ task: "t", agent: "claude" });
  const newCall = h.calls.find((c) => c[0] === "new")!;
  assert.equal(newCall[newCall.indexOf("--cmd") + 1], "claude --dangerously-skip-permissions");
  h.watchers.stopAll();
});

// --- agent → 本机别名 ---
//
// shell 别名只在**交互式** bash 里展开：/bin/sh 常是 dash（本机就是），非交互的
// bash 既不 source ~/.bashrc 也不展开别名。实测（真 pty、daemon 环境已剥干净）：
//   clp             → session 立刻消失（command not found）
//   sh -c 'clp'     → session 立刻消失（command not found）
//   bash -ic 'clp'  → 起得来，别名带的环境变量也生效
// 所以别名必须包一层 `bash -ic`，不能直接当命令用。

test("bashInteractive 包成交互式 bash —— 别名只有这样才展开", () => {
  assert.equal(bashInteractive("clp"), "bash -ic 'clp'");
  // 内层带引号也不能把命令拼断
  assert.equal(bashInteractive("clp 'a b'"), "bash -ic 'clp '\\''a b'\\'''");
});

test("withAlias 换掉带任务和不带任务两个启动命令", () => {
  const aliased = withAlias(PRESETS.claude!, "clp");
  assert.equal(aliased.bare, "bash -ic 'clp'");
  assert.match(aliased.command("'干活'"), /^bash -ic 'clp /);
  // 其余字段原样保留 —— 尤其 deliver 和启动期对话框
  assert.equal(aliased.deliver, PRESETS.claude!.deliver);
  assert.deepEqual(aliased.startupDialogs, PRESETS.claude!.startupDialogs);
});

test("配了别名的 agent 用别名启动（裸启动路径）", async () => {
  const presets = { ...PRESETS, claude: withAlias(PRESETS.claude!, "clp") };
  const h = harness({ presets });
  const r = await h.tools.spawn({ task: "查一下新闻", agent: "claude" });
  assert.equal(r.isError, undefined, r.text);
  const newCall = h.calls.find((c) => c[0] === "new")!;
  assert.equal(newCall[newCall.indexOf("--cmd") + 1], "bash -ic 'clp'");
  h.watchers.stopAll();
});

test("配了别名的 agent 用别名启动（argv 路径），任务仍然拼在后面", async () => {
  const presets = { ...PRESETS, pi: withAlias(PRESETS.pi!, "mypi") };
  const h = harness({ presets });
  await h.tools.spawn({ task: "查一下新闻", agent: "pi" });
  const newCall = h.calls.find((c) => c[0] === "new")!;
  const cmd = newCall[newCall.indexOf("--cmd") + 1]!;
  // 夹具里 parentSession 有值，所以 PI_PARENT_SESSION 也在
  assert.match(cmd, /^PI_SPAWNED=1 PI_PARENT_SESSION='\/s\.jsonl' bash -ic 'mypi /, `实际：${cmd}`);
  assert.match(cmd, /查一下新闻/);
  h.watchers.stopAll();
});

test("没配别名的 agent 保持原样 —— 不给别人的机器凭空加 bash -ic", async () => {
  const presets = { ...PRESETS, claude: withAlias(PRESETS.claude!, "clp") };
  const h = harness({ presets });
  await h.tools.spawn({ task: "t", agent: "codex" });
  const newCall = h.calls.find((c) => c[0] === "new")!;
  const cmd = newCall[newCall.indexOf("--cmd") + 1]!;
  assert.match(cmd, /^codex /, `实际：${cmd}`);
  assert.doesNotMatch(cmd, /bash -ic/);
  h.watchers.stopAll();
});

// --- asd_nav：往会话里按键 ---
//
// 存在的理由：对话框是模态的，会把输入框顶掉。那时 asd_steer 的投递校验会失败
// 并**拒绝按回车** —— 那是对的，因为那一下回车会去确认对话框当前选中的项
// （claude 信任对话框的第二项是 "No, exit"）。所以"操作对话框"必须是独立动作。

test("resolveNavKeys 同时认 ArrowDown 和 Down 两套写法，大小写随便", () => {
  assert.deepEqual(resolveNavKeys(["ArrowDown", "Enter"]), { ok: true, keys: ["Down", "Enter"] });
  assert.deepEqual(resolveNavKeys(["down", "ENTER"]), { ok: true, keys: ["Down", "Enter"] });
  assert.deepEqual(resolveNavKeys([" Tab ", "space"]), { ok: true, keys: ["Tab", "Space"] });
  assert.deepEqual(resolveNavKeys(["esc"]), { ok: true, keys: ["Escape"] });
});

test("resolveNavKeys 认 C-a..C-z", () => {
  assert.deepEqual(resolveNavKeys(["C-c"]), { ok: true, keys: ["C-c"] });
  assert.deepEqual(resolveNavKeys(["c-a", "C-Z"]), { ok: true, keys: ["C-a", "C-z"] });
});

/**
 * 认不出的名字一律拒绝、一个都不送 —— 这个工具是往别人的会话里按键，猜错一个
 * 可能就确认了一个对话框。宁可让调用方看到报错重来，也不要送出一半。
 */
test("resolveNavKeys 拒绝认不出的按键，并列出可选项", () => {
  const r = resolveNavKeys(["ArrowDown", "PageDown"]);
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /PageDown/);
  assert.match((r as { message: string }).message, /ArrowDown/);
});

test("resolveNavKeys 拒绝空数组和非字符串项", () => {
  assert.equal(resolveNavKeys([]).ok, false);
  assert.equal(resolveNavKeys("Enter").ok, false);
  assert.equal(resolveNavKeys(undefined).ok, false);
  assert.equal(resolveNavKeys(["Enter", 3]).ok, false);
});

function navHarness() {
  const h = harness({ live: [info("pi-a", { idle_ms: 60_000 })] });
  h.registry.add({
    session: "pi-a",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  return h;
}

test("nav 逐个送键，顺序不变，且用 --key 而不是 --text", async () => {
  const h = navHarness();
  const r = await h.tools.nav({ session: "pi-a", keys: ["ArrowDown", "Enter"] });
  assert.equal(r.isError, undefined, r.text);

  const keyCalls = h.calls.filter((c) => c[0] === "send" && c.includes("--key"));
  assert.deepEqual(
    keyCalls.map((c) => c[c.indexOf("--key") + 1]),
    ["Down", "Enter"],
    "顺序必须和调用方给的一致",
  );
  assert.equal(deliveries(h).length, 0, "nav 绝不能走 --text");
  h.watchers.stopAll();
});

/**
 * 一次 asd 调用送一串（`--key a,b,c`）会让所有按键挤在同一个 payload 里到达，
 * TUI 那套"一大坨字节 = 粘贴"的判定会再咬一次；而且对话框来不及重绘。
 */
test("nav 每个键一次 asd 调用 —— 不用逗号把一串挤进一个 payload", async () => {
  const h = navHarness();
  await h.tools.nav({ session: "pi-a", keys: ["Down", "Down", "Enter"] });
  const keyCalls = h.calls.filter((c) => c[0] === "send" && c.includes("--key"));
  assert.equal(keyCalls.length, 3, "三个键就该有三次调用");
  for (const c of keyCalls) {
    assert.doesNotMatch(c[c.indexOf("--key") + 1]!, /,/, "单次调用里不该出现逗号分隔的一串");
  }
  h.watchers.stopAll();
});

test("nav 把按完之后的屏幕一并返回 —— 省掉调用方再 peek 一次", async () => {
  const h = navHarness();
  const r = await h.tools.nav({ session: "pi-a", keys: ["Enter"] });
  assert.match(r.text, /按键之后的屏幕/);
  assert.match(r.text, /SCREEN:pi-a/);
  h.watchers.stopAll();
});

test("nav 与 steer 并发写同一 session 时共用输入预留", async () => {
  const h = navHarness();
  const [navigated, steered] = await Promise.all([
    h.tools.nav({ session: "pi-a", keys: ["ArrowDown", "Enter"] }),
    h.tools.steer({ session: "pi-a", message: "继续执行" }),
  ]);

  assert.equal([navigated, steered].filter((r) => r.isError === undefined).length, 1);
  assert.equal([navigated, steered].filter((r) => r.isError === true).length, 1);
  assert.match(
    [navigated, steered].find((r) => r.isError === true)!.text,
    /正在被另一次输入处理/,
  );
  assert.equal(deliveries(h).length, 0, "nav 已占住 session 时 steer 不能再写正文");
  assert.equal(enterKeys(h).length, 2, "只有 nav 的两个按键可以送出");
  h.watchers.stopAll();
});

test("两个 nav 并发操作同一 session 时只有一串按键进入 TUI", async () => {
  const h = navHarness();
  const [first, second] = await Promise.all([
    h.tools.nav({ session: "pi-a", keys: ["ArrowDown", "Enter"] }),
    h.tools.nav({ session: "pi-a", keys: ["ArrowUp", "Enter"] }),
  ]);

  assert.equal([first, second].filter((r) => r.isError === undefined).length, 1);
  assert.equal([first, second].filter((r) => r.isError === true).length, 1);
  assert.match(
    [first, second].find((r) => r.isError === true)!.text,
    /正在被另一次输入处理/,
  );
  const keyCalls = h.calls.filter((c) => c[0] === "send" && c.includes("--key"));
  assert.deepEqual(
    keyCalls.map((c) => c[c.indexOf("--key") + 1]),
    ["Down", "Enter"],
    "两串按键不能穿插",
  );
  h.watchers.stopAll();
});

test("nav 认不出按键时一个都不送，也不碰 asd", async () => {
  const h = navHarness();
  const before = h.calls.length;
  const r = await h.tools.nav({ session: "pi-a", keys: ["ArrowDown", "F13"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /F13/);
  assert.equal(h.calls.length, before, "校验不过的路径上一次 asd 调用都不该有");
});

test("nav 拒绝台账外的 session —— 发送按键仍要求先纳入监视", async () => {
  const h = harness({ live: [info("someone-else", { idle_ms: 60_000 })] });
  const r = await h.tools.nav({ session: "someone-else", keys: ["Enter"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /不在 pi-asd 监视列表里/);
  assert.equal(h.calls.length, 0);
});

// --- prefix 覆盖 & persistent ---

test("spawn 传 prefix:\"\" 就不加前缀 —— 想要 nvr 而不是 pi-nvr", async () => {
  const h = harness();
  const r = await h.tools.spawn({ task: "t", name: "nvr", prefix: "" });
  assert.equal(r.isError, undefined, r.text);
  assert.deepEqual(h.registry.names(), ["nvr"]);
  h.watchers.stopAll();
});

test("spawn 传自定义 prefix 就用它", async () => {
  const h = harness();
  await h.tools.spawn({ task: "t", name: "nvr", prefix: "ops-" });
  assert.deepEqual(h.registry.names(), ["ops-nvr"]);
  h.watchers.stopAll();
});

/**
 * 这里的空串语义和 parseBossDefault / parseDuration **故意相反**：那些读的是
 * 环境变量/配置，空串多半是 .env 空行之类的意外；这个是调用方在一次 spawn 里
 * 显式传的参数，写 "" 就是真的要一个光名字。
 */
test("不传 prefix 时仍然用全局前缀 —— 空串和「没传」不是一回事", async () => {
  const h = harness();
  await h.tools.spawn({ task: "t", name: "nvr" });
  assert.deepEqual(h.registry.names(), ["pi-nvr"], "没传就该带上默认的 pi-");
  h.watchers.stopAll();
});

test("spawn 的 persistent 会记进台账，默认 false", async () => {
  const h1 = harness();
  await h1.tools.spawn({ task: "t", name: "nvr", persistent: true });
  assert.equal(h1.registry.get("pi-nvr")?.persistent, true);
  h1.watchers.stopAll();

  const h2 = harness();
  await h2.tools.spawn({ task: "t", name: "tmp" });
  assert.equal(h2.registry.get("pi-tmp")?.persistent, false, "不传就是普通员工");
  h2.watchers.stopAll();
});

test("agents 列表标出 persistent —— boss 要知道谁不会被回收", async () => {
  const h = harness({ live: [info("pi-nvr", { idle_ms: 60_000 })] });
  h.registry.add({
    session: "pi-nvr",
    task: "长期负责 NVR",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
    persistent: true,
  });
  const r = await h.tools.agents();
  assert.match(r.text, /persistent/);
});

// --- asd_unmonitor：不再监视，但不结束 session ---
//
// 和 kill 的分界：
//   kill    结束进程。只能结束 pi-asd 自己创建的。
//   unmonitor 进程照跑，只是 pi-asd 不再监视 —— 不挂 watcher、不进 asd_agents、
//           Reaper 也不再考虑它（那两处都读台账，摘掉即生效）。

function adoptedHarness() {
  const h = harness({
    live: [info("mem", { command: "claude", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    screenPrefix: "› ",
  });
  return h;
}

test("unmonitor 摘掉台账记录，但一次 asd kill 都不发生", async () => {
  const h = adoptedHarness();
  await h.tools.spawn({ task: "查一下", session: "mem", watch: false });
  assert.ok(h.registry.get("mem") !== undefined, "先确认收养成功");

  const before = h.calls.length;
  const r = await h.tools.unmonitor({ session: "mem" });

  assert.equal(r.isError, undefined, r.text);
  assert.equal(h.registry.get("mem"), undefined, "台账里应当没有了");
  assert.ok(!subcommands(h).slice(before).includes("kill"), "绝不能 kill —— 那是另一个工具");
  assert.match(r.text, /没有被结束|还在跑/);
});

test("unmonitor 之后 asd_agents 不再列出它", async () => {
  const h = adoptedHarness();
  await h.tools.spawn({ task: "查一下", session: "mem", watch: false });
  const listed = await h.tools.agents();
  assert.match(listed.text, /mem/, "解除之前应当列出来");

  await h.tools.unmonitor({ session: "mem" });
  const after = await h.tools.agents();
  assert.doesNotMatch(after.text, /mem/);
});

test("unmonitor 会停掉挂着的 watcher", async () => {
  const h = adoptedHarness();
  await h.tools.spawn({ task: "查一下", session: "mem" }); // watch 默认 true
  assert.equal(h.watchers.isWatching("mem"), true, "先确认 watcher 挂上了");

  await h.tools.unmonitor({ session: "mem" });
  assert.equal(h.watchers.isWatching("mem"), false, "解除追踪就不该还盯着它");
});

/**
 * Reaper 读的是台账，摘掉即生效 —— 不需要 Reaper 那边改任何代码。
 * 这条用例把这个隐含依赖钉住，免得以后有人给 Reaper 换个数据源就悄悄破坏它。
 */
test("unmonitor 之后 Reaper 不再回收它（哪怕闲到天荒地老）", async () => {
  const h = harness({ live: [info("pi-a", { idle_ms: 900_000 })] });
  h.registry.add({
    session: "pi-a",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  assert.deepEqual(
    sessionsToReap(h.registry, { live: [info("pi-a", { idle_ms: 900_000 })], idleKillMs: 120_000 }),
    ["pi-a"],
    "解除之前是会被回收的",
  );

  await h.tools.unmonitor({ session: "pi-a" });
  assert.deepEqual(
    sessionsToReap(h.registry, { live: [info("pi-a", { idle_ms: 900_000 })], idleKillMs: 120_000 }),
    [],
    "摘掉之后 Reaper 不该再动它",
  );
});

test("unmonitor 之后还能再次指名交给它 —— 重新收养", async () => {
  const h = adoptedHarness();
  await h.tools.spawn({ task: "第一次", session: "mem", watch: false });
  await h.tools.unmonitor({ session: "mem" });
  assert.equal(h.registry.get("mem"), undefined);

  const again = await h.tools.spawn({ task: "第二次", session: "mem", watch: false });
  assert.equal(again.isError, undefined, again.text);
  assert.equal(h.registry.get("mem")?.task, "第二次");
  assert.equal(h.registry.get("mem")?.createdByUs, false);
});

test("unmonitor 台账和 watcher 都没有的名字 → 报错且不碰 asd", async () => {
  const h = harness();
  const r = await h.tools.unmonitor({ session: "ghost" });
  assert.equal(r.isError, true);
  assert.match(r.text, /本来就没在监视/);
  assert.doesNotMatch(r.text, /当前监视中/, "registry 清单会漏掉 watcher-only session，不能冒充完整清单");
  assert.equal(h.calls.length, 0);
});

test("unmonitor 报错时不拿 registry 冒充完整监视清单", async () => {
  const h = harness({ live: [info("mem")] });
  h.watchers.watch("mem");

  const r = await h.tools.unmonitor({ session: "ghost" });

  assert.equal(r.isError, true);
  assert.match(r.text, /本来就没在监视 "ghost"/);
  assert.doesNotMatch(r.text, /当前监视中：.*空/s);
  h.watchers.stopAll();
});

test("unmonitor 可以停止 follow 给台账外 session 挂的后台 watcher", async () => {
  const h = harness({ live: [info("mem")] });
  h.watchers.watch("mem");

  const r = await h.tools.unmonitor({ session: "mem" });

  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /已停止后台监视/);
  assert.match(r.text, /session 本身没有被结束/);
  assert.equal(h.watchers.isWatching("mem"), false);
  assert.equal(h.registry.get("mem"), undefined);
  assert.deepEqual(subcommands(h), ["follow"], "停止监视不能 kill 或发送输入");
});

/**
 * 对自己创建的 session 解除追踪是一扇单向门：再次收养会以 createdByUs:false 记账，
 * 从此 asd_kill 永远拒绝它（那道闸门认的是台账里的标记，不是历史）。这个后果必须
 * 在返回文案里说清楚，并指向更合适的工具。
 */
test("对自己创建的 session 停止监视时，要警告 kill 权会永久失去", async () => {
  const h = harness({ live: [info("pi-a", { idle_ms: 60_000 })] });
  h.registry.add({
    session: "pi-a",
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  const r = await h.tools.unmonitor({ session: "pi-a" });
  assert.equal(r.details?.wasCreatedByUs, true);
  assert.match(r.text, /asd_kill 永远拒绝/);
  assert.match(r.text, /persistent/, "要指向真正合适的那个工具");
});

test("对指名交过任务的 session 停止监视，不发那条警告 —— 它本来就不能 kill", async () => {
  const h = adoptedHarness();
  await h.tools.spawn({ task: "查一下", session: "mem", watch: false });
  const r = await h.tools.unmonitor({ session: "mem" });
  assert.equal(r.details?.wasCreatedByUs, false);
  assert.doesNotMatch(r.text, /asd_kill 永远拒绝/);
});


// --- agents 不能让人误以为它能判断成败 ---
//
// 用户实测：boss 看到 `idle 3m` 就当作"做完了/失败了"，判断不了就**反复重发任务**。
// 根子是这个工具只有终端活动元数据，却用 `idle` 这个词暗示了完成度。

test("状态词用「安静」而不是「idle」—— 后者暗示「闲着=做完了」", async () => {
  const h = harness({ live: [info("pi-a", { running: false, idle_ms: 180_000 })] });
  h.registry.add({ session: "pi-a", task: "t", cwd: "/w", agent: "pi", createdAt: 0, createdByUs: true });
  const r = await h.tools.agents();
  assert.match(r.text, /安静 3m/);
  assert.doesNotMatch(r.text, /\bidle\b/);
});

test("每个 agent 带上屏幕最后一行当凭据 —— 那才是「它到底干了什么」", async () => {
  const h = harness({ live: [info("pi-a", { idle_ms: 60_000 })] });
  h.registry.add({ session: "pi-a", task: "t", cwd: "/w", agent: "pi", createdAt: 0, createdByUs: true });
  const r = await h.tools.agents();
  assert.match(r.text, /屏幕最后一行/);
});

test("明说「安静不代表做成了、别据此重发任务」", async () => {
  const h = harness({ live: [info("pi-a", { idle_ms: 60_000 })] });
  h.registry.add({ session: "pi-a", task: "t", cwd: "/w", agent: "pi", createdAt: 0, createdByUs: true });
  const r = await h.tools.agents();
  assert.match(r.text, /不代表任务做成了/);
  assert.match(r.text, /不要因为看着安静就重发任务/);
  assert.match(r.text, /asd_peek/, "要指出该走哪一步才拿得到真凭据");
});

/**
 * 卡在对话框上是**最容易被误判成失败**的状态：终端静止、任务没进展。
 * 而重发任务对它完全无用 —— 对话框会把重发的文本一起吃掉。必须单独标出来。
 */
test("卡在对话框上的单独标出来，并说明重发没用", async () => {
  const dialog = " ❯ 1. Yes, I trust this folder\n   2. No, exit\n Enter to confirm · Esc to cancel";
  const h = harness({ live: [info("pi-a", { idle_ms: 60_000 })], stuckOnDialog: true });
  h.registry.add({ session: "pi-a", task: "t", cwd: "/w", agent: "pi", createdAt: 0, createdByUs: true });
  void dialog;
  const r = await h.tools.agents();
  assert.match(r.text, /卡在对话框上/);
  assert.match(r.text, /重发任务没用|重发没用/);
  assert.match(r.text, /asd_nav/);
  assert.equal(r.details?.blocked, 1);
});

test("一个 peek 失败不该搞掉整张表", async () => {
  const h = harness({ live: [info("pi-a", { idle_ms: 60_000 })], peekThrows: true });
  h.registry.add({ session: "pi-a", task: "t", cwd: "/w", agent: "pi", createdAt: 0, createdByUs: true });
  const r = await h.tools.agents();
  assert.equal(r.isError, undefined);
  assert.match(r.text, /pi-a/, "拿不到屏幕也要把这一行列出来");
});

// --- asd_rename：改名，进程和屏幕都不动 ---
//
// 台账是按名字索引的，所以改完必须把记录和 watcher 一起搬过去，否则 pi-asd 跟丢：
// asd_agents 显示一个不存在的旧名字，kill / Reaper 全部对不上。

function renameHarness(o: { renameOutcome?: "ok" | "gone" | "unsupported" | "failed" } = {}) {
  const h = harness({ live: [info("pi-nvr", { idle_ms: 60_000 })], ...o });
  h.registry.add({
    session: "pi-nvr",
    task: "长期负责 NVR",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  return h;
}

test("rename 改完把台账记录搬到新名字下", async () => {
  const h = renameHarness();
  const r = await h.tools.rename({ session: "pi-nvr", newName: "nvr" });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(h.registry.get("pi-nvr"), undefined, "旧名字不该还在");
  assert.equal(h.registry.get("nvr")?.task, "长期负责 NVR", "记录内容要跟过去");
  assert.equal(h.registry.get("nvr")?.session, "nvr", "记录里的 session 字段也要更新");
  h.watchers.stopAll();
});

test("rename 会把 watcher 跟着挂到新名字上", async () => {
  const h = renameHarness();
  h.watchers.watch("pi-nvr");
  assert.equal(h.watchers.isWatching("pi-nvr"), true);

  await h.tools.rename({ session: "pi-nvr", newName: "nvr" });
  assert.equal(h.watchers.isWatching("pi-nvr"), false, "旧名字上不该还挂着");
  assert.equal(h.watchers.isWatching("nvr"), true, "要挂到新名字上");
  h.watchers.stopAll();
});

test("原本没挂 watcher 的，改名后也不会凭空挂上", async () => {
  const h = renameHarness();
  const r = await h.tools.rename({ session: "pi-nvr", newName: "nvr" });
  assert.equal(h.watchers.isWatching("nvr"), false);
  assert.equal(r.details?.watching, false);
});

/**
 * 先改 asd、成功了再动台账。反过来的话 asd 那边失败了、台账已经指向一个不存在的
 * 名字，比不改还糟。
 */
test("asd 那边失败时台账一动不动", async () => {
  const h = renameHarness({ renameOutcome: "failed" });
  const r = await h.tools.rename({ session: "pi-nvr", newName: "nvr" });
  assert.equal(r.isError, true);
  assert.match(r.text, /改名失败/);
  assert.ok(h.registry.get("pi-nvr") !== undefined, "旧记录必须原样保留");
  assert.equal(h.registry.get("nvr"), undefined);
});

/**
 * 装的 asd 太老没有 rename 子命令时，要说"去升级 asd"，而不是让用户以为名字有问题。
 * clap 对认不出的子命令用退出码 2。
 */
test("asd 太老没有 rename 子命令时，报错要指向升级而不是名字", async () => {
  const h = renameHarness({ renameOutcome: "unsupported" });
  const r = await h.tools.rename({ session: "pi-nvr", newName: "nvr" });
  assert.equal(r.isError, true);
  assert.match(r.text, /不支持 rename 子命令/);
  assert.match(r.text, /升级 asd/);
  assert.match(r.text, /asd ui.*按 r/, "要给出当下就能用的替代办法");
  assert.ok(h.registry.get("pi-nvr") !== undefined);
});

test("session 已经不在了：清掉记录并如实说", async () => {
  const h = renameHarness({ renameOutcome: "gone" });
  const r = await h.tools.rename({ session: "pi-nvr", newName: "nvr" });
  assert.equal(r.isError, true);
  assert.match(r.text, /已经不在了/);
  assert.equal(h.registry.get("pi-nvr"), undefined);
});

/**
 * 台账里已经有新名字时必须先拦下来：让 asd 改成功、这边却搬不过去，会覆盖掉
 * 另一条记录，那个 agent 就凭空从监视列表里消失了。
 */
test("新名字在监视列表里已被占用 → 拦下来，一次 asd 调用都不发", async () => {
  const h = renameHarness();
  h.registry.add({
    session: "nvr",
    task: "别人",
    cwd: "/w2",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
  });
  const before = h.calls.length;
  const r = await h.tools.rename({ session: "pi-nvr", newName: "nvr" });
  assert.equal(r.isError, true);
  assert.match(r.text, /已经有/);
  assert.equal(h.calls.length, before, "拦下的路径上不该碰 asd");
  assert.equal(h.registry.get("nvr")?.task, "别人", "另一条记录必须原封不动");
});

test("rename 拒绝监视列表外的名字和空新名", async () => {
  const h = renameHarness();
  const a = await h.tools.rename({ session: "ghost", newName: "x" });
  assert.equal(a.isError, true);
  assert.match(a.text, /不在监视列表里/);

  const b = await h.tools.rename({ session: "pi-nvr", newName: "   " });
  assert.equal(b.isError, true);
  assert.match(b.text, /不能为空/);
});
