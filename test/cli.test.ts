import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AsdError,
  AsdMissingError,
  createAsd,
  parseFollowOutput,
  type Exec,
  type ExecResult,
} from "../extensions/asd/cli.ts";

interface Call {
  cmd: string;
  args: string[];
}

/**
 * 假 exec：按调用顺序吐出预设结果，并把每次调用记下来。
 * 结果用完之后再调就抛错 —— 免得测试悄悄多打了一条命令还看不出来。
 */
function fakeExec(results: (Partial<ExecResult> | Error)[]): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = results[i++];
    if (r === undefined) throw new Error(`没有预设第 ${i} 次调用的结果：${cmd} ${args.join(" ")}`);
    if (r instanceof Error) throw r;
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
  };
  return { exec, calls };
}

const SESSION_JSON = JSON.stringify([
  {
    session: "pi-a",
    status: "running",
    command: "bash",
    title: "root@h: ~/p",
    pid: 100,
    cols: 80,
    rows: 24,
    created_ms: 1,
    idle_ms: 5,
    running: true,
    attached_clients: 0,
  },
]);

test("create 打 asd new，回读 stdout 里的最终名字", async () => {
  const { exec, calls } = fakeExec([{ stdout: "pi-auth-fix\n" }]);
  const name = await createAsd(exec).create({ name: "pi-auth-fix", cwd: "/w", cmd: "PI_SPAWNED=1 pi 'go'" });
  assert.equal(name, "pi-auth-fix");
  assert.deepEqual(calls[0], {
    cmd: "asd",
    args: ["new", "pi-auth-fix", "--cwd", "/w", "--cmd", "PI_SPAWNED=1 pi 'go'"],
  });
});

test("create 非零退出抛 AsdError，带上 asd 自己的 stderr", async () => {
  const { exec } = fakeExec([{ code: 1, stderr: "name already taken" }]);
  await assert.rejects(
    () => createAsd(exec).create({ name: "x", cwd: "/w", cmd: "pi 'go'" }),
    (e: unknown) => e instanceof AsdError && e.code === 1 && e.message.includes("name already taken"),
  );
});

test("list 解析 --json 数组", async () => {
  const { exec, calls } = fakeExec([{ stdout: SESSION_JSON }]);
  const rows = await createAsd(exec).list();
  assert.deepEqual(calls[0].args, ["list", "--json"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session, "pi-a");
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].idle_ms, 5);
});

test("list 拿到不是 JSON 的东西时抛 AsdError 而不是 SyntaxError", async () => {
  const { exec } = fakeExec([{ stdout: "not json" }]);
  await assert.rejects(() => createAsd(exec).list(), (e: unknown) => e instanceof AsdError);
});

test("peek 带 scrollback 时加 --scrollback", async () => {
  const { exec, calls } = fakeExec([{ stdout: "SCREEN" }]);
  const screen = await createAsd(exec).peek("pi-a", 200);
  assert.equal(screen, "SCREEN");
  assert.deepEqual(calls[0].args, ["peek", "pi-a", "--scrollback", "200"]);
});

test("peek 遇到退出码 3 返回 null，不抛", async () => {
  const { exec } = fakeExec([{ code: 3, stderr: "no such session" }]);
  assert.equal(await createAsd(exec).peek("pi-a"), null);
});

test("send 原样送 --text 并追加 --enter", async () => {
  const { exec, calls } = fakeExec([{}]);
  assert.equal(await createAsd(exec).send("pi-a", "干活 --now"), true);
  assert.deepEqual(calls[0].args, ["send", "pi-a", "--text", "干活 --now", "--enter"]);
});

test("send 遇到退出码 3 返回 false", async () => {
  const { exec } = fakeExec([{ code: 3 }]);
  assert.equal(await createAsd(exec).send("pi-a", "hi"), false);
});

