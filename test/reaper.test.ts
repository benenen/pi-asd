import { test } from "node:test";
import assert from "node:assert/strict";
import type { Asd, SessionInfo } from "../extensions/asd/cli.ts";
import { Registry } from "../extensions/asd/registry.ts";
import { parseDuration, Reaper, sessionsToReap } from "../extensions/asd/reaper.ts";

function info(session: string, idle_ms: number, o: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session,
    status: "idle",
    command: "pi",
    title: "",
    pid: 1,
    cols: 80,
    rows: 24,
    created_ms: 0,
    idle_ms,
    // 实测 asd 0.1.9 的 running 恒等于"idle_ms 小于 ~2 秒"，不是"进程在执行"。
    // 这里跟着这条真实语义造数据，免得测试建立在一个错的心智模型上。
    running: idle_ms < 2_000,
    attached_clients: 0,
    ...o,
  };
}

function ledger(entries: Array<{ session: string; createdByUs: boolean }>): Registry {
  const r = new Registry("pi-");
  for (const e of entries) {
    r.add({
      session: e.session,
      task: "t",
      cwd: "/w",
      agent: "pi",
      createdAt: 0,
      createdByUs: e.createdByUs,
    });
  }
  return r;
}

// --- parseDuration ---

test("parseDuration 认 ms / s / m / h", () => {
  assert.deepEqual(parseDuration("500ms"), { ms: 500 });
  assert.deepEqual(parseDuration("30s"), { ms: 30_000 });
  assert.deepEqual(parseDuration("2m"), { ms: 120_000 });
  assert.deepEqual(parseDuration("1h"), { ms: 3_600_000 });
  assert.deepEqual(parseDuration("1.5m"), { ms: 90_000 });
});

test("parseDuration 忽略大小写和首尾空白", () => {
  assert.deepEqual(parseDuration("  2M  "), { ms: 120_000 });
});

test("parseDuration 空串/纯空白当没设置 —— 同 parseBossDefault 的理由", () => {
  // .env 空行、docker -e VAR=、没展开的 shell 变量都会送来空串
  assert.deepEqual(parseDuration(undefined), {});
  assert.deepEqual(parseDuration(""), {});
  assert.deepEqual(parseDuration("   "), {});
});

test("parseDuration 认这些关闭值", () => {
  for (const v of ["off", "no", "false", "0", "never", "OFF"]) {
    assert.deepEqual(parseDuration(v), {}, `${v} 应当是关闭`);
  }
});

test("parseDuration 认不出的值带出 problem，不静默忽略", () => {
  const r = parseDuration("两分钟");
  assert.equal(r.ms, undefined);
  assert.match(r.problem!, /认不出的时长/);
  assert.match(r.problem!, /两分钟/);
  // 没有单位的裸数字也不认 —— 猜它是秒还是毫秒都是错的
  assert.ok(parseDuration("120").problem !== undefined);
});

test("parseDuration 0 值当关闭，不当成「立刻回收」", () => {
  assert.deepEqual(parseDuration("0s"), {});
  assert.deepEqual(parseDuration("0m"), {});
});

// --- sessionsToReap ---

test("空闲够久的自家 session 会被选中", () => {
  const r = ledger([{ session: "pi-a", createdByUs: true }]);
  assert.deepEqual(
    sessionsToReap(r, { live: [info("pi-a", 130_000)], idleKillMs: 120_000 }),
    ["pi-a"],
  );
});

test("没到阈值的不动 —— 差 1 毫秒也不动", () => {
  const r = ledger([{ session: "pi-a", createdByUs: true }]);
  assert.deepEqual(sessionsToReap(r, { live: [info("pi-a", 119_999)], idleKillMs: 120_000 }), []);
  assert.deepEqual(sessionsToReap(r, { live: [info("pi-a", 120_000)], idleKillMs: 120_000 }), ["pi-a"]);
});

/**
 * 硬不变量，和 Registry.canKill 同一条：不是自己创建的绝不动。指名交过任务的
 * 用户 session 会以 createdByUs: false 进台账 —— 它闲得再久也不能回收，那是
 * 用户自己的会话。
 */
test("不是自己创建的绝不回收，闲多久都不回收", () => {
  const r = ledger([{ session: "mem", createdByUs: false }]);
  assert.deepEqual(sessionsToReap(r, { live: [info("mem", 999_999_999)], idleKillMs: 120_000 }), []);
});

test("不在台账里的完全不碰 —— 用户手建的 session 跟我们无关", () => {
  const r = ledger([]);
  assert.deepEqual(sessionsToReap(r, { live: [info("someones-shell", 999_999)], idleKillMs: 1_000 }), []);
});

test("boss 自己所在的 session 永远不碰", () => {
  const r = ledger([{ session: "boss", createdByUs: true }]);
  assert.deepEqual(
    sessionsToReap(r, { live: [info("boss", 999_999)], idleKillMs: 1_000, bossSession: "boss" }),
    [],
  );
});

