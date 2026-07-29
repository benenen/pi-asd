import { test } from "node:test";
import assert from "node:assert/strict";
import { createAsd, type Exec, type ExecResult, type SessionInfo } from "../extensions/asd/cli.ts";
import { Registry } from "../extensions/asd/registry.ts";
import { WatcherPool } from "../extensions/asd/watcher.ts";
import {
  agentOfCommand,
  buildSpawnCommand,
  createTools,
  shellEscape,
  type Tools,
} from "../extensions/asd/tools.ts";

interface Harness {
  tools: Tools;
  registry: Registry;
  watchers: WatcherPool;
  calls: string[][];
  /** asd list 会吐出来的 session。 */
  live: SessionInfo[];
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
  o: { live?: SessionInfo[]; cards?: ReturnType<typeof card>[]; bossSession?: string; newEchoes?: string } = {},
): Harness {
  const calls: string[][] = [];
  const live = o.live ?? [];

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
      case "peek":
        return ok(`SCREEN:${args[1]}`);
      case "send":
        return ok();
      case "kill":
        return ok();
      case "follow":
        return new Promise<ExecResult>(() => {});
      default:
        throw new Error(`没准备好的子命令：${args.join(" ")}`);
    }
  };

  const asd = createAsd(exec);
  const registry = new Registry("pi-");
  const watchers = new WatcherPool({ asd, notify: () => {}, timeout: "30m", now: () => 0 });
  const tools = createTools({
    asd,
    registry,
    watchers,
    config: {
      defaultAgent: "pi",
      defaultCwd: "/w",
      followTimeout: "30m",
      parentSession: "/s.jsonl",
      bossSession: o.bossSession,
    },
    now: () => 0,
  });

  return { tools, registry, watchers, calls, live };
}

/** 这次跑过的 asd 子命令名。 */
function subcommands(h: Harness): string[] {
  return h.calls.map((c) => c[0]);
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
        return ok(`SCREEN:${args[1]}`);
      case "send":
        return ok();
      case "kill":
        return ok();
      case "follow":
        return new Promise<ExecResult>(() => {});
      default:
        throw new Error(`没准备好的子命令：${args.join(" ")}`);
    }
  };

  const asd = createAsd(exec);
  const registry = new Registry("pi-");
  const watchers = new WatcherPool({ asd, notify: () => {}, timeout: "30m", now: () => 0 });
  const tools = createTools({
    asd,
    registry,
    watchers,
    config: { defaultAgent: "pi", defaultCwd: "/w", followTimeout: "30m", parentSession: "/s.jsonl" },
    now: () => 0,
  });

  return { tools, registry, watchers, calls, live };
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
  assert.deepEqual(subcommands(h), ["list", "send", "follow"]);
  assert.equal(h.registry.get("pi-agent1")?.task, "新任务");
  assert.equal(h.watchers.isWatching("pi-agent1"), true);
  h.watchers.stopAll();
});

