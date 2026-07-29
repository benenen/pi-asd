import { test } from "node:test";
import assert from "node:assert/strict";
import type { Asd, FollowOutcome, SessionInfo } from "../extensions/asd/cli.ts";
import { formatDuration, WatcherPool } from "../extensions/asd/watcher.ts";

interface Harness {
  pool: WatcherPool;
  notes: string[];
  /** 放行某个 session 的 follow，交出结果。 */
  settle(session: string, outcome: FollowOutcome): void;
  /** 放行某个 session 悬着的 peek，交出屏幕内容。仅在 `pausePeek: true` 时有用。 */
  settlePeek(session: string, screen: string | null): void;
  /** 让某个 session 悬着的 peek 以异常收场。仅在 `pausePeek: true` 时有用。 */
  rejectPeek(session: string, err: Error): void;
  followCalls: string[];
  peekCalls: string[];
  clock: { t: number };
}

/**
 * 假 asd：follow 会挂住，直到测试自己调 settle() 放行 —— 这样"watcher 在等"
 * 和"watcher 已经回调完"两个阶段可以分开断言。
 *
 * `pausePeek: true` 时 peek 同样会挂住，直到测试调 settlePeek()/rejectPeek() ——
 * 这是为了能造出"follow 已经 settle、peek 还没回来"这个竞态窗口，不然 stop()
 * 在这个窗口期是否还生效根本测不出来。
 */
function harness(o: { peek?: string | null; pausePeek?: boolean } = {}): Harness {
  const pendingFollow = new Map<string, (out: FollowOutcome) => void>();
  const pendingPeek = new Map<string, { resolve: (s: string | null) => void; reject: (e: Error) => void }>();
  const followCalls: string[] = [];
  const peekCalls: string[] = [];
  const notes: string[] = [];
  const clock = { t: 0 };

  const asd = {
    async create() {
      throw new Error("用不到");
    },
    async list(): Promise<SessionInfo[]> {
      return [];
    },
    async cards() {
      return [];
    },
    async peek(name: string) {
      peekCalls.push(name);
      if (o.pausePeek) {
        return new Promise<string | null>((resolve, reject) => pendingPeek.set(name, { resolve, reject }));
      }
      return o.peek === undefined ? "SCREEN" : o.peek;
    },
    async send() {
      return true;
    },
    async follow(name: string) {
      followCalls.push(name);
      return new Promise<FollowOutcome>((resolve) => pendingFollow.set(name, resolve));
    },
    async kill() {
      return true;
    },
  } satisfies Asd;

  const pool = new WatcherPool({
    asd,
    notify: (t) => notes.push(t),
    timeout: "30m",
    now: () => clock.t,
  });

  return {
    pool,
    notes,
    followCalls,
    peekCalls,
    clock,
    settle(session, outcome) {
      const resolve = pendingFollow.get(session);
      if (!resolve) throw new Error(`${session} 上没有在等的 follow`);
      pendingFollow.delete(session);
      resolve(outcome);
    },
    settlePeek(session, screen) {
      const p = pendingPeek.get(session);
      if (!p) throw new Error(`${session} 上没有在等的 peek`);
      pendingPeek.delete(session);
      p.resolve(screen);
    },
    rejectPeek(session, err) {
      const p = pendingPeek.get(session);
      if (!p) throw new Error(`${session} 上没有在等的 peek`);
      pendingPeek.delete(session);
      p.reject(err);
    },
  };
}

/**
 * 反复让出一个微任务，直到 predicate 为真，或者试够了次数还没等到。
 * 没有真实计时器，纯粹排空微任务队列，用来在 fire-and-forget 的异步链路
 * 跑到我们想断言的那个中间状态时截住它 —— 比固定次数的 `await Promise.resolve()`
 * 更稳，不用去数链路里到底有几跳 await。
 */
async function waitFor(predicate: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`waitFor：条件在 ${tries} 个微任务内都没满足`);
}

/** 纯粹排空 N 个微任务，用来等一条我们确认无法通过 predicate 观察的异步链路跑完。 */
async function flushMicrotasks(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

test("formatDuration 按秒/分/时给出紧凑写法", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(4_000), "4s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(252_000), "4m12s");
  assert.equal(formatDuration(3_600_000), "1h0m");
  assert.equal(formatDuration(5_430_000), "1h30m");
});

test("watch 挂上后 isWatching 为真，同一个 session 不重复挂", async () => {
  const h = harness();
  assert.equal(h.pool.watch("pi-a"), true);
  assert.equal(h.pool.isWatching("pi-a"), true);
  assert.equal(h.pool.watch("pi-a"), false);
  assert.deepEqual(h.followCalls, ["pi-a"]);
  h.pool.stopAll();
});

