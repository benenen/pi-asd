import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAsd, type Exec } from "../extensions/asd/cli.ts";
import { Registry } from "../extensions/asd/registry.ts";
import { WatcherPool } from "../extensions/asd/watcher.ts";
import { createTools, type AgentPreset } from "../extensions/asd/tools.ts";

/**
 * asd 装了才跑这一组；CI 上没装就整体跳过。
 *
 * 这是仓库里唯一一处不经过隔离 env（`ASD_SOCKET` + `XDG_DATA_HOME`）直接裸调
 * `asd` 的地方——**这是刻意的例外，不是疏漏**。`--version` 是 clap 内置的
 * 元数据子命令，在连上任何 socket、碰任何 daemon 之前就返回，不读也不建
 * session、不触碰真实用户的 9 个工作会话。真正会碰 daemon 的任何子命令
 * （`list`/`new`/`peek`/`send`/`follow`/`kill`/...）都必须走下面的
 * `realExec()`，把 `ASD_SOCKET` 和 `XDG_DATA_HOME` 都钉死在临时目录里 ——
 * 别把这处例外当模板抄到别的地方去。
 */
async function hasAsd(): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile("asd", ["--version"], (e) => resolve(e === null));
  });
}

/**
 * 真的起子进程。env 里同时钉死 ASD_SOCKET 和 XDG_DATA_HOME —— 只钉前者的话，
 * 新 daemon 会读全局 sessions.tsv 并重建用户真实的 session。
 */
function realExec(root: string): Exec {
  const env = {
    ...process.env,
    ASD_SOCKET: path.join(root, "asd.sock"),
    XDG_DATA_HOME: path.join(root, "data"),
  };
  return (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        { env, signal: opts?.signal, maxBuffer: 8 * 1024 * 1024 },
        (e, stdout, stderr) => {
          if (e && typeof (e as { code?: unknown }).code === "string") return reject(e);
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            code: e === null ? 0 : ((e as { code?: number }).code ?? 1),
          });
        },
      );
    });
}

/** 假 agent 预设：打一行 READY 然后挂住，行为足够像一个停下来等输入的 agent，
 * 又不需要真的装 claude / pi。只在这个测试文件里用，不碰模块级 `PRESETS`。 */
const SH_PROBE_PRESETS: Record<string, AgentPreset> = {
  "sh-probe": {
    command: (t) => `sh -c 'echo READY; echo ${t}; sleep 30'`,
    piChild: false,
  },
};

test("e2e：spawn → list → agents → peek → steer → kill 走一遍真 asd", { timeout: 60_000 }, async (t) => {
  if (!(await hasAsd())) {
    t.skip("asd 不在 PATH 上，跳过");
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), "pi-asd-e2e-"));
  const exec = realExec(root);
  const asd = createAsd(exec);
  const registry = new Registry("pi-e2e-");
  const watchers = new WatcherPool({ asd, notify: () => {}, timeout: "5s", now: () => Date.now() });
  const tools = createTools({
    asd,
    registry,
    watchers,
    config: {
      defaultAgent: "sh-probe",
      workspaceBase: root,
      followTimeout: "5s",
      presets: SH_PROBE_PRESETS,
    },
    mkdirp: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    now: () => Date.now(),
  });

  try {
    // 隔离目录是全新的，这个 socket 上还从没起过 daemon。`asd list`（`tools.spawn`
    // 内部第一步就是它，用来找可复用的空闲 agent）不会顺带拉起 daemon —— 只有
    // `asd new` 会。先用一个哑 session 把 daemon 打起来、立刻杀掉，后面的
    // spawn/peek/steer/kill 链路才不会一上来就撞上"daemon 没在跑"这个冷启动坑。
    const primer = await asd.create({ name: "__prime__", cwd: root, cmd: "sh -c 'sleep 5'" });
    await asd.kill(primer);

    const spawned = await tools.spawn({ task: "HELLO-E2E", name: "one", watch: false });
    assert.equal(spawned.isError, undefined, spawned.text);
    const session = String(spawned.details?.session);
    assert.equal(session, "pi-e2e-one");

    // 等 sh 把 READY 打出来。
    const deadline = Date.now() + 10_000;
    let screen = "";
    while (Date.now() < deadline) {
      const r = await tools.peek({ session });
      screen = r.text;
      if (screen.includes("READY")) break;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.match(screen, /READY/);
    assert.match(screen, /HELLO-E2E/);

    const listed = await tools.agents();
    assert.match(listed.text, new RegExp(session));

    const allSessions = await tools.list();
    assert.match(allSessions.text, new RegExp(session));
    const sessionNames = allSessions.details?.sessions;
    assert.ok(Array.isArray(sessionNames), "asd_list 应该返回结构化 session 名数组");
    assert.ok(sessionNames.includes(session), "结构化结果也应该包含刚创建的 session");

    const steered = await tools.steer({ session, message: "ping" });
    assert.equal(steered.isError, undefined, steered.text);
    watchers.stopAll();

    const killed = await tools.kill({ session });
    assert.equal(killed.isError, undefined, killed.text);
    assert.equal(registry.size, 0);

    const after = await asd.list();
    assert.ok(!after.some((s) => s.session === session), "kill 之后 session 不该还在");
  } finally {
    watchers.stopAll();
    // 隔离 daemon 里只有我们自己的 session，逐个点名杀掉 —— 不用那种一次性
    // 全杀的 asd kill 加 --all 参数的写法，这个项目里任何地方都不允许出现。
    for (const s of await asd.list().catch(() => [])) {
      await asd.kill(s.session).catch(() => {});
    }
    // `asd new` 会把这个隔离 socket 对应的 daemon 常驻起来；杀光 session 不会
    // 顺带让它退出（也没有对应的"停 daemon"子命令）。不主动结束它，每跑一次
    // 这个测试都会在系统里多留一个孤儿进程。pid 文件和 socket 在同一个目录
    // 下，只按这个 pid 杀这一个、且只属于我们自己的隔离 daemon，不影响真实
    // daemon（它的 pid 文件在别处）。
    try {
      const raw = await readFile(path.join(root, "asd.pid"), "utf8");
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
    } catch {
      // pid 文件不存在/读不出来/进程已经退出了，都不是需要处理的错误。
    }
    await rm(root, { recursive: true, force: true });
  }
});
