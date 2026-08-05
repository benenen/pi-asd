import { test } from "node:test";
import assert from "node:assert/strict";
import type { Asd, FollowOutcome, SessionInfo } from "../extensions/asd/cli.ts";
import { formatDuration, WatcherPool } from "../extensions/asd/watcher.ts";

interface Harness {
  pool: WatcherPool;
  notes: string[];
  /** 放行某个 session 的 follow，交出结果。仅在 `instantFollow` 未设置时有用。 */
  settle(session: string, outcome: FollowOutcome): void;
  /** 放行某个 session 悬着的 peek，交出屏幕内容。仅在 `pausePeek: true` 时有用。 */
  settlePeek(session: string, screen: string | null): void;
  /** 让某个 session 悬着的 peek 以异常收场。仅在 `pausePeek: true` 时有用。 */
  rejectPeek(session: string, err: Error): void;
  followCalls: string[];
  peekCalls: string[];
  /** onGone 回调收到的 session，按顺序。 */
  goneCalls: string[];
  clock: { t: number };
}

/**
 * 假 asd：follow 会挂住，直到测试自己调 settle() 放行 —— 这样"watcher 在等"
 * 和"watcher 已经回调完"两个阶段可以分开断言。
 *
 * `pausePeek: true` 时 peek 同样会挂住，直到测试调 settlePeek()/rejectPeek() ——
 * 这是为了能造出"follow 已经 settle、peek 还没回来"这个竞态窗口，不然 stop()
 * 在这个窗口期是否还生效根本测不出来。
 *
 * `instantFollow` 设置时 follow 立刻自解（不进 pendingFollow，不用 settle()）——
 * 用来模拟真 asd 对一个已经安静的 session 的行为（C2 回归：这种 session
 * follow 是立即返回的，不是再等 2 秒）。
 *
 * `earlyRetryDelayMs` 透传给 WatcherPool，默认 0——测试不需要真的等
 * `EARLY_RETRY_DELAY_MS` 那么久；需要验证真实等待本身时才显式传一个很小的
 * 真实值。
 */