test("follow 停下来后 peek 一屏并通知，带上历时", async () => {
  const h = harness();
  h.pool.watch("pi-a");
  h.clock.t = 252_000;
  h.settle("pi-a", { kind: "settled", text: "过程" });
  await h.pool.idle();

  assert.deepEqual(h.peekCalls, ["pi-a"]);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /pi-a/);
  assert.match(h.notes[0], /4m12s/);
  assert.match(h.notes[0], /SCREEN/);
  assert.equal(h.pool.isWatching("pi-a"), false);
});

test("follow 超时时通知还在跑，且不再 peek", async () => {
  const h = harness();
  h.pool.watch("pi-a");
  h.settle("pi-a", { kind: "timeout", text: "" });
  await h.pool.idle();

  assert.deepEqual(h.peekCalls, []);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /仍在跑|还在跑/);
  assert.match(h.notes[0], /asd_follow/);
});

test("follow 报告 session 没了时通知已结束，且不 peek", async () => {
  const h = harness();
  h.pool.watch("pi-a");
  h.settle("pi-a", { kind: "gone" });
  await h.pool.idle();

  assert.deepEqual(h.peekCalls, []);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /已结束/);
});

test("stop 之后即使 follow 回来了也不通知", async () => {
  const h = harness();
  h.pool.watch("pi-a");
  h.pool.stop("pi-a");
  assert.equal(h.pool.isWatching("pi-a"), false);
  h.settle("pi-a", { kind: "settled", text: "" });
  await h.pool.idle();
  assert.deepEqual(h.notes, []);
});

test("stopAll 掐掉全部", async () => {
  const h = harness();
  h.pool.watch("pi-a");
  h.pool.watch("pi-b");
  h.pool.stopAll();
  assert.equal(h.pool.isWatching("pi-a"), false);
  assert.equal(h.pool.isWatching("pi-b"), false);
  h.settle("pi-a", { kind: "settled", text: "" });
  h.settle("pi-b", { kind: "settled", text: "" });
  await h.pool.idle();
  assert.deepEqual(h.notes, []);
});

test("停下后可以重新挂 —— steer 之后要靠这个", async () => {
  const h = harness();
  h.pool.watch("pi-a");
  h.settle("pi-a", { kind: "settled", text: "" });
  await h.pool.idle();
  assert.equal(h.pool.watch("pi-a"), true);
  assert.deepEqual(h.followCalls, ["pi-a", "pi-a"]);
  h.pool.stopAll();
});

test("peek 返回 null 时通知里说明 session 已消失", async () => {
  const h = harness({ peek: null });
  h.pool.watch("pi-a");
  h.settle("pi-a", { kind: "settled", text: "" });
  await h.pool.idle();
  assert.match(h.notes[0], /已消失/);
});

// --- C2 回归：冷启动的 agent 还没吐出第一帧时，settle+空屏不能被当成"已经
// 停下" ---
//
// 复现的是审查报告里的场景：`asd follow` 的"安静了 2 秒"判定是从订阅那一刻
// 起算的，不是从 agent 真正开始产出算的 —— 一个新建/刚重挂的 session 如果
// 冷启动比较慢（尤其并发 spawn 一堆时），第一次 follow 很可能在它连第一帧
// 都还没画出来的时候就 settle，peek 回来是空屏。旧实现会把这个"还没开始"
// 误判成"已经停下"，报给 boss 一个空屏，然后 watcher 永久摘掉 —— 真正的
// 完成永远不会被推送。

test("follow 立刻 settled 且 peek 为空：不通知「已停下」，watcher 仍然挂着，并且自己重挂了一次", async () => {
  const h = harness({ pausePeek: true });
  h.pool.watch("pi-a");
  await waitFor(() => h.followCalls.length === 1);

  h.settle("pi-a", { kind: "settled", text: "" });
  await waitFor(() => h.peekCalls.length === 1);
  h.settlePeek("pi-a", ""); // 屏幕真的是空的 —— agent 还没来得及画第一帧。

  // 冷启动止损应该自己重挂一次，而不是通知"已停下"。isWatching() 全程保持
  // true（#finish 和内部 watch() 之间没有任何 await），notes 仍然是空的。
  await waitFor(() => h.followCalls.length === 2);
  assert.deepEqual(h.notes, [], "屏幕还是空的，不该报「已停下」");
  assert.equal(h.pool.isWatching("pi-a"), true, "重挂之后 watcher 仍然算挂着");
  assert.deepEqual(h.peekCalls, ["pi-a"], "还不该有第二次 peek —— 第二轮 follow 还没 settle");

  // agent 真的开始产出了，这次 settle 时屏幕不再是空的 —— 应该走正常的
  // "已停下"通知路径，而不是继续被当成冷启动重挂。
  h.settle("pi-a", { kind: "settled", text: "真正的输出" });
  await waitFor(() => h.peekCalls.length === 2);
  h.settlePeek("pi-a", "DONE-AWAITING-INPUT");
  await h.pool.idle();

  assert.equal(h.notes.length, 1, "这次是真的停下了，必须通知一次");
  assert.match(h.notes[0], /已停下/);
  assert.match(h.notes[0], /DONE-AWAITING-INPUT/);
  assert.equal(h.pool.isWatching("pi-a"), false);
});