// C1 回归：收养过的用户 session 记进台账时 createdByUs 是 false —— 一次
// **没有点名**任何 session 的普通 asd_spawn 绝不能把它当成自己人自动复用。
// 复现的是审查报告里那个场景：boss 先指名收养了 "mem"，之后再随手 spawn 一个
// 没点名的任务，如果 pickReusable 只看 agent/cwd/running，"mem" 会被当成
// 空闲的自己人，任务被 send 进用户正在用的终端。
test("spawn 不会把收养来的用户 session 自动复用 —— 即使 agent/cwd 都匹配、且空闲", async () => {
  const h = harness({ live: [info("mem", { running: false, command: "claude", idle_ms: 999_999 })] });
  h.registry.add({
    session: "mem",
    task: "上一轮收养的任务",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: false,
  });

  const r = await h.tools.spawn({ task: "新任务，没点名任何 session" });
  assert.equal(r.isError, undefined, r.text);
  assert.ok(
    subcommands(h).includes("new"),
    "台账里唯一匹配的候选是收养来的，必须走新建，不能走 send",
  );
  assert.ok(!subcommands(h).includes("send"), "绝不能把任务 send 进收养来的用户 session");
  assert.equal(h.registry.get("mem")?.task, "上一轮收养的任务", "收养记录的任务不该被这次 spawn 覆盖");
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
  assert.deepEqual(subcommands(h), ["send", "follow"]);
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

  const asd = createAsd(exec);
  const registry = new Registry("pi-");
  const watchers = new WatcherPool({ asd, notify: () => {}, timeout: "30m", now: () => 0 });
  const tools = createTools({
    asd,
    registry,
    watchers,
    config: { defaultAgent: "pi", defaultCwd: "/w", followTimeout: "30m" },
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
  assert.equal(r.text, "SCREEN:pi-a");
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

test("candidates 里已经收养过的 session（在台账里但 createdByUs=false）仍然标不能 kill", async () => {
  const h = harness({
    live: [info("mem", { running: false, command: "claude" })],
    cards: [card("mem", "/w/mem")],
  });
  // 模拟"已经被收养过一次"：在台账里，但不是我们建的。
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

test("spawn 指名收养：送任务、以 createdByUs=false 记账、挂 watcher", async () => {
  const h = harness({
    live: [info("mem", { running: false, command: "claude --dangerously-skip-permissions" })],
    cards: [card("mem", "/w/mem", ["README.md"])],
  });
  const r = await h.tools.spawn({ task: "查一下这个", session: "mem" });
  assert.equal(r.isError, undefined, r.text);
  assert.ok(subcommands(h).includes("send"));
  assert.ok(!subcommands(h).includes("new"), "收养不该新建 session");
  const rec = h.registry.get("mem");
  assert.equal(rec?.createdByUs, false);
  assert.equal(rec?.agent, "claude");
  assert.equal(rec?.cwd, "/w/mem");
  assert.match(r.text, /不会结束它|不是 pi-asd 建的/);
  assert.equal(h.watchers.isWatching("mem"), true);
  h.watchers.stopAll();
});

test("spawn 拒绝收养正在干活的 session，且不发送任何东西", async () => {
  const h = harness({
    live: [info("busy", { running: true, command: "claude" })],
    cards: [card("busy", "/w")],
  });
  const r = await h.tools.spawn({ task: "t", session: "busy" });
  assert.equal(r.isError, true);
  assert.ok(!subcommands(h).includes("send"));
  assert.equal(h.registry.size, 0);
});

test("spawn 拒绝收养裸 shell —— 任务描述会被当命令执行", async () => {
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

test("spawn 拒绝收养 asd 里不存在的 session", async () => {
  const h = harness();
  const r = await h.tools.spawn({ task: "t", session: "ghost" });
  assert.equal(r.isError, true);
  assert.ok(!subcommands(h).includes("send"));
});

// M5：代码层面兜底，不能收养 boss 自己所在的 session。提示词里也这么说，但
// 那只是"建议"——config.bossSession 是 index.ts 从 $ASD_SESSION 读出来注入
// 的，tools.ts 自己不读 process.env（保持依赖注入边界）。
test("spawn 拒绝收养 boss 自己所在的 session，且完全不碰 asd", async () => {
  const h = harness({
    bossSession: "boss-self",
    live: [info("boss-self", { running: false, command: "claude" })],
    cards: [card("boss-self", "/w")],
  });
  const r = await h.tools.spawn({ task: "t", session: "boss-self" });
  assert.equal(r.isError, true);
  assert.match(r.text, /自己|不能收养自己/);
  assert.deepEqual(h.calls, [], "拒绝路径上不该有任何 asd 调用");
  assert.equal(h.registry.size, 0);
});

test("收养来的 session 永远不能被 kill —— 守卫承重", async () => {
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

test("并发指名收养同一个 session：只有一次真正送达，另一次被屏障挡下", async () => {
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
  assert.equal(ok.length, 1, "两次并发收养同一个 session，只能有一次真正成功");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].text, /正在被另一次 spawn 处理/);
  assert.equal(
    subcommands(h).filter((c) => c === "send").length,
    1,
    "只应该真正 send 一次 —— 不能把两段不相关的任务文本都敲进目标 session",
  );
  h.watchers.stopAll();
});

test("收养的早退路径（目标正忙）之后，预留会被释放，下一次仍能真正送达", async () => {
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
  assert.equal(subs.filter((c) => c === "send").length, 1, "应该恰好一次复用（send）");
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
        return ok(`SCREEN:${args[1]}`);
      case "send":
        return ok();
      case "kill":
        return ok();
      case "follow":
        return new Promise<ExecResult>(() => {});
      default:
        throw new Error(`没准备好的子命令：${args.join(" ")}`);
    }
  };

  const asd = createAsd(exec);
  const registry = new Registry("pi-");
  const watchers = new WatcherPool({ asd, notify: () => {}, timeout: "30m", now: () => 0 });
  const tools = createTools({
    asd,
    registry,
    watchers,
    config: { defaultAgent: "pi", defaultCwd: "/w", followTimeout: "30m", parentSession: "/s.jsonl" },
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
