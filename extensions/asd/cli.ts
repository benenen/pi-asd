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

/**
 * `asd card list --json` 的一行 —— 一个 session"是干什么的"。
 *
 * `asd list` 回答"有哪些"，`asd card` 回答"这一个是为什么存在的"：它的工作
 * 目录，以及那个目录下的项目文档。挑一个已有 session 交任务时靠它。
 * **只对本地 daemon 可用**（目录是从 session 自己的进程读的）。
 */
export interface CardInfo {
  session: string;
  status: string;
  cwd: string;
  /** README.md / CLAUDE.md / AGENTS.md / CONTRIBUTING.md 里实际存在的那些。 */
  docs: string[];
}

/** `asd rename` 的结果。`failed` 带上 asd 自己的说明（重名 / 名字非法等）。 */
export type RenameOutcome =
  | { kind: "ok" }
  | { kind: "gone" }
  | { kind: "unsupported" }
  | { kind: "failed"; message: string };

export type FollowOutcome =
  | { kind: "settled"; text: string }
  | { kind: "timeout"; text: string }
  | { kind: "gone" };

/** `asd peek --json` 给出的终端光标位置（0-based）。 */
export interface ScreenCursor {
  row: number;
  col: number;
}

/** 投递校验既要屏幕文字，也要光标来定位真正的 composer。 */
export interface ScreenSnapshot {
  screen: string;
  cursor: ScreenCursor;
  rows: number;
  cols: number;
}

/** `asd peek --json --styles` 的半开终端 cell 范围（0-based）。 */
export interface ScreenStyleRange {
  row: number;
  startCol: number;
  endCol: number;
}

export interface StyledScreenSnapshot extends ScreenSnapshot {
  faintRanges: ScreenStyleRange[];
}

