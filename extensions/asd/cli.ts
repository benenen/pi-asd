/**
 * `asd` 命令行的薄封装。
 *
 * 这里不 import 任何 pi 的东西 —— `exec` 是注入的，所以整层能用假 exec 测。
 * 唯一的知识点是 asd 的退出码约定（见仓库 crates/asd-cli/src/exit.rs）：
 *   0 成功 / 3 没有这个 session / 4 wait·follow 超时 / 其它都是 1。
 * 3 和 4 是**有语义的状态**，不是错误，所以它们被翻译成返回值而不是异常。
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

/** `asd` 不在 PATH 上。 */
export class AsdMissingError extends Error {
  constructor() {
    super("找不到 asd 命令。装一个再用 pi-asd：https://github.com/benenen/asd");
    this.name = "AsdMissingError";
  }
}

/** asd 以一个没有语义的非零码退出。 */
export class AsdError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "AsdError";
    this.code = code;
  }
}

/** `asd list --json` 的一行。字段名跟 asd 的 wire 格式走，故意不改成驼峰。 */
export interface SessionInfo {
  session: string;
  status: string;
  command: string;
  title: string;
  pid: number;
  cols: number;
  rows: number;
  created_ms: number;
  idle_ms: number;
  running: boolean;
  attached_clients: number;
}

export type FollowOutcome =
  | { kind: "settled"; text: string }
  | { kind: "timeout"; text: string }
  | { kind: "gone" };

export interface Asd {
  /** `asd new`；返回 asd 实际用的名字（它自己会回显到 stdout）。 */
  create(o: { name: string; cwd: string; cmd: string }): Promise<string>;
  list(): Promise<SessionInfo[]>;
  /** session 不存在时返回 null。 */
  peek(name: string, scrollback?: number): Promise<string | null>;
  /** session 不存在时返回 false。 */
  send(name: string, text: string): Promise<boolean>;
  follow(
    name: string,
    o: { forever?: boolean; timeout: string; signal?: AbortSignal },
  ): Promise<FollowOutcome>;
  /** session 本来就不存在时返回 false。 */
  kill(name: string): Promise<boolean>;
}

const NO_SESSION = 3;
const TIMEOUT = 4;
const NOT_FOUND = 127;

function isEnoent(e: unknown): boolean {
  if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT") return true;
  return e instanceof Error && /\bENOENT\b|command not found/i.test(e.message);
}

function fail(r: ExecResult, what: string): never {
  const detail = r.stderr.trim() || r.stdout.trim() || "（没有输出）";
  throw new AsdError(r.code, `asd ${what} 失败（退出码 ${r.code}）：${detail}`);
}

export function createAsd(exec: Exec): Asd {
  async function run(
    args: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    let r: ExecResult;
    try {
      r = await exec("asd", args, opts);
    } catch (e) {
      if (isEnoent(e)) throw new AsdMissingError();
      throw e;
    }
    if (r.code === NOT_FOUND) throw new AsdMissingError();
    return r;
  }

  return {
    async create({ name, cwd, cmd }) {
      const r = await run(["new", name, "--cwd", cwd, "--cmd", cmd]);
      if (r.code !== 0) fail(r, "new");
      const printed = r.stdout.trim();
      // asd 回显最终名字；万一它什么都没打，就退回我们请求的名字。
      return printed.length > 0 ? printed : name;
    },

    async list() {
      const r = await run(["list", "--json"]);
      if (r.code !== 0) fail(r, "list");
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        throw new AsdError(1, `asd list --json 的输出不是 JSON：${r.stdout.slice(0, 200)}`);
      }
      if (!Array.isArray(parsed)) {
        throw new AsdError(1, `asd list --json 应该给一个数组，实际拿到 ${typeof parsed}`);
      }
      return parsed as SessionInfo[];
    },

    async peek(name, scrollback) {
      const args = ["peek", name];
      if (scrollback !== undefined) args.push("--scrollback", String(scrollback));
      const r = await run(args);
      if (r.code === NO_SESSION) return null;
      if (r.code !== 0) fail(r, "peek");
      return r.stdout;
    },

    async send(name, text) {
      const r = await run(["send", name, "--text", text, "--enter"]);
      if (r.code === NO_SESSION) return false;
      if (r.code !== 0) fail(r, "send");
      return true;
    },

    async follow(name, { forever, timeout, signal }) {
      const args = ["follow", name];
      if (forever) args.push("--forever");
      args.push("--timeout", timeout);
      const r = await run(args, { signal });
      if (r.code === NO_SESSION) return { kind: "gone" };
      if (r.code === TIMEOUT) return { kind: "timeout", text: r.stdout };
      if (r.code !== 0) fail(r, "follow");
      return { kind: "settled", text: r.stdout };
    },

    async kill(name) {
      const r = await run(["kill", name]);
      if (r.code === NO_SESSION) return false;
      if (r.code !== 0) fail(r, "kill");
      return true;
    },
  };
}