function harness(
  o: {
    peek?: string | null;
    pausePeek?: boolean;
    instantFollow?: FollowOutcome;
    earlyRetryDelayMs?: number;
    settleConfirmMs?: number;
  } = {},
): Harness {
  const pendingFollow = new Map<string, (out: FollowOutcome) => void>();
  const pendingPeek = new Map<string, { resolve: (s: string | null) => void; reject: (e: Error) => void }>();
  const followCalls: string[] = [];
  const peekCalls: string[] = [];
  const notes: string[] = [];
  const goneCalls: string[] = [];
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
    async sendText() {
      return true;
    },
    async key() {
      return true;
    },
    async rename() {
      return { kind: "ok" as const };
    },
    async follow(name: string) {
      followCalls.push(name);
      if (o.instantFollow !== undefined) return o.instantFollow;
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
    earlyRetryDelayMs: o.earlyRetryDelayMs ?? 0,
    // 默认不复核：这一组用例大多按 follow/peek 的调用序列断言，多一次复核 peek
    // 会全部错位。复核逻辑本身有自己的一组用例，见文件末尾「复核」那一节。
    settleConfirmMs: o.settleConfirmMs ?? 0,
    onGone: (s) => goneCalls.push(s),
  });

  return {
    pool,
    notes,
    followCalls,
    peekCalls,
    goneCalls,
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

/** 复核会走真实的短定时器；这组检查需要同时让出 timer 和微任务。 */
async function waitForWithTimers(predicate: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`waitForWithTimers：条件在 ${tries} 次计时后仍没满足`);
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

// --- C2 量纲修复回归 ---
//
// 真机复现：`asd follow` 对一个已经安静的 session 是立即返回的（不是再等 2
// 秒），实测重挂一次只要几十毫秒。旧实现在决定"悄悄重挂"之后立刻同步重挂，
// 不做任何真实等待 —— 于是 EARLY_MAX_RETRIES(10) 次重挂在远不到 1 秒内就会
// 全部烧光，EARLY_GRACE_MS(20 秒) 这个宽限期在真机上从未真正生效过。下面
// 两个测试直接钉住这一点：真的量出"重挂之间有没有真实等待"，而不是像旧的
// C2 测试那样只靠可以手动摆布的假 follow + 手动 settle 来分阶段断言。

test("C2 回归：follow 对已安静的 session 立即自解时，重挂之间必须真的流逝时间，不能几十毫秒就把 10 次重挂全部烧光", async () => {
  // instantFollow + peek 恒为空：完全复刻真机行为——follow 立刻 settled，
  // 屏幕一直没有内容。earlyRetryDelayMs 给一个很小但真实的值（不是 0），
  // 这样测试用真实的 setTimeout 轮询就能测到"重挂之间确实有等待"，又不用
  // 真的等上秒级。
  const h = harness({
    instantFollow: { kind: "settled", text: "" },
    peek: "",
    earlyRetryDelayMs: 15,
  });

  const t0 = Date.now();
  h.pool.watch("iso-late");

  // 用真实的小段轮询等它收尾（次数上限最终会兜底，见上面那个测试）——这里
  // 不能用 waitFor：waitFor 纯靠微任务自旋，旧 bug 和新实现在微任务层面
  // 看起来完全一样（都是"重挂→再重挂"），只有真实挂钟时间能把两者分开。
  while (h.pool.isWatching("iso-late")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const elapsed = Date.now() - t0;

  assert.equal(h.notes.length, 1, "重挂次数到了上限之后必须照常通知一次");
  assert.match(h.notes[0], /已停下/);
  // 旧 bug：10 次重挂总共只花几十毫秒（每次几毫秒开销）。修复之后，重挂
  // 之间应该有 earlyRetryDelayMs 量级的真实等待——哪怕只挂起了几轮也该有
  // 明显可测的挂钟耗时，而不是旧 bug 那种"瞬间烧光"。
  assert.ok(
    elapsed >= 15 * 3,
    `重挂之间应该有真实等待，实际总耗时只有 ${elapsed}ms（旧 bug 下这里通常 < 10ms）`,
  );
});

test("C2 回归：时钟推过 EARLY_GRACE_MS 后立刻通知，不等次数上限", async () => {
  // pausePeek 给出一个"peek 已发出、还没结果"的检查点，让测试能在这个
  // 节点上手动把（可注入的）时钟往前拨，模拟"宽限期内" vs "宽限期已过"
  // 两种情况，而不用真的等 20 秒。
  const h = harness({ instantFollow: { kind: "settled", text: "" }, pausePeek: true, earlyRetryDelayMs: 0 });
  h.pool.watch("iso-late"); // mountedAt = clock.t = 0，attempts = 0

  await waitFor(() => h.peekCalls.length === 1);
  h.clock.t = 5_000; // 还在 20 秒宽限期内
  h.settlePeek("iso-late", ""); // 屏幕仍是空的
  await waitFor(() => h.followCalls.length === 2);
  assert.deepEqual(h.notes, [], "才 5 秒，还在宽限期内，不该通知");
  assert.equal(h.pool.isWatching("iso-late"), true);

  await waitFor(() => h.peekCalls.length === 2);
  h.clock.t = 21_000; // 推过 20 秒宽限线——此时只重挂了 1 次，远没到 10 次上限
  h.settlePeek("iso-late", "");
  await h.pool.idle();

  assert.equal(h.followCalls.length, 2, "宽限期已过，不该再重挂第三次");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /已停下/);
  assert.equal(h.pool.isWatching("iso-late"), false);
});

test("C2 量纲修复：重挂前的真实等待期间，isWatching 必须全程保持 true", async () => {
  // 真实但很小的等待（40ms），配合真实的 setTimeout 轮询——这钉住"sleep 必须
  // 放在 #finish 之前"这条不变量：等待窗口里 #running 不能被提前摘掉，否则
  // asd_agents() 会谎报没在挂，rewatch() 还可能借机叠一个新 watcher 上去。
  const h = harness({ instantFollow: { kind: "settled", text: "" }, peek: "", earlyRetryDelayMs: 40 });
  h.pool.watch("iso-late");

  let sawWatchingDuringWait = false;
  const deadline = Date.now() + 500;
  while (h.pool.isWatching("iso-late") && Date.now() < deadline) {
    assert.equal(h.pool.isWatching("iso-late"), true, "等待窗口期间 isWatching 不能变成 false");
    sawWatchingDuringWait = true;
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  assert.ok(sawWatchingDuringWait, "测试本身要至少探测到一次等待中的状态，不然这条断言没测到东西");

  while (h.pool.isWatching("iso-late")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(h.notes.length, 1, "最终应该照常收尾并通知一次");
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
    async sendText() {
      return true;
    },
    async key() {
      return true;
    },
    async rename() {
      return { kind: "ok" as const };
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

// --- onGone：session 真的没了才回调 ---
//
// 回归（b004da8 引入，用户实测「spawn 出来的 agent 刚起来就被停掉」）：
// 这个回调最初叫 onDone，在 settle 和 gone 两条路上都触发，index.ts 接上去
// 直接 `asd kill`。问题在于 settle **不等于** agent 做完了：
//
//   `asd follow` 判"停下"的依据是终端安静了约 2 秒。一个刚 spawn 出来的 agent
//   画完 TUI 首屏、正在等模型的第一个 token 时，屏幕非空（所以冷启动止损那条
//   分支不适用）而且安静 —— 正好被判成 settle。于是 agent 在真正开始干活之前
//   就被 kill 了，而且屏幕上还留着任务文本，看起来就像"它自己停了"。
//
// 更根本的是：settle 状态的 agent 是**活着且在等输入**，那是它最有用的状态 ——
// 可以 asd_steer 追加任务、可以被 pickReusable 复用、可以 asd attach 接管
// （README「生命周期」把这条列为 asd 相对 tmux 真正多出来的能力）。
// 在一个已知不可靠的信号上挂一个不可逆的销毁动作，是这次事故的根。
//
// 所以：settle 绝不回调。只有 gone（asd 里这个 session 真的没了）才回调，
// 而且回调方只清台账、不 kill —— 都没了，也没什么可 kill 的。

test("回归：settle 绝不触发 onGone —— 停下来的 agent 还活着，不该被销毁", async () => {
  const h = harness({ peek: "╭─ pi ─╮\n│ > 排查 token watcher │\n╰──────╯" });
  h.pool.watch("pi-a");
  h.settle("pi-a", { kind: "settled", text: "" });
  await h.pool.idle();

  assert.deepEqual(h.goneCalls, [], "settle 不是「session 没了」，绝不能回调");
  assert.equal(h.notes.length, 1, "但通知照发 —— boss 要知道它停下来了");
  assert.match(h.notes[0]!, /已停下/);
});

test("回归：冷启动那一屏（TUI 已画出、还没出结果）settle 时也不回调", async () => {
  // 这就是用户实测踩到的那一屏：非空，所以冷启动止损不适用，直接走 settle。
  const h = harness({ instantFollow: { kind: "settled", text: "" }, peek: "pi v0.1  > 排查 token watcher" });
  h.pool.watch("pi-agent1");
  await h.pool.idle();

  assert.deepEqual(h.goneCalls, [], "刚起来的 agent 绝不能因为安静了两秒就被收尾");
});

test("gone 才触发 onGone —— session 在 asd 里真的没了，台账该清", async () => {
  const h = harness();
  h.pool.watch("pi-a");
  h.settle("pi-a", { kind: "gone" });
  await h.pool.idle();

  assert.deepEqual(h.goneCalls, ["pi-a"]);
  assert.equal(h.peekCalls.length, 0, "都没了就不该再 peek");
});

test("timeout 不触发 onGone —— 那个 agent 还在跑", async () => {
  const h = harness();
  h.pool.watch("pi-a");
  h.settle("pi-a", { kind: "timeout", text: "" });
  await h.pool.idle();

  assert.deepEqual(h.goneCalls, []);
});

test("冷启动重挂路径上不触发 onGone", async () => {
  const h = harness({ instantFollow: { kind: "settled", text: "" }, peek: "" });
  h.pool.watch("pi-a");
  await waitFor(() => h.followCalls.length >= 2);
  h.pool.stopAll();
  await h.pool.idle();

  assert.deepEqual(h.goneCalls, [], "重挂说明还没真开始，更不该收尾");
});

test("watcher 出错时不触发 onGone —— 不知道 session 状态就不要乱收尾", async () => {
  const h = harness({ pausePeek: true });
  h.pool.watch("pi-a");
  h.settle("pi-a", { kind: "settled", text: "" });
  await waitFor(() => h.peekCalls.length === 1);
  h.rejectPeek("pi-a", new Error("asd 挂了"));
  await h.pool.idle();

  assert.deepEqual(h.goneCalls, [], "peek 失败只说明我们不知道状态，不能当成 session 没了");
  assert.match(h.notes[0]!, /出错/);
});

// --- 复核：把「思考中」和「真停下」分开 ---
//
// `asd follow` 的 settle 只代表"终端安静了约 2 秒"，分不出在思考还是干完了。
// 但屏幕能分：还在干活的 agent 会持续重绘（转圈、逐字输出），静止的不会。
// 所以 settle 之后要连续复核两次，baseline 加两次复核必须三屏一致；任一屏变化
// 都说明它还在动，要安静重挂、从零累计。全部确认后再 final peek 最终执行内容。
// 这是目前唯一能把两者分开的判据（asd 自己给不出）。

/** 每次 peek 依次吐出预设的屏幕，用完之后一直吐最后一屏。 */
function screenSeq(screens: string[]) {
  let i = 0;
  return () => screens[Math.min(i++, screens.length - 1)]!;
}

function confirmHarness(o: {
  screens: string[];
  goneCalls?: string[];
  canNavigate?: (session: string) => boolean;
}) {
  const next = screenSeq(o.screens);
  const notes: string[] = [];
  const followCalls: string[] = [];
  let peekCalls = 0;
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
      peekCalls += 1;
      return next();
    },
    async send() {
      return true;
    },
    async sendText() {
      return true;
    },
    async key() {
      return true;
    },
    async rename() {
      return { kind: "ok" as const };
    },
    async follow(name: string): Promise<FollowOutcome> {
      followCalls.push(name);
      return { kind: "settled", text: "" };
    },
    async kill() {
      return true;
    },
  } satisfies Asd;
  const pool = new WatcherPool({
    asd,
    notify: (t) => notes.push(t),
    timeout: "30m",
    now: () => 0,
    earlyRetryDelayMs: 0,
    settleConfirmMs: 1, // 真的复核，但不用真等
    canNavigate: o.canNavigate,
  });
  return {
    pool,
    notes,
    followCalls,
    get peekCalls() {
      return peekCalls;
    },
  };
}

test("连续两次复核都稳定后，才 final peek 并用最终屏幕通知", async () => {
  const h = confirmHarness({ screens: ["最终命令行内容", "最终命令行内容", "最终命令行内容"] });
  h.pool.watch("pi-a");
  await h.pool.idle();

  assert.equal(h.followCalls.length, 1);
  assert.equal(h.peekCalls, 4, "baseline + 两次稳定复核 + 完成后的 final peek");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0]!, /最终命令行内容/, "通知必须使用完成后重新 peek 的屏幕");
});

test("连续复核中途变化会整轮作废，下一轮从零重新累计", async () => {
  const h = confirmHarness({
    screens: ["A", "A", "B", "FINAL 命令行内容", "FINAL 命令行内容", "FINAL 命令行内容"],
  });
  h.pool.watch("pi-a");
  await h.pool.idle();

  assert.equal(h.followCalls.length, 2, "第一轮第二次复核变化后必须重挂");
  assert.equal(h.peekCalls, 7);
  assert.equal(h.notes.length, 1, "作废的第一轮不能通知完成");
  assert.match(h.notes[0]!, /FINAL 命令行内容/);
  assert.doesNotMatch(h.notes[0]!, /--- 最后一屏 ---\nA$/);
});

test("final peek 又发生变化时不能报停下，必须重挂并重新确认", async () => {
  const h = confirmHarness({ screens: ["A", "A", "A", "B", "B", "B", "B", "B"] });
  h.pool.watch("pi-a");
  await h.pool.idle();

  assert.equal(h.followCalls.length, 2, "final peek 的变化也是活动信号");
  assert.equal(h.peekCalls, 8);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0]!, /--- 最后一屏 ---\nB$/);
});

