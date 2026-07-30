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
  shellEscape,
  withAlias,
  withEnv,
  type AgentPreset,
  type Tools,
} from "../extensions/asd/tools.ts";
import { resolveWorkspaceBase } from "../extensions/asd/config.ts";

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
    /** 屏幕永远停在信任对话框上 —— 模拟"送了键也过不去"。 */
    stuckOnDialog?: boolean;
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
  /** peek 调用次数，给 startupScreens 排队用。 */
  let peeks = 0;
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
        if (o.stuckOnDialog) return ok("❯ 1. Yes, I trust this folder\n  2. No, exit");
        const startup = o.startupScreens ?? [];
        if (peeks < startup.length) return ok(startup[peeks++]!);
        peeks += 1;
        // 投递校验会 peek 确认文本进了输入框 —— 假屏幕必须模拟这个行为，
        // 否则每一次 deliver() 都会判成"没投进去"。
        const echoed = o.swallowText ? "" : (typed.get(args[1]!) ?? "");
        return ok(`SCREEN:${args[1]}\n${echoed}`);
      }
      case "send":
        if (args[2] === "--text") typed.set(args[1]!, args[3] ?? "");
        return ok();
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
        return ok(`SCREEN:${args[1]}\n${typed.get(args[1]!) ?? ""}`);
      case "send":
        if (args[2] === "--text") typed.set(args[1]!, args[3] ?? "");
        return ok();
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
  // deliver()：正文 → peek 校验 → 回车。中间那次 peek 就是投递校验，
  // 它是这次改动的重点，所以显式断言在序列里。
  assert.deepEqual(
    subcommands(h),
    ["list", "send", "peek", "send", "follow"],
    "一次送达 = 正文 send + 校验 peek + 回车 send",
  );
  assert.equal(deliveries(h).length, 1);
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
  assert.match(r.text, /running/);
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
  assert.deepEqual(
    subcommands(h),
    ["send", "peek", "send", "follow"],
    "一次送达 = 正文 send + 校验 peek + 回车 send",
  );
  assert.equal(deliveries(h).length, 1);
  assert.equal(h.watchers.isWatching("pi-a"), true);
  h.watchers.stopAll();
});

// M6：asd_follow 工具自己也会在同一个 session 上跑一个 `asd follow`——如果
// 不先停掉后台 watcher，两边同时在等同一个 session 的 follow 流，同一次停下
// 会被通知两遍。这里手动控制"工具自己发起的那次 follow"的解析时机，断言：
// 阻塞期间后台 watcher 已经被停掉；调用结束后按原来挂着的状态重挂。
test("follow 工具阻塞期间会先停掉后台 watcher，结束后按原状态重挂", async () => {
  const calls: string[][] = [];
  let resolveToolFollow: ((r: ExecResult) => void) | undefined;
  let followCallCount = 0;
  /** session → 最近一次 --text 送进去的内容，供假 peek 回显。 */
  const typed = new Map<string, string>();
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
    switch (args[0]) {
      case "list":
        // 空列表：spawn 这次要新建，不能让假 asd 已经"认识"一个同名的
        // "pi-a"，否则 allocateName 会为了避重把新 session 改叫 "pi-a-2"，
        // 后面所有对 "pi-a" 的断言都会对不上号。
        return ok(JSON.stringify([]));
      case "new":
        return ok(`${args[1]}\n`);
      case "peek":
        return ok("SCREEN");
      case "send":
        return ok();
      case "follow":
        followCallCount += 1;
        // 第一次 follow 是 spawn 挂上的后台 watcher —— 永远挂住，只用来让
        // "watcher 曾经挂着"这件事成立。第二次才是这个工具调用自己发起的，
        // 由测试手动放行，好卡在"已经发起、还没解析"这个窗口期断言。
        if (followCallCount === 1) return new Promise<ExecResult>(() => {});
        return new Promise<ExecResult>((resolve) => {
          resolveToolFollow = resolve;
        });
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
    config: { defaultAgent: "pi", workspaceBase: "/base", followTimeout: "30m" },
    mkdirp: async () => {},
    now: () => 0,
  });

  await tools.spawn({ task: "t", name: "a" });
  assert.equal(watchers.isWatching("pi-a"), true);

  const p = tools.follow({ session: "pi-a" });
  // JS 对 async 函数的语义：调用它会同步跑到第一个真正挂起的 await 为止 ——
  // follow() 里 watchers.stop() 在任何 await 之前，所以这里不需要等微任务，
  // 断言已经能成立。
  assert.equal(resolveToolFollow !== undefined, true, "工具自己的第二次 follow 应该已经发起");
  assert.equal(watchers.isWatching("pi-a"), false, "工具自己的 follow 在跑的时候，后台 watcher 必须先停掉");

  resolveToolFollow!({ stdout: "", stderr: "", code: 0 });
  const r = await p;
  assert.equal(r.isError, undefined, r.text);
  assert.equal(watchers.isWatching("pi-a"), true, "follow 工具调用结束后，应该按原来挂着的状态重挂");
  watchers.stopAll();
});

test("steer / peek / follow 对台账外的名字直接拒绝，不碰 asd", async () => {
  const h = harness();
  for (const r of [
    await h.tools.steer({ session: "mem", message: "x" }),
    await h.tools.peek({ session: "mem" }),
    await h.tools.follow({ session: "mem" }),
  ]) {
    assert.equal(r.isError, true);
  }
  assert.deepEqual(h.calls, []);
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
        return ok(`SCREEN:${args[1]}\n${typed.get(args[1]!) ?? ""}`);
      case "send":
        if (args[2] === "--text") typed.set(args[1]!, args[3] ?? "");
        return ok();
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
 * 核心回归：文本没进到 agent 屏幕上时必须**如实报错**，而且**绝不能按回车** ——
 * 此刻输入框里可能是别的东西（比如一个模态对话框），那一下回车会去确认它。
 */
test("回归：文本没出现在屏幕上 → 报错、不记台账、不按回车", async () => {
  const h = harness({
    live: [info("mem", { command: "claude", idle_ms: 60_000 })],
    cards: [card("mem", "/w/mem")],
    // 屏幕永远回显不出送进去的文本 —— 模拟"文本被别的 UI 吃了"
    swallowText: true,
  });
  const r = await h.tools.spawn({ task: "查一下新闻", session: "mem" });

  assert.equal(r.isError, true);
  assert.match(r.text, /任务未投递成功/);
  assert.match(r.text, /没有出现在/);
  assert.equal(h.registry.size, 0, "没投进去就不能记台账 —— 记了就等于宣称已派出");
  assert.equal(enterKeys(h).length, 0, "校验没过就绝不能按回车");
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
