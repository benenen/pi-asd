import { test } from "node:test";
import assert from "node:assert/strict";
import { createAsd, type Exec, type ExecResult, type SessionInfo } from "../extensions/asd/cli.ts";
import { Registry } from "../extensions/asd/registry.ts";
import { WatcherPool } from "../extensions/asd/watcher.ts";
import { buildSpawnCommand, createTools, shellEscape, type Tools } from "../extensions/asd/tools.ts";

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

/**
 * 假 exec：按子命令决定回什么。live 数组由测试直接改，改完下一次 asd list 就生效。
 * follow 永远挂住不返回 —— watcher 的行为在 watcher.test.ts 里测过了，这里只关心
 * "有没有挂上"。
 */
function harness(o: { live?: SessionInfo[] } = {}): Harness {
  const calls: string[][] = [];
  const live = o.live ?? [];

  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
    switch (args[0]) {
      case "list":
        return ok(JSON.stringify(live));
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
    watching: false,
  });

  const r = await h.tools.spawn({ task: "新任务" });
  assert.match(r.text, /复用/);
  assert.deepEqual(subcommands(h), ["list", "send", "follow"]);
  assert.equal(h.registry.get("pi-agent1")?.task, "新任务");
  assert.equal(h.watchers.isWatching("pi-agent1"), true);
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
    watching: false,
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
    watching: false,
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
      watching: false,
    });
  }
  const r = await h.tools.agents();
  assert.match(r.text, /pi-a/);
  assert.match(r.text, /running/);
  assert.match(r.text, /已结束.*pi-b/s);
  assert.deepEqual(h.registry.names(), ["pi-a"]);
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
    watching: false,
  });
  const r = await h.tools.steer({ session: "pi-a", message: "换个思路" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(subcommands(h), ["send", "follow"]);
  assert.equal(h.watchers.isWatching("pi-a"), true);
  h.watchers.stopAll();
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
    watching: false,
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
    watching: false,
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
    watching: false,
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
    watching: false,
  });
  const r = await h.tools.kill({ session: "pi-borrowed" });
  assert.equal(r.isError, true);
  assert.match(r.text, /不是 pi-asd 新建/);
  assert.equal(h.calls.length, 0, "拒绝路径上不该有任何 asd 调用");
  assert.equal(h.registry.size, 1, "被拒绝的记录不该被摘掉");
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
    watching: false,
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