test("连续复核总在变化直到上限，也不能绕过确认谎报已停下", async () => {
  const screens = Array.from({ length: 100 }, (_, i) => `帧${i}`);
  const h = confirmHarness({ screens });
  h.pool.watch("pi-a");
  await h.pool.idle();

  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0]!, /未确认停下/);
  assert.doesNotMatch(h.notes[0]!, /已停下/);
  assert.doesNotMatch(h.notes[0]!, /--- 最后一屏 ---/, "没确认完成就不能读取并宣称最终结果");
});

test("回归：复核时屏幕还在变 → 判定为还在干活，安静重挂，不通知", async () => {
  // 三次 peek 各不相同 = 一直在重绘；第 4 次起稳定
  const h = confirmHarness({ screens: ["帧1", "帧2", "帧3", "稳定", "稳定", "稳定"] });
  h.pool.watch("pi-a");
  await h.pool.idle();

  assert.ok(h.followCalls.length >= 2, "屏幕在变就该重挂，而不是报停下");
  assert.equal(h.notes.length, 1, "只有稳定下来那一次才通知");
  assert.match(h.notes[0]!, /已停下/);
});

test("屏幕静止 → 照常报「已停下」", async () => {
  const h = confirmHarness({ screens: ["一动不动"] });
  h.pool.watch("pi-a");
  await h.pool.idle();
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0]!, /已停下/);
  assert.doesNotMatch(h.notes[0]!, /需要用户决策/);
});

