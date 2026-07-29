import { test } from "node:test";
import assert from "node:assert/strict";
import type { Asd, FollowOutcome, SessionInfo } from "../extensions/asd/cli.ts";
import { formatDuration, WatcherPool } from "../extensions/asd/watcher.ts";

interface Harness {
  pool: WatcherPool;
  notes: string[];
  /** 放行某个 session 的 follow，交出结果。 */
  settle(session: string, outcome: FollowOutcome): void;
  followCalls: string[];
  peekCalls: string[];
  clock: { t: number };
}

/**
 * 假 asd：follow 会挂住，直到测试自己调 settle() 放行 —— 这样"watcher 在等"
 * 和"watcher 已经回调完"两个阶段可以分开断言。
 */
function harness(o: { peek?: string | null } = {}): Harness {
  const pending = new Map<string, (out: FollowOutcome) => void>();
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
    async peek(name: string) {
      peekCalls.push(name);
      return o.peek === undefined ? "SCREEN" : o.peek;
    },
    async send() {
      return true;
    },
    async follow(name: string) {
      followCalls.push(name);
      return new Promise<FollowOutcome>((resolve) => pending.set(name, resolve));
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
      const resolve = pending.get(session);
      if (!resolve) throw new Error(`${session} 上没有在等的 follow`);
      pending.delete(session);
      resolve(outcome);
    },
  };
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