test("冷启动止损有次数上限 —— 屏幕一直空着，重挂到上限后照常通知，不会无限重挂", async () => {
  const h = harness({ peek: "" }); // 屏幕永远是空的
  h.pool.watch("pi-a");

  // 每一轮都立刻 settle：一直空屏，逼它把重挂次数用完。不写死具体的上限
  // 数字，只证明"确实有上限"——外层循环给了远超预期的余量（20 轮），一旦
  // isWatching 变成 false 就说明真的走到了正常收尾，而不是无限重挂。
  let rounds = 0;
  for (let round = 1; round <= 20; round++) {
    await waitFor(() => h.followCalls.length === round);
    h.settle("pi-a", { kind: "settled", text: "" });
    await waitFor(() => h.followCalls.length > round || !h.pool.isWatching("pi-a"));
    rounds = round;
    if (!h.pool.isWatching("pi-a")) break;
  }

  assert.equal(h.notes.length, 1, "重挂次数到了上限之后必须正常通知一次，不能永远不通知");
  assert.match(h.notes[0], /已停下/);
  assert.equal(h.pool.isWatching("pi-a"), false);
  assert.ok(rounds < 20, "重挂次数应该在到达上限时自己停下，不是被外层循环的余量强行截断");
});

test("follow 已经 settle、peek 还没回来时调 stop —— 这个窗口期 stop 必须仍然生效", async () => {
  const h = harness({ pausePeek: true });
  h.pool.watch("pi-a");
  h.settle("pi-a", { kind: "settled", text: "" });
  // follow 已经 settled，但 peek 被我们卡住了 —— 这就是"结果已经拿到、
  // 还没来得及 notify"的窗口期。旧实现在 follow 一 resolve 就把 #running
  // 记录删了，这个窗口期里 stop() 会因为找不到 controller 变成静默 no-op。
  await waitFor(() => h.peekCalls.includes("pi-a"));

  h.pool.stop("pi-a");
  assert.equal(h.pool.isWatching("pi-a"), false);

  h.settlePeek("pi-a", "SCREEN");
  await h.pool.idle();

  assert.deepEqual(h.notes, []);
});

test("generation-1 停在 peek 窗口期时被 stop 并重新挂上 generation-2，generation-1 的异常不能抹掉 generation-2 的记录", async () => {
  const h = harness({ pausePeek: true });
  h.pool.watch("pi-a"); // generation 1
  h.settle("pi-a", { kind: "settled", text: "" });
  await waitFor(() => h.peekCalls.length === 1); // generation 1 的 peek 已经发出、还悬着

  // steer 场景：显式 stop 掉 generation 1（此时它的 peek 仍然没回来），
  // 紧接着重新挂 generation 2。
  h.pool.stop("pi-a");
  assert.equal(h.pool.watch("pi-a"), true); // generation 2 挂上
  assert.equal(h.pool.isWatching("pi-a"), true);

  // generation 1 的 peek 现在才用异常收场（cli.ts 里非 NO_SESSION 的非零退出码
  // 就是这样）。旧实现的 catch 块会无条件 `#running.delete(session)`，把刚
  // 注册的 generation 2 记录一起删掉，还会让 generation 1 补发一条通知。
  h.rejectPeek("pi-a", new Error("boom"));
  // generation 1 的 ctrl 已经被 abort 了，它的 catch 块应该在 `ctrl.signal.aborted`
  // 检查这一步就安静退出，不会继续跑到 #finish / notify —— 排空微任务等它跑完。
  await flushMicrotasks();

  assert.equal(h.pool.isWatching("pi-a"), true);
  assert.deepEqual(h.notes, []);

  h.pool.stopAll();
});

test("notify 自己抛异常时不会变成未处理 rejection，也不会挡住后续 watcher", async () => {
  const notifyCalls: string[] = [];
  const asd = {
    async create() {
      throw new Error("用不到");
    },
    async list(): Promise<SessionInfo[]> {
      return [];
    },
    async cards() {
      return [];
    },
    async peek() {
      return "SCREEN";
    },
    async send() {
      return true;
    },
    async follow(): Promise<FollowOutcome> {
      return { kind: "settled", text: "" };
    },
    async kill() {
      return true;
    },
  } satisfies Asd;

  const pool = new WatcherPool({
    asd,
    notify: (t) => {
      notifyCalls.push(t);
      throw new Error("notify 自己炸了");
    },
    timeout: "30m",
    now: () => 0,
  });

  const unhandled: unknown[] = [];
  const onUnhandledRejection = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    pool.watch("pi-a");
    await pool.idle();
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  assert.equal(notifyCalls.length, 1);
  assert.deepEqual(unhandled, []);
  // watcher 自己没被这次失败的 notify 卡住 —— session 收尾了，能重新挂。
  assert.equal(pool.isWatching("pi-a"), false);
  assert.equal(pool.watch("pi-a"), true);
  pool.stopAll();
});