/**
 * 静止的这一屏是"等决策"还是"干完了"，对 boss 是两个完全不同的动作：
 * 前者必须有人按键、不处理就永远卡着；后者是去读结果。
 */
test("静止且是对话框 → 报「需要用户决策」，带上摘要和下一步怎么做", async () => {
  const dialog = " ❯ 1. Yes, I trust this folder\n   2. No, exit\n Enter to confirm · Esc to cancel";
  const h = confirmHarness({ screens: [dialog] });
  h.pool.watch("pi-a");
  await h.pool.idle();

  assert.equal(h.notes.length, 1);
  const n = h.notes[0]!;
  assert.match(n, /需要用户决策/);
  assert.match(n, /选项：/);
  assert.match(n, /当前选中：/);
  assert.match(n, /asd_nav/, "要告诉 boss 用什么工具作答");
  assert.match(n, /自动重挂/, "要说明作答后不用重新 spawn");
  assert.doesNotMatch(n, /已停下/, "别再说成「已停下」——那会把 boss 引去读结果");
});

test("台账外 session 卡在对话框时不推荐必然失败的 asd_nav", async () => {
  const dialog = " ❯ 1. Yes, I trust this folder\n   2. No, exit\n Enter to confirm · Esc to cancel";
  const h = confirmHarness({ screens: [dialog], canNavigate: () => false });
  h.pool.watch("mem");
  await h.pool.idle();

  const n = h.notes[0]!;
  assert.match(n, /需要用户决策/);
  assert.doesNotMatch(n, /asd_nav/, "台账外 session 调 asd_nav 会被硬闸门拒绝");
  assert.match(n, /asd attach mem/, "要给一个能实际执行的恢复路径");
  assert.match(n, /台账外/, "要解释为什么只能手动处理");
});

test("连续确认通过但 final peek 还悬着时被 stop：不通知、也不再重挂", async () => {
  const h = harness({
    instantFollow: { kind: "settled", text: "" },
    pausePeek: true,
    settleConfirmMs: 1,
  });
  h.pool.watch("pi-a");

  await waitFor(() => h.peekCalls.length === 1);
  h.settlePeek("pi-a", "稳定"); // baseline
  await waitForWithTimers(() => h.peekCalls.length === 2);
  h.settlePeek("pi-a", "稳定"); // 第一次复核
  await waitForWithTimers(() => h.peekCalls.length === 3);
  h.settlePeek("pi-a", "稳定"); // 第二次复核
  await waitFor(() => h.peekCalls.length === 4); // final peek 已发出，故意悬住

  h.pool.stopAll();
  h.settlePeek("pi-a", "稳定");
  await h.pool.idle();

  assert.deepEqual(h.notes, []);
  assert.equal(h.followCalls.length, 1, "stop 后不能再重挂下一代");
  assert.equal(h.pool.isWatching("pi-a"), false);
});
