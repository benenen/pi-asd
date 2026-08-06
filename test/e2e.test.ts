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

/**
 * 假 agent 预设：打一行 READY，然后逐行读 PTY 输入并回显 GOT:<正文>。
 *
 * 旧探针只是 `sleep 30`，不会读取 stdin；它只能证明 asd 接收了字节，证明不了 Enter
 * 真正触发提交。这个交互探针让 e2e 覆盖和 agent TUI 相同的「输入框 → Enter → 新输出」
 * 状态迁移，又不需要真的安装 claude / pi。
 */
const SH_PROBE_PRESETS: Record<string, AgentPreset> = {
  "sh-probe": {
    command: () => "sh -c 'exit 2'", // deliver: send 不走 argv；误走时让测试立即暴露。
    // raw PTY 探针：正文里的换行只回显，不触发提交；整个 session 的第一颗独立
    // CR 被静默吞掉，后续 CR 才打印 GOT。这样真实覆盖“第一颗 Enter 完全无效，
    // session 仍进入台账，调用方 peek 后可用 nav 只补 Enter、不重发正文”的恢复路径。
    bare:
      `node -e 'process.stdout.write("› "); process.stdin.setRawMode(true); let b=[]; let swallowed=false; ` +
      `process.stdin.on("data",d=>{for(const x of d){if(x===13){if(!swallowed){swallowed=true;continue} const s=Buffer.from(b).toString(); ` +
      `process.stdout.write("\\r\\nGOT:"+s.replace(/\\n/g,"\\\\n")+"\\r\\n› "); b=[]}else{b.push(x); ` +
      `process.stdout.write(Buffer.from([x]))}}})'`,
    piChild: false,
    deliver: "send",
  },
};

test("e2e：第一颗 Enter 被吞后保留控制权，可显式恢复并继续工作流", { timeout: 60_000 }, async (t) => {
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
    assert.equal(spawned.isError, true, "第一颗 Enter 无可见效果时必须停下来，不能自动补键");
    assert.equal(spawned.details?.phase, "submit");
    assert.equal(spawned.details?.pendingComposer, true);
    const session = "pi-e2e-one";
    assert.equal(session, "pi-e2e-one");
    assert.equal(registry.get(session)?.createdByUs, true, "失败后必须保留 nav/kill 权");
    const recovered = await tools.nav({ session, keys: ["Enter"] });
    assert.equal(recovered.isError, undefined, recovered.text);

    // 等 raw probe 把输入 prompt 打出来。
    const deadline = Date.now() + 10_000;
    let screen = "";
    while (Date.now() < deadline) {
      const r = await tools.peek({ session });
      screen = r.text;
      if (screen.includes("›")) break;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    assert.match(screen, /›/);
    assert.match(screen, /GOT:HELLO-E2E/, "初始任务必须由 Enter 真正提交给探针");

    const listed = await tools.agents();
    assert.match(listed.text, new RegExp(session));

    const allSessions = await tools.list();
    assert.match(allSessions.text, new RegExp(session));
    const sessionNames = allSessions.details?.sessions;
    assert.ok(Array.isArray(sessionNames), "asd_list 应该返回结构化 session 名数组");
    assert.ok(sessionNames.includes(session), "结构化结果也应该包含刚创建的 session");

    // 绕过 tools.spawn 直接建一个 session，模拟用户手工创建的长期员工。它没有
    // registry 记录，但显式点名时 peek / follow 都应该可用；follow 只挂后台
    // watcher，不会把它纳入复用/回收台账。
    const manual = await asd.create({ name: "manual", cwd: root, cmd: "sh -c 'echo MANUAL; sleep 30'" });
    const manualPeek = await tools.peek({ session: manual });
    assert.equal(manualPeek.isError, undefined, manualPeek.text);
    assert.match(manualPeek.text, /MANUAL/);

    const manualFollow = await tools.follow({ session: manual });
    assert.equal(manualFollow.isError, undefined, manualFollow.text);
    assert.match(manualFollow.text, /立即返回/);
    assert.equal(registry.get(manual), undefined, "后台监视不能把手工 session 纳入台账");
    assert.equal(watchers.isWatching(manual), true, "显式 follow 应该留下后台 watcher");
    const manualUnmonitor = await tools.unmonitor({ session: manual });
    assert.equal(manualUnmonitor.isError, undefined, manualUnmonitor.text);
    assert.equal(watchers.isWatching(manual), false, "unmonitor 应该停掉外部 session 的 watcher");
    await asd.kill(manual);

    const steered = await tools.steer({ session, message: "ping" });
    assert.equal(steered.isError, undefined, steered.text);
    const afterSteer = await tools.peek({ session });
    assert.match(afterSteer.text, /GOT:ping/, "steer 也必须由 Enter 真正提交给探针");
    watchers.stopAll();

    const killed = await tools.kill({ session });
    assert.equal(killed.isError, undefined, killed.text);
    assert.equal(registry.size, 0);

    // daemon 的 kill ACK 与 session 从 ListSessions 消失不是同一个原子动作；紧接着
    // list 偶尔还能看见旧条目几十毫秒。只等这个明确的状态收敛，不用固定 sleep。
    const goneDeadline = Date.now() + 2_000;
    let after = await asd.list();
    while (after.some((s) => s.session === session) && Date.now() < goneDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = await asd.list();
    }
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