export interface Asd {
  /** `asd new`；返回 asd 实际用的名字（它自己会回显到 stdout）。 */
  create(o: { name: string; cwd: string; cmd: string }): Promise<string>;
  list(): Promise<SessionInfo[]>;
  /** `asd card list --json`：每个 session 的工作目录和项目文档。 */
  cards(): Promise<CardInfo[]>;
  /** session 不存在时返回 null。 */
  peek(name: string, scrollback?: number): Promise<string | null>;
  /** `asd peek --json`：保留光标位置，避免把历史区里的同任务文字误认成输入框回显。 */
  peekSnapshot(name: string): Promise<ScreenSnapshot | null>;
  /**
   * 带 SGR faint cell 范围的快照。null 表示 session 不在；undefined 表示 asd
   * 版本尚不支持 `--styles`。这个读取会临时 attach，但不会向 pty 发送输入。
   */
  peekStyledSnapshot(name: string): Promise<StyledScreenSnapshot | null | undefined>;
  /**
   * 送一段文本**并回车**。session 不存在时返回 false。
   *
   * 返回 true 只代表 asd 收下了，**不代表 agent 收到、更不代表它开始干活** ——
   * 见 `sendText` 上的说明。要确认投递成功必须自己 peek 校验。
   */
  send(name: string, text: string): Promise<boolean>;
  /**
   * 只送文本，不回车。session 不存在时返回 false。
   *
   * **返回 true 的语义仅仅是"asd 把字节排进了这个 session 的队列"。** 实测
   * asd 0.1.9 的 daemon（`crates/asd-daemon/src/conn.rs` 的 `Frame::SendInput`）
   * 拿到帧之后是 `let _ = handle.tx.send(...)` —— 连排队结果都丢弃 —— 紧接着
   * 无条件回 `Ack`；真正写 pty 在之后异步发生，失败只 `debug!` 一行。所以
   * 退出码 0 完全不能证明对方收到了。
   *
   * 拆出这个方法是为了在"文本已送、回车未送"那个窗口里做投递校验：回车会把
   * 输入框清空，一旦按下去，屏幕上有没有这段文本就再也分不出"没送到"和
   * "送到了并且已提交"。
   */
  sendText(name: string, text: string): Promise<boolean>;
  /** 送一个具名按键（Enter / Escape / Tab / C-c …）。session 不存在时返回 false。 */
  key(name: string, key: string): Promise<boolean>;
  follow(
    name: string,
    o: { forever?: boolean; timeout: string; signal?: AbortSignal },
  ): Promise<FollowOutcome>;
  /** session 本来就不存在时返回 false。 */
  kill(name: string): Promise<boolean>;
  /**
   * 改名。session 不存在返回 `"gone"`；装的 asd 太老、没有这个子命令返回
   * `"unsupported"`（别把它当成普通失败 —— 用户需要知道是去升级 asd，不是名字有问题）。
   */
  rename(name: string, newName: string): Promise<RenameOutcome>;
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

function parseScreenSnapshot(stdout: string, what: string): ScreenSnapshot & Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AsdError(1, `${what} 的输出不是 JSON：${stdout.slice(0, 200)}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { screen?: unknown }).screen !== "string" ||
    !Number.isInteger((parsed as { cursor?: { row?: unknown } }).cursor?.row) ||
    !Number.isInteger((parsed as { cursor?: { col?: unknown } }).cursor?.col) ||
    !Number.isInteger((parsed as { rows?: unknown }).rows) ||
    !Number.isInteger((parsed as { cols?: unknown }).cols)
  ) {
    throw new AsdError(1, `${what} 缺少 screen、cursor 或终端尺寸`);
  }
  const snapshot = parsed as ScreenSnapshot & Record<string, unknown>;
  if (
    snapshot.rows <= 0 ||
    snapshot.cols <= 0 ||
    snapshot.cursor.row < 0 ||
    snapshot.cursor.col < 0
  ) {
    throw new AsdError(1, `${what} 的 screen、cursor 或终端尺寸越界`);
  }
  return snapshot;
}

function stylesUnsupported(r: ExecResult): boolean {
  const detail = `${r.stderr}\n${r.stdout}`;
  return (
    r.code === 2 &&
    /(?:unexpected argument|unrecognized option|unknown option)[^\n]*--styles/i.test(detail)
  );
}

/**
 * 从 `asd follow --json` 的 JSONL stdout 里只挑出 `event:"output"` 的 `text`
 * 拼起来 —— 那是"滚出屏幕、不会再变"的过程输出，也是规格要的东西。
 *
 * 不用 `--raw`，所以 `screen`（每次暂停时的整屏快照，一次重绘一条而不是一帧
 * 一条）、`status`（running 翻转）、`exit`/`timeout` 都会混在同一个流里，但
 * 它们只用来判定状态，不该整坨灌回调用方 —— 不然一个会重绘的 TUI 随便一跑
 * 就是几十上百 KB 塞进 LLM 上下文，而其中能读的文字只有其中一小部分。
 *
 * 容错两件事：最后一行可能被截断（进程被杀/超时打断时 stdout 没收全），以及
 * 混进来的非 JSON 杂行 —— 两种情况都跳过这一行，不抛。
 */
export function parseFollowOutput(stdout: string): string {
  let out = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const { event, text } = obj as { event?: unknown; text?: unknown };
    if (event === "output" && typeof text === "string") out += text;
  }
  return out;
}

/**
 * 敲完文本到按下 Enter 之间等多久（毫秒）。
 *
 * **为什么必须分两次发、中间还要等。** `asd send --text X --enter` 会把正文和
 * CR 拼成**同一个 payload**，被控端一次 read() 就全收到了 —— 实测（429 字节正文）：
 *
 *   一次调用：C1 len=430 tail=…,0d cr=YES        ← 正文和 CR 同一个 chunk
 *   分两次：  C1 len=429 cr=no ；C2 len=1 cr=YES ← CR 是独立按键
 *
 * asd 自己的 `--enter` 帮助文本把这个语义写明了：让 session"see one keypress
 * rather than a line break and then Enter"。对 shell 是对的；但 agent 的 TUI
 * 输入框普遍按"一大坨字节一次到达"判定粘贴，于是那个尾部 CR 被当成粘贴内容里
 * 的换行插进输入框，**不触发提交**。症状就是"内容发过去了，但没有回车成功"，
 * 而且文本越长越容易命中 —— 这也是它表现为"有时候"的原因。
 *
 * 分两次发让 CR 成为一个独立的 1 字节 chunk，怎么看都是一次货真价实的按键。
 */
export const ENTER_DELAY_MS = 300;

export interface AsdOptions {
  /** 见 `ENTER_DELAY_MS`。传 0 表示不等（测试用）。 */
  enterDelayMs?: number;
  /** 等待实现；缺省真的 setTimeout。测试注入以免真的睡。 */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createAsd(exec: Exec, options: AsdOptions = {}): Asd {
  const enterDelayMs = options.enterDelayMs ?? ENTER_DELAY_MS;
  const sleep = options.sleep ?? realSleep;

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

  // 具名绑定：`send` 要复用 `sendText` / `key`，对象字面量里没有可引用的名字。
  const asd: Asd = {
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

    async cards() {
      const r = await run(["card", "list", "--json"]);
      if (r.code !== 0) fail(r, "card list");
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        throw new AsdError(1, `asd card list --json 的输出不是 JSON：${r.stdout.slice(0, 200)}`);
      }
      if (!Array.isArray(parsed)) {
        throw new AsdError(1, `asd card list --json 应该给一个数组，实际拿到 ${typeof parsed}`);
      }
      return parsed as CardInfo[];
    },

    async peek(name, scrollback) {
      const args = ["peek", name];
      if (scrollback !== undefined) args.push("--scrollback", String(scrollback));
      const r = await run(args);
      if (r.code === NO_SESSION) return null;
      if (r.code !== 0) fail(r, "peek");
      return r.stdout;
    },

    async peekSnapshot(name) {
      const r = await run(["peek", name, "--json"]);
      if (r.code === NO_SESSION) return null;
      if (r.code !== 0) fail(r, "peek --json");
      const snapshot = parseScreenSnapshot(r.stdout, "asd peek --json");
      return {
        screen: snapshot.screen,
        cursor: snapshot.cursor,
        rows: snapshot.rows,
        cols: snapshot.cols,
      };
    },

    async peekStyledSnapshot(name) {
      const r = await run(["peek", name, "--json", "--styles"]);
      if (r.code === NO_SESSION) return null;
      if (stylesUnsupported(r)) return undefined;
      if (r.code !== 0) fail(r, "peek --json --styles");
      const snapshot = parseScreenSnapshot(r.stdout, "asd peek --json --styles");
      if (snapshot.cursor.row >= snapshot.rows || snapshot.cursor.col > snapshot.cols) {
        throw new AsdError(1, "asd peek --json --styles 的 cursor 超出终端尺寸");
      }
      const wireRanges = snapshot.faint_ranges;
      if (!Array.isArray(wireRanges)) {
        throw new AsdError(1, "asd peek --json --styles 缺少 faint_ranges");
      }
      const faintRanges = wireRanges.map((value) => {
        const range = value as { row?: unknown; start_col?: unknown; end_col?: unknown };
        if (
          typeof value !== "object" ||
          value === null ||
          !Number.isInteger(range.row) ||
          !Number.isInteger(range.start_col) ||
          !Number.isInteger(range.end_col) ||
          (range.row as number) < 0 ||
          (range.row as number) >= snapshot.rows ||
          (range.start_col as number) < 0 ||
          (range.start_col as number) >= (range.end_col as number) ||
          (range.end_col as number) > snapshot.cols
        ) {
          throw new AsdError(1, "asd peek --json --styles 的 faint_ranges 格式或范围无效");
        }
        return {
          row: range.row as number,
          startCol: range.start_col as number,
          endCol: range.end_col as number,
        };
      });
      return {
        screen: snapshot.screen,
        cursor: snapshot.cursor,
        rows: snapshot.rows,
        cols: snapshot.cols,
        faintRanges,
      };
    },

    async sendText(name, text) {
      const r = await run(["send", name, "--text", text]);
      if (r.code === NO_SESSION) return false;
      if (r.code !== 0) fail(r, "send");
      return true;
    },

    async key(name, k) {
      const r = await run(["send", name, "--key", k]);
      if (r.code === NO_SESSION) return false;
      if (r.code !== 0) fail(r, `send（按键 ${k}）`);
      return true;
    },

    /**
     * 送一段文本并回车。**分两次发**，理由见 `ENTER_DELAY_MS`。
     *
     * 文本那一次失败就直接返回/抛出，不会去按那个 Enter —— 正文没进去的话，
     * 一个孤零零的回车只会在目标 session 里凭空提交一次它当时输入框里的东西。
     *
     * **要投递校验就别用这个**，用 `sendText` + 自己 peek + `key("Enter")`：
     * 回车一旦按下去输入框就被清空，之后再也分不出"没送到"和"送到了已提交"。
     */
    async send(name, text) {
      if (!(await asd.sendText(name, text))) return false;
      if (enterDelayMs > 0) await sleep(enterDelayMs);
      // 这个窗口期里 session 没了：正文已经进去了但没提交，如实报告"没送到"，
      // 别谎称成功 —— 调用方会据此清台账、停 watcher。
      return await asd.key(name, "Enter");
    },

    async follow(name, { forever, timeout, signal }) {
      const args = ["follow", name, "--json"];
      if (forever) args.push("--forever");
      args.push("--timeout", timeout);
      const r = await run(args, { signal });
      if (r.code === NO_SESSION) return { kind: "gone" };
      if (r.code === TIMEOUT) return { kind: "timeout", text: parseFollowOutput(r.stdout) };
      if (r.code !== 0) fail(r, "follow");
      return { kind: "settled", text: parseFollowOutput(r.stdout) };
    },

    async rename(name, newName) {
      const r = await run(["rename", name, newName]);
      if (r.code === 0) return { kind: "ok" };
      if (r.code === NO_SESSION) return { kind: "gone" };
      // clap 对认不出的子命令用退出码 2。装的 asd 太老时就是这条 —— 单独认出来，
      // 否则用户会拿着"改名失败"去查名字，而真正要做的是升级 asd。
      const out = `${r.stderr}${r.stdout}`;
      if (r.code === 2 || /unrecognized subcommand|unexpected argument/i.test(out)) {
        return { kind: "unsupported" };
      }
      return { kind: "failed", message: out.trim() || `退出码 ${r.code}` };
    },

    async kill(name) {
      const r = await run(["kill", name]);
      if (r.code === NO_SESSION) return false;
      if (r.code !== 0) fail(r, "kill");
      return true;
    },
  };
  return asd;
}