/** 一行 `asd follow --json` 事件。 */
function ev(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

test("follow 带 --json，退出码 0 是 settled，只把 output 事件的 text 拼进过程输出", async () => {
  const stdout = [
    ev({ event: "status", time_ms: 1, running: true, idle_ms: 0 }),
    ev({ event: "output", time_ms: 2, text: "LINE-1\n" }),
    ev({ event: "output", time_ms: 3, text: "LINE-2\n" }),
    ev({ event: "screen", time_ms: 4, text: "整屏重绘的内容，不该出现在过程输出里" }),
    ev({ event: "status", time_ms: 5, running: false, idle_ms: 2000 }),
  ].join("\n");
  const { exec, calls } = fakeExec([{ stdout }]);
  const out = await createAsd(exec).follow("pi-a", { timeout: "30m" });
  assert.deepEqual(out, { kind: "settled", text: "LINE-1\nLINE-2\n" });
  assert.deepEqual(calls[0].args, ["follow", "pi-a", "--json", "--timeout", "30m"]);
});

test("follow 的 forever 加 --forever，且仍然带 --json", async () => {
  const { exec, calls } = fakeExec([{ stdout: "" }]);
  await createAsd(exec).follow("pi-a", { timeout: "5m", forever: true });
  assert.deepEqual(calls[0].args, ["follow", "pi-a", "--json", "--forever", "--timeout", "5m"]);
});

test("follow 退出码 4 是 timeout，不是错误，text 一样只取 output 事件", async () => {
  const stdout = [ev({ event: "output", time_ms: 1, text: "PARTIAL" })].join("\n");
  const { exec } = fakeExec([{ code: 4, stdout }]);
  assert.deepEqual(await createAsd(exec).follow("pi-a", { timeout: "1s" }), {
    kind: "timeout",
    text: "PARTIAL",
  });
});

test("follow 退出码 3 是 gone", async () => {
  const { exec } = fakeExec([{ code: 3 }]);
  assert.deepEqual(await createAsd(exec).follow("pi-a", { timeout: "1s" }), { kind: "gone" });
});

// --- I2 回归：asd_follow 不该把逐字节 pty 流（screen/status/exit 等控制
// 事件）灌进 LLM 上下文，只要 output 事件的文本。---

test("parseFollowOutput 只挑出 output 事件的 text，按顺序拼起来", () => {
  const stdout = [
    ev({ event: "status", time_ms: 1, running: true, idle_ms: 0 }),
    ev({ event: "output", time_ms: 2, text: "a" }),
    ev({ event: "screen", time_ms: 3, text: "整屏，不该进来" }),
    ev({ event: "output", time_ms: 4, text: "b" }),
    ev({ event: "status", time_ms: 5, running: false, idle_ms: 2000 }),
    ev({ event: "exit", time_ms: 6 }),
  ].join("\n");
  assert.equal(parseFollowOutput(stdout), "ab");
});

test("parseFollowOutput 容忍不完整的最后一行和混进来的非 JSON 杂行，不抛异常", () => {
  const stdout =
    [
      ev({ event: "output", time_ms: 1, text: "good-1\n" }),
      "不是 JSON 的杂行，比如 daemon 自己往 stderr 混进 stdout 的东西",
      ev({ event: "output", time_ms: 2, text: "good-2\n" }),
    ].join("\n") + '\n{"event":"output","time_ms":3,"text":"trunc'; // 被截断的最后一行，没收全
  assert.doesNotThrow(() => parseFollowOutput(stdout));
  assert.equal(parseFollowOutput(stdout), "good-1\ngood-2\n");
});

test("parseFollowOutput 空输入给空字符串", () => {
  assert.equal(parseFollowOutput(""), "");
  assert.equal(parseFollowOutput("\n\n"), "");
});

test("kill 打 asd kill，退出码 3 说明本来就没了", async () => {
  const { exec, calls } = fakeExec([{}, { code: 3 }]);
  const asd = createAsd(exec);
  assert.equal(await asd.kill("pi-a"), true);
  assert.deepEqual(calls[0].args, ["kill", "pi-a"]);
  assert.equal(await asd.kill("pi-b"), false);
});

test("exec 抛 ENOENT 时翻译成 AsdMissingError", async () => {
  const enoent = Object.assign(new Error("spawn asd ENOENT"), { code: "ENOENT" });
  const { exec } = fakeExec([enoent]);
  await assert.rejects(() => createAsd(exec).list(), (e: unknown) => e instanceof AsdMissingError);
});

test("退出码 127 也当成 asd 没装", async () => {
  const { exec } = fakeExec([{ code: 127, stderr: "asd: command not found" }]);
  await assert.rejects(() => createAsd(exec).list(), (e: unknown) => e instanceof AsdMissingError);
});

test("cards 打 asd card list --json 并解析出 cwd 和 docs", async () => {
  const { exec, calls } = fakeExec([
    { stdout: '[{"session":"mem","status":"idle","cwd":"/w/mem","docs":["README.md","CLAUDE.md"]}]' },
  ]);
  const rows = await createAsd(exec).cards();
  assert.deepEqual(calls[0].args, ["card", "list", "--json"]);
  assert.equal(rows[0].session, "mem");
  assert.equal(rows[0].cwd, "/w/mem");
  assert.deepEqual(rows[0].docs, ["README.md", "CLAUDE.md"]);
});

test("cards 拿到不是 JSON 的东西时抛 AsdError 而不是 SyntaxError", async () => {
  const { exec } = fakeExec([{ stdout: "not json" }]);
  await assert.rejects(() => createAsd(exec).cards(), (e: unknown) => e instanceof AsdError);
});