test("一轮能选中多个，且只选够格的", () => {
  const r = ledger([
    { session: "pi-a", createdByUs: true },
    { session: "pi-b", createdByUs: true },
    { session: "pi-c", createdByUs: true },
    { session: "mem", createdByUs: false },
  ]);
  const got = sessionsToReap(r, {
    live: [
      info("pi-a", 200_000), // 够久
      info("pi-b", 10_000), // 刚干完活，不动
      info("pi-c", 500_000), // 够久
      info("mem", 900_000), // 不是自己创建的
    ],
    idleKillMs: 120_000,
  });
  assert.deepEqual(got.sort(), ["pi-a", "pi-c"]);
});

/**
 * 回归：这是"被 steer / 被复用之后不该再回收"能不用取消逻辑就自动成立的原因。
 * 实测 asd send 会把 idle_ms 打回零，所以刚收到任务的 session 天然不够格。
 */
test("刚收到输入的 session（idle_ms 归零）自动不够格，不需要取消逻辑", () => {
  const r = ledger([{ session: "pi-a", createdByUs: true }]);
  // steer 之前：够格
  assert.deepEqual(sessionsToReap(r, { live: [info("pi-a", 300_000)], idleKillMs: 120_000 }), ["pi-a"]);
  // steer 之后 asd 把 idle_ms 打回零：立刻不够格
  assert.deepEqual(sessionsToReap(r, { live: [info("pi-a", 835)], idleKillMs: 120_000 }), []);
});

// --- Reaper.sweep ---

function fakeAsd(o: { live?: SessionInfo[]; killThrows?: Set<string>; listThrows?: boolean } = {}) {
  const killed: string[] = [];
  const asd = {
    async list() {
      if (o.listThrows) throw new Error("asd 联系不上");
      return o.live ?? [];
    },
    async kill(name: string) {
      if (o.killThrows?.has(name)) throw new Error("kill 失败");
      killed.push(name);
      return true;
    },
  } satisfies Pick<Asd, "list" | "kill">;
  return { asd, killed };
}

test("sweep 杀掉够格的，并从台账移除", async () => {
  const { asd, killed } = fakeAsd({ live: [info("pi-a", 200_000)] });
  const registry = ledger([{ session: "pi-a", createdByUs: true }]);
  const notes: string[] = [];
  const reaper = new Reaper({ asd, registry, idleKillMs: 120_000, notify: (t) => notes.push(t) });

  assert.deepEqual(await reaper.sweep(), ["pi-a"]);
  assert.deepEqual(killed, ["pi-a"]);
  assert.equal(registry.get("pi-a"), undefined, "台账要清掉，不然 asd_agents 会报幽灵");
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /已回收/);
  assert.match(notes[0]!, /2m/, "通知里要说清阈值");
  assert.match(notes[0]!, /pi-a/);
});

test("没有够格的就一声不吭 —— 不发无意义的通知", async () => {
  const { asd, killed } = fakeAsd({ live: [info("pi-a", 10_000)] });
  const registry = ledger([{ session: "pi-a", createdByUs: true }]);
  const notes: string[] = [];
  const reaper = new Reaper({ asd, registry, idleKillMs: 120_000, notify: (t) => notes.push(t) });

  assert.deepEqual(await reaper.sweep(), []);
  assert.deepEqual(killed, []);
  assert.deepEqual(notes, []);
});

test("asd list 失败时安静跳过这一轮 —— 联系不上就什么都不做，不能靠猜去 kill", async () => {
  const { asd, killed } = fakeAsd({ listThrows: true });
  const registry = ledger([{ session: "pi-a", createdByUs: true }]);
  const notes: string[] = [];
  const reaper = new Reaper({ asd, registry, idleKillMs: 120_000, notify: (t) => notes.push(t) });

  assert.deepEqual(await reaper.sweep(), []);
  assert.deepEqual(killed, []);
  assert.deepEqual(notes, []);
  assert.ok(registry.get("pi-a") !== undefined, "联系不上 asd 时台账不能动");
});

test("kill 失败时保留台账记录 —— 抹掉记录会让这个 session 从此没人管", async () => {
  const { asd, killed } = fakeAsd({
    live: [info("pi-a", 200_000), info("pi-b", 200_000)],
    killThrows: new Set(["pi-a"]),
  });
  const registry = ledger([
    { session: "pi-a", createdByUs: true },
    { session: "pi-b", createdByUs: true },
  ]);
  const reaper = new Reaper({ asd, registry, idleKillMs: 120_000, notify: () => {} });

  assert.deepEqual(await reaper.sweep(), ["pi-b"], "一个失败不该带倒另一个");
  assert.deepEqual(killed, ["pi-b"]);
  assert.ok(registry.get("pi-a") !== undefined, "没杀掉就留着，下一轮再试");
  assert.equal(registry.get("pi-b"), undefined);
});

test("start 挂上的定时器不会把进程吊着不退出", () => {
  const { asd } = fakeAsd();
  const reaper = new Reaper({
    asd,
    registry: ledger([]),
    idleKillMs: 120_000,
    sweepMs: 5_000,
    notify: () => {},
  });
  reaper.start();
  reaper.start(); // 重复 start 不该叠出第二个定时器
  reaper.stop();
  reaper.stop(); // 重复 stop 也要安全
});
