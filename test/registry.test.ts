import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionInfo } from "../extensions/asd/cli.ts";
import {
  NAME_MAX,
  Registry,
  sanitizeName,
  uniqueName,
  type AgentRecord,
} from "../extensions/asd/registry.ts";

function info(session: string, o: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session,
    status: o.running ?? false ? "running" : "idle",
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

function liveMap(...rows: SessionInfo[]): Map<string, SessionInfo> {
  return new Map(rows.map((r) => [r.session, r]));
}

function rec(o: Partial<AgentRecord> & { session: string }): AgentRecord {
  return {
    task: "t",
    cwd: "/w",
    agent: "pi",
    createdAt: 0,
    createdByUs: true,
    watching: false,
    ...o,
  };
}

test("sanitizeName 把非法字符换成横杠并压缩", () => {
  assert.equal(sanitizeName("auth fix"), "auth-fix");
  assert.equal(sanitizeName("修 auth/bug"), "auth-bug");
  assert.equal(sanitizeName("a///b"), "a-b");
});

test("sanitizeName 去掉首尾横杠，全非法时退回 agent", () => {
  assert.equal(sanitizeName("--x--"), "x");
  assert.equal(sanitizeName("修复"), "agent");
  assert.equal(sanitizeName(""), "agent");
});

test("sanitizeName 截断到 64", () => {
  const long = "a".repeat(100);
  assert.equal(sanitizeName(long).length, NAME_MAX);
});

test("uniqueName 不撞时原样返回，撞了就追加序号", () => {
  assert.equal(uniqueName("pi-a", new Set()), "pi-a");
  assert.equal(uniqueName("pi-a", new Set(["pi-a"])), "pi-a-2");
  assert.equal(uniqueName("pi-a", new Set(["pi-a", "pi-a-2"])), "pi-a-3");
});

test("uniqueName 追加序号后仍然不超过 64", () => {
  const base = "b".repeat(NAME_MAX);
  const got = uniqueName(base, new Set([base]));
  assert.ok(got.length <= NAME_MAX);
  assert.ok(got.endsWith("-2"));
});

test("allocateName 加前缀；没给名字就自动编号", () => {
  const r = new Registry("pi-");
  assert.equal(r.allocateName("auth fix", new Set()), "pi-auth-fix");
  assert.equal(r.allocateName(undefined, new Set()), "pi-agent2");
  assert.equal(r.allocateName(undefined, new Set()), "pi-agent3");
});

test("allocateName 避开 asd 里已经存在的名字", () => {
  const r = new Registry("pi-");
  assert.equal(r.allocateName("a", new Set(["pi-a"])), "pi-a-2");
});

test("candidateName 只加前缀和洗名，不避重", () => {
  const r = new Registry("pi-");
  assert.equal(r.candidateName("auth fix"), "pi-auth-fix");
  assert.equal(r.candidateName("auth fix"), "pi-auth-fix");
});

test("add / get / list / remove 走通", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a" }));
  assert.equal(r.size, 1);
  assert.equal(r.get("pi-a")?.session, "pi-a");
  assert.deepEqual(r.names(), ["pi-a"]);
  assert.equal(r.remove("pi-a")?.session, "pi-a");
  assert.equal(r.size, 0);
  assert.equal(r.remove("pi-a"), undefined);
});

test("reconcile 摘掉 asd 里已经不在的条目并把它们返回", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a" }));
  r.add(rec({ session: "pi-b" }));
  const gone = r.reconcile(new Set(["pi-a"]));
  assert.deepEqual(gone.map((g) => g.session), ["pi-b"]);
  assert.deepEqual(r.names(), ["pi-a"]);
});

test("pickReusable 要求 agent、cwd 都对上而且是 idle 的", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a", agent: "pi", cwd: "/w" }));
  const live = liveMap(info("pi-a", { running: false, idle_ms: 9 }));
  assert.equal(r.pickReusable({ agent: "pi", cwd: "/w" }, live)?.session, "pi-a");
  assert.equal(r.pickReusable({ agent: "claude", cwd: "/w" }, live), undefined);
  assert.equal(r.pickReusable({ agent: "pi", cwd: "/other" }, live), undefined);
});

test("pickReusable 跳过还在 running 的", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a" }));
  const live = liveMap(info("pi-a", { running: true, idle_ms: 0 }));
  assert.equal(r.pickReusable({ agent: "pi", cwd: "/w" }, live), undefined);
});

test("pickReusable 跳过 asd 里已经不在的", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a" }));
  assert.equal(r.pickReusable({ agent: "pi", cwd: "/w" }, liveMap()), undefined);
});

test("pickReusable 多个候选时取闲得最久的", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a" }));
  r.add(rec({ session: "pi-b" }));
  const live = liveMap(
    info("pi-a", { idle_ms: 100 }),
    info("pi-b", { idle_ms: 9000 }),
  );
  assert.equal(r.pickReusable({ agent: "pi", cwd: "/w" }, live)?.session, "pi-b");
});

test("pickReusable 给了 name 就只认同名那个", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a" }));
  r.add(rec({ session: "pi-b" }));
  const live = liveMap(info("pi-a", { idle_ms: 1 }), info("pi-b", { idle_ms: 9000 }));
  assert.equal(r.pickReusable({ name: "pi-a", agent: "pi", cwd: "/w" }, live)?.session, "pi-a");
  assert.equal(r.pickReusable({ name: "pi-zzz", agent: "pi", cwd: "/w" }, live), undefined);
});

test("canKill 放行台账里自己新建的", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a", createdByUs: true }));
  const d = r.canKill("pi-a");
  assert.equal(d.ok, true);
});

test("canKill 拒绝台账外的名字，并把台账内容带出来", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a" }));
  const d = r.canKill("mem");
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.reason, "unknown");
  assert.deepEqual(d.ok === false && d.reason === "unknown" ? d.known : [], ["pi-a"]);
});

test("canKill 拒绝 createdByUs 为 false 的记录", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a", createdByUs: false }));
  const d = r.canKill("pi-a");
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.reason, "not-ours");
});

test("setWatching 改的是台账里那条记录", () => {
  const r = new Registry("pi-");
  r.add(rec({ session: "pi-a", watching: false }));
  r.setWatching("pi-a", true);
  assert.equal(r.get("pi-a")?.watching, true);
  r.setWatching("不存在", true); // 不该抛
});
