/**
 * 七个工具的实际逻辑。
 *
 * 这里不 import pi —— 依赖全靠注入，所以整层能用假 exec 测，尤其是 kill 守卫
 * 那两条拒绝路径（必须证明"一次 asd kill 都没发生"）。
 */

import path from "node:path";
import type { Asd, SessionInfo } from "./cli.ts";
import type { Registry } from "./registry.ts";
import { formatDuration, type WatcherPool } from "./watcher.ts";

/**
 * 一个 session 至少要**连续安静**这么久，才当它是"停下来等输入"而不是"正在干活"。
 *
 * 为什么不能只看 `info.running`：实测 asd 0.1.9 的 `running`（以及 `status`）
 * 恒等于"`idle_ms` 小于约 2 秒"，它是"终端最近有动静"，**不是"进程在执行"**。
 * 一个跑着 `sleep 8` 的 session 在第 3.7 秒报的就是 `running: false` / `idle`。
 * 只看 `running` 的话，一个沉默思考了两秒多的 agent 就会被当成空闲，然后被自动
 * 复用、或者被列进 asd_candidates —— 任务直接 send 进去，打断它正在做的事。
 *
 * 15 秒是权衡：终端里两三秒的静默是常态（冷启动、两次工具调用之间、等 API），
 * 连续 15 秒一个字节都没有则大概率真的在等输入。
 *
 * **这条判据不可能完备，也不假装完备。** asd 只看得到终端字节，一个 shell 出去
 * 跑静默大编译的 agent 可以安静几分钟 —— 任何阈值都救不了那种情况。真正承重的
 * 是另一条：自动复用池只收 `createdByUs === true`，所以最坏情况是把两个任务叠进
 * 我们自己的 agent，绝不会叠进用户的会话。
 */
export const REUSE_MIN_IDLE_MS = 15_000;

/** 看起来是"停下来等输入"了。判据见 `REUSE_MIN_IDLE_MS`。 */
export function looksIdle(
  info: Pick<SessionInfo, "running" | "idle_ms">,
  minIdleMs: number = REUSE_MIN_IDLE_MS,
): boolean {
  // running 这一条在当前 asd 语义下已被 idle_ms 那条覆盖，留着是为了万一哪天
  // asd 把 running 改成真的"进程在执行"，这里能立刻跟着变严，而不是变松。
  return !info.running && info.idle_ms >= minIdleMs;
}

export interface ToolResult {
  text: string;
  details?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * 任务文本有没有真的出现在 agent 屏幕上。
 *
 * 归一化之后再比。要去掉的不只是空白：TUI 把输入框画成带边框的盒子，长文本在
 * 盒子里折行时**每一行两端都会插进边框字符**，原样 `includes` 几乎必然假阴性。
 * 这里的假阴性代价很实在 —— 会把一次成功的投递误报成"未投递成功"。
 *
 * 只取前 `SIGNATURE_CHARS` 个字符做特征：长任务在输入框里会被截断显示，拿整段
 * 去比同样是假阴性。
 */
const SIGNATURE_CHARS = 24;

/** 空白 + 制表符绘图区（U+2500–U+257F，各家 TUI 的边框）+ 几个常见装饰符。 */
const NOISE = /[\s─-╿│█│┃┆┊|>❯»·]+/g;

export function screenHasText(screen: string, text: string): boolean {
  const strip = (s: string): string => s.replace(NOISE, "");
  const needle = strip(text).slice(0, SIGNATURE_CHARS);
  return needle.length > 0 && strip(screen).includes(needle);
}

export type Delivery = { ok: true } | { ok: false; reason: string };

/**
 * 送按键之间的间隔。
 *
 * 逐个发、中间留空档，**不要**用 asd `--key` 的逗号分隔一次送一串：那样所有按键
 * 会在同一个 payload 里到达，TUI 按"一大坨字节一次到达"判定粘贴的老问题会再来
 * 一遍（见 `ENTER_DELAY_MS`）。而且对话框要时间重绘，连发容易把第二个键送进
 * 还没画出来的界面。
 */
export const NAV_KEY_DELAY_MS = 120;

/**
 * `asd_nav` 接受的按键名 → asd `--key` 认的名字。
 *
 * 同时收两套写法：调用方常写 `ArrowDown`（Web/DOM 那套），asd 自己叫 `Down`。
 * 与其让模型去记哪套对，不如两套都认。查表前统一转小写，大小写随便写。
 */
const NAV_KEY_ALIASES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  space: "Space",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  home: "Home",
  end: "End",
  up: "Up",
  arrowup: "Up",
  down: "Down",
  arrowdown: "Down",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
};

/** `C-a` … `C-z`：asd 原生支持，用来送 Ctrl 组合键。 */
const CTRL_KEY = /^c-([a-z])$/;

/** 给报错文案用的可选项清单。 */
export const NAV_KEY_NAMES = [
  "Enter",
  "Space",
  "Tab",
  "Escape",
  "Backspace",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "C-a..C-z",
];

export type NavKeys = { ok: true; keys: string[] } | { ok: false; message: string };

/**
 * 校验并翻译一串按键名。
 *
 * **认不出的名字一律拒绝，不猜、不跳过。** 这个工具是往别人的会话里按键，猜错
 * 一个键可能就确认了一个对话框；宁可让调用方看到报错重来，也不要送出一半。
 */
export function resolveNavKeys(raw: unknown): NavKeys {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: `keys 必须是非空数组。可用：${NAV_KEY_NAMES.join(" / ")}` };
  }
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k !== "string") {
      return { ok: false, message: `keys 里有非字符串项：${JSON.stringify(k)}` };
    }
    const norm = k.trim().toLowerCase();
    const ctrl = CTRL_KEY.exec(norm);
    if (ctrl !== null) {
      out.push(`C-${ctrl[1]}`);
      continue;
    }
    const mapped = NAV_KEY_ALIASES[norm];
    if (mapped === undefined) {
      return {
        ok: false,
        message: `不认识的按键 "${k}"。可用：${NAV_KEY_NAMES.join(" / ")}`,
      };
    }
    out.push(mapped);
  }
  return { ok: true, keys: out };
}


/**
 * agent 启动期可能挡在最前面的 UI（信任确认、首次引导之类）。
 *
 * 这类 UI 是**模态**的：它盖在输入框上层，任务文本会送到它后面，回车被它吃掉 ——
 * 而它的默认选项还可能是"退出"，于是 session 直接消失。所以必须先认出来、过掉，
 * 再投任务。
 */
export interface StartupDialog {
  /** 人话名字，进报错文案。 */
  what: string;
  /** 屏幕上出现它就认为撞上了。 */
  match: RegExp;
  /** 过掉它要送的具名按键，按顺序。 */
  keys: string[];
}

/** 新建 session 时任务怎么进到 agent 里。 */
export type Deliver =
  /** 拼进启动命令当 argv。省事，但 agent 必须真的消费那个 positional prompt。 */
  | "argv"
  /** 先裸启动 agent，等它就绪、过掉启动期 UI，再把任务打进去。 */
  | "send";

export interface AgentPreset {
  /** `escapedTask` 已经过 shellEscape，直接拼进去。`deliver: "argv"` 用。 */
  command(escapedTask: string): string;
  /** 不带任务、只把 agent 起起来的命令。`deliver: "send"` 时必须有。 */
  bare?: string;
  /** 是否注入 PI_SPAWNED / PI_PARENT_SESSION —— 只有 pi 子 agent 认这些。 */
  piChild: boolean;
  /** 缺省 `"argv"`。 */
  deliver?: Deliver;
  /** 启动期可能挡路的模态 UI，按顺序检查。 */
  startupDialogs?: StartupDialog[];
}

export const PRESETS: Record<string, AgentPreset> = {
  pi: { command: (t) => `pi ${t}`, piChild: true },
  claude: {
    command: (t) => `claude --dangerously-skip-permissions ${t}`,
    bare: "claude --dangerously-skip-permissions",
    piChild: false,
    // claude 在**没被信任过的目录**里会先弹信任确认，而 pi-asd 给每个新 session
    // 建的正是一个全新空目录 —— 所以它每次必然撞上。撞上时 argv 里的 prompt 永远
    // 轮不到执行，任务静默丢失；后续 steer 的文本还会打进那个编号菜单，可能选中
    // "2. No, exit" 把 session 直接关掉。
    //
    // 没有可用的 CLI 开关：`--dangerously-skip-permissions` 管的是权限不是信任；
    // 唯一能跳过信任确认的是 `-p`/非 TTY 的非交互模式，而子 agent 必须活着接受
    // 后续 steer，用不了。（另一条路是预先往 ~/.claude.json 写
    // `hasTrustDialogAccepted`，但那是 claude 自己在写的文件，并发改它有风险，
    // 而且格式随版本变 —— 没走。）
    deliver: "send",
    startupDialogs: [
      {
        what: "工作目录信任确认",
        match: /trust (this|the) folder|Do you trust the files/i,
        keys: ["Enter"],
      },
    ],
  },
  codex: { command: (t) => `codex ${t}`, piChild: false },
};

/** 单引号包裹；内部单引号用 `'\''` 这套 POSIX 写法断开再接上。 */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 从 `asd list --json` 的 `command`（pty 的前台进程）认出它跑的是哪个 agent 预设。
 *
 * 认不出来就返回 undefined。**这是个安全判断，不是便利判断**：认不出多半意味着
 * 那是个裸 shell，把任务描述 `send` 进去会被当成命令执行。宁可拒绝也不猜。
 */
export function agentOfCommand(
  command: string,
  presets: Record<string, AgentPreset>,
): string | undefined {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? "";
  return base.length > 0 && Object.hasOwn(presets, base) ? base : undefined;
}

export type AgentArg = { ok: true; agent: string } | { ok: false; message: string };

/**
 * 解析 `/asd:boss-start <agent>` 的参数。
 *
 * 空参数回到 `fallback`（环境变量或内置默认），**不沿用上一次的选择** —— 开关
 * 命令不该带隐藏状态，"不给参数"必须永远是同一个可预测的结果。
 */
export function resolveAgentArg(
  raw: string,
  fallback: string,
  presets: Record<string, AgentPreset>,
): AgentArg {
  const name = raw.trim();
  if (name.length === 0) return { ok: true, agent: fallback };
  if (!Object.hasOwn(presets, name)) {
    return {
      ok: false,
      message: `不认识的 agent "${name}"。可选：${Object.keys(presets).join(" / ")}`,
    };
  }
  return { ok: true, agent: name };
}

export interface BossDefault {
  enabled: boolean;
  /**
   * 环境变量是否真的给了值（trim 后非空）。
   *
   * 调用方必须用这个、而不是 `env.PI_ASD_BOSS !== undefined` 来判断"用户设了没"：
   * 后者挡不住 `PI_ASD_BOSS=`，那种空值会把配置文件里的 `bossMode.autoStart`
   * 无声压掉 —— 正是下面注释里要防的场景。
   *
   * 认不出来的值算"设了"：那条路径会强制关闭并弹提醒（"boss mode 保持关闭"），
   * 让配置文件在背后把它打开会让那句提醒变成谎话。
   */
  configured: boolean;
  /** 设了值但认不出来时带出原值，供调用方提醒 —— 静默忽略配置是个坑。 */
  unrecognized?: string;
}

const BOSS_TRUE = new Set(["1", "true", "on", "yes"]);
const BOSS_FALSE = new Set(["0", "false", "off", "no"]);

/**
 * 解析 `PI_ASD_BOSS`：boss mode 装好之后是否默认开启。
 *
 * 注意空串必须当成"没设置"。`env.X ?? default` 只挡 undefined/null，挡不住
 * `PI_ASD_BOSS=`（.env 里的空行、`docker -e VAR=`、未展开的 shell 变量）——那种
 * 空值一路穿过去会变成意外开启。
 */
export function parseBossDefault(raw: string | undefined): BossDefault {
  const v = (raw ?? "").trim().toLowerCase();
  if (v.length === 0) return { enabled: false, configured: false };
  if (BOSS_TRUE.has(v)) return { enabled: true, configured: true };
  if (BOSS_FALSE.has(v)) return { enabled: false, configured: true };
  return { enabled: false, configured: true, unrecognized: raw ?? "" };
}

/**
 * `/asd:boss-start` 执行后的提示。
 *
 * 三种情况必须分开说：把"本来就开着"说成"设为 X"会让用户以为操作没生效、或者
 * 以为改了什么其实没改的东西。
 */
export function bossStartMessage(o: { wasOn: boolean; from: string; to: string }): string {
  if (!o.wasOn) {
    return `boss mode 已打开，默认 agent ${o.to}。下一轮起会注入拆任务和监控的提示词。`;
  }
  if (o.from === o.to) {
    return `boss mode 已经开着，默认 agent 仍是 ${o.to}。`;
  }
  return `boss mode 已经开着；默认 agent 从 ${o.from} 改成 ${o.to}。`;
}

/**
 * 把环境变量前缀拼到命令前面（`asd new --cmd` 是交给 `sh -c` 跑的，所以
 * `K=V cmd` 这种写法有效）。
 *
 * **为什么必须显式带上，而不是指望继承。** 子 agent 是 asd **daemon** fork 出来的，
 * 继承的是 daemon 的环境 —— 那个 daemon 可能是几天前、从另一个 shell 里起来的，
 * 跟 pi 自己的环境毫无关系。实测踩到过：本机以 root 运行，`claude` 在没有
 * `IS_SANDBOX=1` 时会直接拒绝 `--dangerously-skip-permissions`（"cannot be used
 * with root/sudo privileges"）并**立即退出** —— 表现就是 spawn 出来的 session
 * 一秒就消失；而缺 `HTTPS_PROXY` 则是起得来但 API 403。两个变量在用户的交互
 * shell 里有（`clp` 别名设的），在 daemon 里没有。
 */
export function withEnv(env: Record<string, string> | undefined, cmd: string): string {
  const pairs = Object.entries(env ?? {}).filter(([, v]) => v.length > 0);
  if (pairs.length === 0) return cmd;
  return `${pairs.map(([k, v]) => `${k}=${shellEscape(v)}`).join(" ")} ${cmd}`;
}

export function buildSpawnCommand(o: {
  agent: string;
  task: string;
  parentSession?: string;
  /** 预设表；缺省用模块级 `PRESETS`。测试（尤其 e2e）可以传自己的一份，不碰全局状态。 */
  presets?: Record<string, AgentPreset>;
  /** 透传给子 agent 的环境变量，见 `withEnv`。 */
  env?: Record<string, string>;
}): string {
  const presets = o.presets ?? PRESETS;
  const preset = presets[o.agent];
  if (!preset) throw new Error(`不认识的 agent：${o.agent}`);
  const parts: string[] = [];
  if (preset.piChild) {
    parts.push("PI_SPAWNED=1");
    if (o.parentSession !== undefined) {
      parts.push(`PI_PARENT_SESSION=${shellEscape(o.parentSession)}`);
    }
  }
  parts.push(preset.command(shellEscape(o.task)));
  return withEnv(o.env, parts.join(" "));
}

/**
 * 用**交互式** bash 跑一条命令，好让 shell 别名展开。
 *
 * 别名只在交互式 bash 里存在：`/bin/sh` 在很多系统上是 dash（本机就是），而
 * 非交互的 bash 既不 source `~/.bashrc` 也不展开别名。实测（真 pty 里，
 * daemon 环境已剥干净）：
 *
 *   clp                      → session 立刻消失（command not found）
 *   sh -c 'clp'              → session 立刻消失（command not found）
 *   bash -ic 'clp'           → 起得来，别名带的环境变量也生效
 *
 * 代价：会 source 整个 `~/.bashrc`。好处是 `asd list` 报的前台进程仍是被 exec
 * 的那个真命令（实测 `bash -ic 'clp'` 报的是 `claude --dangerously-skip-permissions`），
 * 所以 `agentOfCommand` 照样认得出，收养/候选那套判断不受影响。
 */
export function bashInteractive(cmd: string): string {
  return `bash -ic ${shellEscape(cmd)}`;
}

/** 把一个预设改成走本机别名/包装命令启动。 */
export function withAlias(base: AgentPreset, alias: string): AgentPreset {
  return {
    ...base,
    command: (escapedTask) => bashInteractive(`${alias} ${escapedTask}`),
    bare: bashInteractive(alias),
  };
}

export interface ToolConfig {
  defaultAgent: string;
  /**
   * 新 agent 的工作区基坐目录。不显式给 `cwd` 的 spawn 会拿到
   * `<workspaceBase>/<session 名>` —— 每个 agent 一个独立目录，免得多个 agent
   * 挤在同一个工作树上互相踩（尤其 git：共用一个 index 和 HEAD）。
   */
  workspaceBase: string;
  followTimeout: string;
  /** boss 自己的 session 文件，spawn pi 子 agent 时传下去。 */
  parentSession?: string;
  /**
   * boss 自己所在的 asd session 名（`$ASD_SESSION`）。`tools.ts` 不读
   * `process.env` —— 这是唯一入口，由 `index.ts` 读了环境变量再注入进来。
   * `adopt()` 靠它挡住"把任务交给 boss 自己"这个连提示词都说了"不要"、但没有
   * 代码兜底的动作。
   */
  bossSession?: string;
  /**
   * 预设表；缺省用模块级 `PRESETS`。
   *
   * 只给测试用（尤其 e2e 需要一个不用真起 claude/pi 的假 agent 预设）——
   * 直接改模块级 `PRESETS` 会污染所有共享它的测试/调用方，这个字段让调用方
   * 传一份自己的表，不碰全局状态。
   */
  presets?: Record<string, AgentPreset>;
  /**
   * 认定"停下来等输入"所需的最短连续静默；缺省 `REUSE_MIN_IDLE_MS`。
   * 主要给测试用 —— 单测不想为了跨过 15 秒这道门槛去编造巨大的 idle_ms。
   */
  reuseMinIdleMs?: number;
  /**
   * 透传给每个新 agent 的环境变量。**由 index.ts 从它自己的 process.env 里挑好
   * 注入进来** —— `tools.ts` 不读 process.env。
   *
   * 必须显式带：子 agent 是 asd daemon fork 的，继承的是 daemon 的环境，不是 pi 的。
   * 详见 `withEnv`。
   */
  spawnEnv?: Record<string, string>;
}

export interface ToolDeps {
  asd: Asd;
  registry: Registry;
  watchers: WatcherPool;
  config: ToolConfig;
  /** 建目录（含父目录）。`asd new --cwd` 对不存在的目录会直接失败。 */
  mkdirp: (dir: string) => Promise<void>;
  now: () => number;
  /**
   * 等待。测试注入成 no-op —— 投递校验和启动等待都要真的让时间过去，
   * 不注入的话单测会真睡好几秒。
   */
  sleep?: (ms: number) => Promise<void>;
}

/** 送出文本之后、peek 校验之前等多久，给 TUI 一点渲染时间。 */
export const ECHO_WAIT_MS = 400;
/** 裸启动之后最多等 agent 就绪多久。 */
export const STARTUP_TIMEOUT_MS = 90_000;
/** 启动期轮询间隔。 */
export const STARTUP_POLL_MS = 700;

export interface SpawnParams {
  task: string;
  /**
   * 指名把任务交给这个**已经存在**的 session（可以不是 pi-asd 自己创建的）。
   * 给了它就走"指名交给"这条路，不做自动复用、也不新建。
   */
  session?: string;
  name?: string;
  cwd?: string;
  agent?: string;
  watch?: boolean;
  reuse?: boolean;
  /**
   * 覆盖这一次的 session 名前缀。**传 `""` 就是不加前缀**。
   *
   * 不给就用全局配置的（`PI_ASD_PREFIX` / `prefix`，默认 `pi-`）。前缀纯粹是命名
   * 约定，没有任何安全判断依赖它 —— "能不能 kill / 能不能自动复用"看的是台账里的
   * `createdByUs`，不是名字长什么样。
   */
  prefix?: string;
  /**
   * 长期员工：不被空闲回收器超时收掉。默认 false。
   *
   * 适合"长期负责某个项目"的 agent。注意它只挡自动回收，`asd_kill` 照样能结束它。
   */
  persistent?: boolean;
}

export interface Tools {
  spawn(p: SpawnParams): Promise<ToolResult>;
  agents(): Promise<ToolResult>;
  candidates(p: { cwd?: string }): Promise<ToolResult>;
  peek(p: { session: string; scrollback?: number }): Promise<ToolResult>;
  follow(p: { session: string; mode?: "settle" | "end"; timeout?: string }): Promise<ToolResult>;
  steer(p: { session: string; message: string }): Promise<ToolResult>;
  nav(p: { session: string; keys: unknown }): Promise<ToolResult>;
  unadopt(p: { session: string }): Promise<ToolResult>;
  kill(p: { session: string }): Promise<ToolResult>;
}

const TASK_PREVIEW_MAX = 80;

function err(text: string): ToolResult {
  return { text, isError: true };
}

function preview(task: string): string {
  const line = task.replace(/\s+/g, " ").trim();
  return line.length <= TASK_PREVIEW_MAX ? line : `${line.slice(0, TASK_PREVIEW_MAX)}…`;
}

export function createTools(deps: ToolDeps): Tools {
  const { asd, registry, watchers, config, mkdirp, now } = deps;
  const presets = config.presets ?? PRESETS;
  const minIdleMs = config.reuseMinIdleMs ?? REUSE_MIN_IDLE_MS;

  /**
   * 并发 spawn 之间的临界区屏障：正在处理中、还没落盘到 registry 的 session
   * 名字（复用目标的名字，或者刚 allocateName 出来还没 asd create 完的新名字）。
   *
   * pi 扩展的并发工具执行模型下，同一条助手消息里的多个 `asd_spawn` 是并发跑
   * 的，会在同一份 `await asd.list()` 快照上各自决策 —— 不设这道屏障，两个
   * 并发 spawn 可能抢中同一个空闲 agent（都 send 进去，后者覆盖前者的任务），
   * 或者撞同一个新名字（第二个 `asd new` 被拒）。这个集合只活在这一个
   * `createTools` 实例的闭包里，不是模块级全局，避免多个实例互相干扰。
   */
  const reserved = new Set<string>();

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /**
   * 把一段文本投进 session，**并校验它真的进去了**。
   *
   * 为什么不能直接用 `asd.send`：那个方法返回 true 只代表 asd 把字节排进了队列
   * （daemon 是 `let _ = tx.send(...)` 之后无条件 Ack，见 cli.ts `sendText` 的
   * 注释），既不代表 agent 收到、更不代表它开始干活。pi-asd 以前拿它当"已送达"，
   * 于是任务丢了也照报"已派出 xxx"，然后你干等一个永远不来的结果。
   *
   * 校验必须卡在"文本已送、回车未送"这个窗口里 —— 回车会清空输入框，按下去之后
   * 屏幕上有没有这段文本就再也分不出"没送到"和"送到了并且已提交"。
   *
   * 校验不过就**不按回车**：此刻输入框里是别的东西（比如一个模态对话框），
   * 那一下回车会去提交/确认那个别的东西。同 cli.ts 里"正文没进去就别按回车"。
   */
  async function deliver(session: string, text: string): Promise<Delivery> {
    if (!(await asd.sendText(session, text))) {
      return { ok: false, reason: `"${session}" 的 session 已经不在了` };
    }
    await sleep(ECHO_WAIT_MS);

    const screen = await asd.peek(session);
    if (screen === null) return { ok: false, reason: `"${session}" 的 session 已经不在了` };
    if (!screenHasText(screen, text)) {
      return {
        ok: false,
        reason:
          `任务文本没有出现在 "${session}" 的屏幕上 —— 它没被 agent 的输入框收下。` +
          `没有按回车（此刻输入框里可能是别的东西，回车会误触它）。` +
          `用 asd_peek("${session}") 看看它卡在什么界面上。`,
      };
    }

    if (!(await asd.key(session, "Enter"))) {
      return { ok: false, reason: `"${session}" 在按回车之前消失了；任务未提交` };
    }
    return { ok: true };
  }

  /**
   * 裸启动之后等 agent 就绪，顺手过掉启动期的模态 UI。
   *
   * 就绪的判据只能是"屏幕上有东西了" —— 各家 TUI 没有统一的 ready 信号，而按
   * 渲染文案认每个 agent 的具体界面是条会随上游改版静默失效的路，不走。
   */
  async function prepare(session: string, preset: AgentPreset): Promise<Delivery> {
    const deadline = now() + STARTUP_TIMEOUT_MS;
    const dismissed = new Set<string>();
    let sawAnything = false;

    while (now() < deadline) {
      const screen = await asd.peek(session);
      if (screen === null) return { ok: false, reason: `"${session}" 启动过程中就消失了` };

      const dialog = (preset.startupDialogs ?? []).find((d) => d.match.test(screen));
      if (dialog !== undefined) {
        if (dismissed.has(dialog.what)) {
          return {
            ok: false,
            reason: `"${session}" 停在「${dialog.what}」上，送了 ${dialog.keys.join("+")} 也没过去`,
          };
        }
        for (const k of dialog.keys) {
          if (!(await asd.key(session, k))) {
            return { ok: false, reason: `"${session}" 在过「${dialog.what}」时消失了` };
          }
        }
        dismissed.add(dialog.what);
        await sleep(STARTUP_POLL_MS);
        continue;
      }

      // 屏幕上有内容、且没有已知对话框挡着 —— 认为可以收输入了。
      if (screen.trim().length > 0) {
        if (sawAnything) return { ok: true };
        // 多看一轮：第一帧可能正好是对话框还没画出来的空档。
        sawAnything = true;
      }
      await sleep(STARTUP_POLL_MS);
    }
    return { ok: false, reason: `"${session}" 在 ${STARTUP_TIMEOUT_MS / 1000}s 内没有就绪` };
  }

  /** 台账里没有就拒绝 —— peek / follow / steer 共用。 */
  function requireKnown(session: string): ToolResult | undefined {
    if (registry.get(session) !== undefined) return undefined;
    const known = registry.names();
    return err(
      `"${session}" 不是本次 spawn 出来的 agent，不会碰它。` +
        `当前台账：${known.length > 0 ? known.join(" / ") : "（空）"}`,
    );
  }

  /** session 在 asd 里没了：清台账、停 watcher，返回一句说明。 */
  function dropGone(session: string): ToolResult {
    registry.remove(session);
    watchers.stop(session);
    return { text: `"${session}" 的 session 已结束，已从台账移除。` };
  }

  function rewatch(session: string, want: boolean): boolean {
    watchers.stop(session);
    return want ? watchers.watch(session) : false;
  }

  /**
   * 指名把任务交给一个已存在的空闲 session。任何校验不过都不发送任何东西。
   *
   * 屏障必须在第一次 `await` 之前**同步**占住：`reserved.has` 检查和
   * `reserved.add` 中间不能有任何 await 缝隙，否则两个并发交给同一个 session
   * 的请求会都通过入口检查（这里以前就是这么错的 —— `reserved.add` 挪到了
   * `await asd.list()`/`await asd.cards()` 之后，两次并发调用都能挤过
   * `reserved.has` 那道同步检查，各自 await 完再各自 `send`，导致同一个
   * session 背靠背收到两段不相关的任务文本）。占位之后所有校验失败/成功的
   * 分支都用同一层 `try/finally` 收尾，不再叠一层嵌套的 try/finally。
   */
  async function adopt(session: string, task: string, wantWatch: boolean): Promise<ToolResult> {
    // 代码层面兜底：绝不把任务交给 boss 自己所在的 session。提示词里也这么说，
    // 但那只是"建议"；万一模型没看、看漏了、或者干脆决定赌一把，这里必须硬挡
    // 住 —— 交给自己会让 boss 把任务描述当输入敲进自己正在跑的终端。
    if (config.bossSession !== undefined && session === config.bossSession) {
      return err(`"${session}" 是你自己所在的 session，不能把任务交给自己。`);
    }
    if (reserved.has(session)) {
      return err(`"${session}" 正在被另一次 spawn 处理，稍后再试。`);
    }
    reserved.add(session);
    try {
      const live = await asd.list();
      const info = live.find((s) => s.session === session);
      if (info === undefined) {
        // 这条报错要顺手把"接下来该干什么"说死。模型在这里最容易自作主张：
        // 要么改派给一个看起来差不多的 session，要么拿这个名字新建一个 ——
        // 两种做法用户都会以为任务进了它点名的那个会话，而实际上没有。
        return err(
          `asd 里没有叫 "${session}" 的 session。别改派给别的，也别拿这个名字新建 —— ` +
            `先用 asd_candidates 看看有哪些能接活，把名字告诉用户，让它来定。`,
        );
      }
      if (!looksIdle(info, minIdleMs)) {
        // 两种情况分开说：终端还在动是明确的"在干活"；刚安静下来几秒则是
        // "看不出来"——asd 分不出它是等输入还是在沉默地跑一个命令，
        // 所以宁可拒绝。见 REUSE_MIN_IDLE_MS。
        //
        // 第一句必须说清：session 是存在的，只是不空闲 —— 避免模型/人误读成
        // "session 不存在"然后自作主张去新建或改派。
        const why = info.running
          ? "正在干活"
          : `才安静了 ${formatDuration(info.idle_ms)}，看不出是等输入还是在沉默地跑命令`;
        return err(
          `"${session}" 是存在的，但${why}，不会打断它。如果是用户点名要它，` +
            `把这个情况告诉用户，让它决定是等它闲下来、换一个、还是新建。`,
        );
      }
      const agent = agentOfCommand(info.command, presets);
      if (agent === undefined) {
        return err(
          `认不出 "${session}" 里跑的是哪个 agent（前台进程是 ${info.command}）。` +
            `往裸 shell 里送任务描述会被当命令执行，所以拒绝。`,
        );
      }
      const cards = await asd.cards();
      const card = cards.find((c) => c.session === session);
      if (card === undefined) {
        return err(`拿不到 "${session}" 的 card（工作目录），不会盲发任务。asd card 只对本地 daemon 可用。`);
      }

      const known = registry.get(session);
      const sent = await deliver(session, task);
      if (!sent.ok) {
        // 投递失败时不要留下"已派出"的假象：台账里那条要清掉、watcher 要停。
        if (known !== undefined) {
          registry.remove(session);
          watchers.stop(session);
        }
        return err(`任务未投递成功：${sent.reason}`);
      }
      if (known === undefined) {
        registry.add({
          session,
          task,
          cwd: card.cwd,
          agent,
          createdAt: now(),
          // 不是我们建的 —— asd_kill 从此永远拒绝它。
          createdByUs: false,
        });
      } else {
        known.task = task;
      }
      const watching = rewatch(session, wantWatch);
      const mine = known?.createdByUs === true;
      return {
        text:
          `任务已送给 "${session}"（${agent}，${card.cwd}）。` +
          (mine ? "" : `这个 session 不是 pi-asd 自己创建的，asd_kill 关不掉它。`) +
          (watching ? "watcher 已挂上，它停下来时结果会自动推给你。" : ""),
        details: { session, agent, cwd: card.cwd, adopted: !mine, watching },
      };
    } finally {
      reserved.delete(session);
    }
  }

  return {
    async spawn(p) {
      if (typeof p.task !== "string" || p.task.trim().length === 0) {
        return err("task 不能为空 —— 派给 agent 的任务描述必须自包含。");
      }
      // 指名交给已有 session：走完就返回，不做自动复用、也不新建。
      if (p.session !== undefined) {
        return await adopt(p.session, p.task, p.watch !== false);
      }
      const agent = p.agent ?? config.defaultAgent;
      if (!presets[agent]) {
        return err(`不认识的 agent "${agent}"。可选：${Object.keys(presets).join(" / ")}`);
      }
      const explicitCwd = typeof p.cwd === "string" && p.cwd.trim().length > 0
        ? p.cwd
        : undefined;
      const wantWatch = p.watch !== false;

      const live = await asd.list();
      const liveMap = new Map(live.map((s) => [s.session, s]));

      // 本次 spawn 预留的名字/session —— 无论成功、失败、还是复用转新建的
      // 中途改道，收尾时都必须放行，否则一次失败就永久占住一个名字。
      //
      // 用一个 Set 而不是单个变量：新建路径上 `allocateName` 算出的 `name`
      // 和 `asd new` 实际回显的 `session` 可能不是同一个字符串（asd 自己也
      // 可能做避重/改写），这道屏障挡的是"接下来会落进 registry 的那个
      // key"——只占 `name` 不占回显的 `session`，会在两者之间露出一条缝隙，
      // 让并发的另一个 spawn 在这条缝隙里摸到同一个 session。
      const heldNames = new Set<string>();
      const hold = (n: string): void => {
        heldNames.add(n);
        reserved.add(n);
      };
      const release = (n: string): void => {
        heldNames.delete(n);
        reserved.delete(n);
      };
      try {
        if (p.reuse !== false) {
          // 并发的另一个 spawn 可能已经在这份快照上预订了某个空闲 agent ——
          // 从候选池里摘掉，避免两边挑中同一个 session（registry.pickReusable
          // 对不在 map 里的条目本来就会跳过，不需要改它的签名）。
          //
          // 同一个 map 上顺手把"安静得还不够久"的也摘掉：pickReusable 只看
          // `info.running`，而那个字段分不出"等输入"和"沉默地在跑命令"。策略
          // 收在这一处，registry 那层不用知道这条规则。见 REUSE_MIN_IDLE_MS。
          const available = new Map(liveMap);
          for (const s of reserved) available.delete(s);
          for (const [name, info] of liveMap) {
            if (!looksIdle(info, minIdleMs)) available.delete(name);
          }

          const target = registry.pickReusable(
            {
              name: p.name === undefined ? undefined : registry.candidateName(p.name, p.prefix),
              agent,
              cwd: explicitCwd,
            },
            available,
          );
          if (target !== undefined) {
            hold(target.session);
            const sent = await deliver(target.session, p.task);
            if (sent.ok) {
              target.task = p.task;
              const watching = rewatch(target.session, wantWatch);
              return {
                text:
                  `复用空闲 agent "${target.session}"（${agent}，${target.cwd}），任务已送入。` +
                  (watching ? "watcher 已重挂，它停下来时结果会自动推给你。" : ""),
                details: { session: target.session, agent, cwd: target.cwd, reused: true, watching },
              };
            }
            // 没投进去 —— 清掉它、放行预留，继续往下走新建。这条路径上"改道新建"
            // 是安全的：任务一个字都没提交进去，不会出现两处都在跑同一个任务。
            registry.remove(target.session);
            watchers.stop(target.session);
            release(target.session);
          }
        }

        // 并发的另一个 spawn 可能已经预留了一个候选名字 —— 并进 taken，逼
        // allocateName 避开它，不然两边会算出同一个名字、第二次 asd new 被拒。
        const taken = new Set([...liveMap.keys(), ...reserved]);
        const name = registry.allocateName(p.name, taken, p.prefix);
        hold(name);
        // 没显式给 cwd 就给它一个自己的工作区。asd new 对不存在的目录直接失败，
        // 所以必须先建出来。显式给的路径不替他建 —— 打错了应当大声失败。
        const cwd = explicitCwd ?? path.join(config.workspaceBase, name);
        if (explicitCwd === undefined) await mkdirp(cwd);
        // 任务怎么进 agent，由 preset 决定：
        //  - argv（缺省）：拼进启动命令，agent 一起来就带着任务
        //  - send：先裸启动，等就绪、过掉启动期模态 UI，再把任务打进去
        //    （claude 走这条 —— 它在未信任目录里会先弹信任确认，挡在输入框前面，
        //     argv 里的 prompt 永远轮不到执行）
        const preset = presets[agent]!;
        const viaSend = preset.deliver === "send" && preset.bare !== undefined;
        const cmd = viaSend
          ? // 裸启动这条路也必须带上 env —— 它绕开了 buildSpawnCommand
            withEnv(config.spawnEnv, preset.bare!)
          : buildSpawnCommand({
              agent,
              task: p.task,
              parentSession: config.parentSession,
              presets,
              env: config.spawnEnv,
            });
        const session = await asd.create({ name, cwd, cmd });
        if (session !== name) hold(session);

        if (viaSend) {
          const ready = await prepare(session, preset);
          if (!ready.ok) {
            // 起没起来都不留台账记录 —— 留下就等于宣称"已派出"。session 本身
            // 不动：可能还活着，用户可以 asd attach 进去看它卡在哪。
            return err(`任务未投递成功：${ready.reason}`);
          }
          const sent = await deliver(session, p.task);
          if (!sent.ok) return err(`任务未投递成功：${sent.reason}`);
        }

        registry.add({
          session,
          task: p.task,
          cwd,
          agent,
          createdAt: now(),
          createdByUs: true,
          persistent: p.persistent === true,
        });
        const watching = rewatch(session, wantWatch);
        return {
          text:
            `已 spawn agent "${session}"（${agent}，${cwd}）。` +
            (watching ? "watcher 已挂上，它停下来时结果会自动推给你。" : ""),
          details: { session, agent, cwd, command: cmd, reused: false, watching },
        };
      } finally {
        for (const n of heldNames) reserved.delete(n);
      }
    },

    async agents() {
      if (registry.size === 0) return { text: "没有 spawn 出来的 agent。", details: { count: 0 } };

      const live = await asd.list();
      const liveMap = new Map(live.map((s) => [s.session, s]));
      const gone = registry.reconcile(new Set(liveMap.keys()));
      for (const g of gone) watchers.stop(g.session);

      const lines = registry.list().map((r) => {
        const info = liveMap.get(r.session)!;
        const state = info.running ? "running" : `idle ${formatDuration(info.idle_ms)}`;
        // 台账里不记 watching —— WatcherPool 才是唯一真相，读它，不读一份会
        // 漂移的影子状态（watcher 自然超时收尾不会回写台账，之前就是这么
        // 撒谎的：早就没人在等了，这里还在说"watcher 已挂"）。
        const w = watchers.isWatching(r.session) ? " watcher" : "";
        // 标出长期员工：boss 需要知道谁不会被空闲回收掉，否则会对"这个怎么一直在"
        // 产生误解，或者反过来以为某个临时 agent 能一直留着。
        const p = r.persistent === true ? " persistent" : "";
        return `${r.session} [${state}${w}${p}] (${r.agent}, ${r.cwd}): ${preview(r.task)}`;
      });
      const goneLine =
        gone.length > 0 ? `\n已结束：${gone.map((g) => g.session).join(" / ")}` : "";

      return {
        text: (lines.length > 0 ? lines.join("\n") : "没有存活的 agent。") + goneLine,
        details: { count: lines.length, ended: gone.map((g) => g.session) },
      };
    },

    async candidates(p) {
      const [cards, live] = await Promise.all([asd.cards(), asd.list()]);
      const cardBy = new Map(cards.map((c) => [c.session, c]));

      const rows: {
        session: string;
        cwd: string;
        docs: string[];
        title: string;
        agent: string;
        idleMs: number;
        mine: boolean;
      }[] = [];
      for (const info of live) {
        // 只看 running 会把"沉默思考了两秒多"的 agent 列成候选，boss 一交任务
        // 就打断它。见 REUSE_MIN_IDLE_MS。
        if (!looksIdle(info, minIdleMs)) continue;
        const agent = agentOfCommand(info.command, presets);
        if (agent === undefined) continue;
        const card = cardBy.get(info.session);
        if (card === undefined) continue;
        if (p.cwd !== undefined && card.cwd !== p.cwd) continue;
        rows.push({
          session: info.session,
          cwd: card.cwd,
          docs: card.docs,
          title: info.title,
          agent,
          idleMs: info.idle_ms,
          // "mine" 是"asd_kill 能不能碰它"的判据，不是"台账里有没有它"——
          // 指名交过任务的 session 也在台账里，但 createdByUs 是 false，仍然不能 kill。
          mine: registry.get(info.session)?.createdByUs === true,
        });
      }
      rows.sort((a, b) => b.idleMs - a.idleMs);

      if (rows.length === 0) {
        return {
          text:
            p.cwd === undefined
              ? "没有空闲且能接活的 session。"
              : `${p.cwd} 下没有空闲且能接活的 session。`,
          details: { count: 0 },
        };
      }

      const lines = rows.map((r) => {
        const head = `${r.session}（${r.agent}，闲了 ${formatDuration(r.idleMs)}${
          r.mine ? "" : "，不是自己创建的：交给它之后也不能 kill"
        }）`;
        const parts = [head, `  目录：${r.cwd}`];
        if (r.docs.length > 0) parts.push(`  文档：${r.docs.join(" ")}`);
        if (r.title.length > 0) parts.push(`  正在做：${r.title}`);
        return parts.join("\n");
      });
      return {
        text: lines.join("\n"),
        details: { count: rows.length, sessions: rows.map((r) => r.session) },
      };
    },

    async peek(p) {
      const bad = requireKnown(p.session);
      if (bad) return bad;
      const screen = await asd.peek(p.session, p.scrollback);
      if (screen === null) return dropGone(p.session);
      return { text: screen, details: { session: p.session } };
    },

    async follow(p) {
      const bad = requireKnown(p.session);
      if (bad) return bad;
      // 这个工具自己也会在 p.session 上跑一个 `asd follow`，跟后台 watcher
      // 抢同一个 session 的 follow 流 —— 不停掉的话两边都在等，同一次停下会
      // 被通知两遍（一遍是这次工具调用的返回值，一遍是 watcher 的 notify）。
      // 记住原来挂没挂着，等这次阻塞的 follow 完事再按原状态重挂。
      const wasWatching = watchers.isWatching(p.session);
      watchers.stop(p.session);
      let stillAlive = true;
      try {
        const outcome = await asd.follow(p.session, {
          forever: p.mode === "end",
          timeout: p.timeout ?? config.followTimeout,
        });
        if (outcome.kind === "gone") {
          stillAlive = false;
          return dropGone(p.session);
        }

        const screen = await asd.peek(p.session);
        const head =
          outcome.kind === "timeout"
            ? `"${p.session}" 还在忙（follow 超时）。`
            : `"${p.session}" 已停下。`;
        return {
          text:
            `${head}\n--- 过程输出 ---\n${outcome.text}\n` +
            `--- 最后一屏 ---\n${screen ?? "(session 已消失)"}`,
          details: { session: p.session, outcome: outcome.kind },
        };
      } finally {
        if (wasWatching && stillAlive) rewatch(p.session, true);
      }
    },

    async steer(p) {
      const bad = requireKnown(p.session);
      if (bad) return bad;
      const sent = await deliver(p.session, p.message);
      if (!sent.ok) {
        // session 真没了才清台账；只是没投进去的话记录要留着，那个 agent 还活着。
        if (/已经不在了|消失了/.test(sent.reason)) return dropGone(p.session);
        return err(`消息未投递成功：${sent.reason}`);
      }
      const watching = rewatch(p.session, true);
      return {
        text: `已把消息送给 "${p.session}"。${watching ? "watcher 已重挂。" : ""}`,
        details: { session: p.session, watching },
      };
    },

    /**
     * 往 session 里按键，用来操作 agent 弹出的对话框（选择框、确认框之类）。
     *
     * 为什么需要它：对话框是模态的，它把输入框顶掉了。这时 `asd_steer` 送文本会
     * 投递校验失败并**拒绝按回车** —— 那是对的，输入框里是对话框，那一下回车会
     * 去确认它当前选中的项（claude 信任对话框的第二项是 "No, exit"）。所以
     * "操作对话框"必须是一个和"投消息"分开的动作。
     *
     * **这里不做投递校验**：按键本来就不是往输入框送的，"文本有没有出现在屏幕上"
     * 这个判据对它没有意义。代价是调用方要自己负责先 peek 看清楚再按 —— 所以
     * 返回值里直接带上操作后的屏幕，省掉一次来回。
     */
    async nav(p) {
      const bad = requireKnown(p.session);
      if (bad) return bad;

      const parsed = resolveNavKeys(p.keys);
      if (!parsed.ok) return err(parsed.message);

      // 逐个发、中间留空档。见 NAV_KEY_DELAY_MS：一次送一串会挤在同一个 payload
      // 里，而且对话框来不及重绘。
      const sent: string[] = [];
      for (const key of parsed.keys) {
        if (!(await asd.key(p.session, key))) {
          registry.remove(p.session);
          watchers.stop(p.session);
          return err(
            sent.length === 0
              ? `"${p.session}" 的 session 已经不在了，一个键都没送出去。`
              : `"${p.session}" 在送 ${key} 时消失了。已经送出去的：${sent.join(" ")}。`,
          );
        }
        sent.push(key);
        await sleep(NAV_KEY_DELAY_MS);
      }

      // 按完之后 agent 可能就开始干活了（比如刚确认掉一个对话框），watcher 要重挂。
      const watching = rewatch(p.session, true);
      const screen = await asd.peek(p.session);
      if (screen === null) return dropGone(p.session);

      return {
        text:
          `已向 "${p.session}" 送出：${sent.join(" ")}。` +
          `${watching ? "watcher 已重挂。" : ""}\n` +
          `--- 按键之后的屏幕 ---\n${screen}`,
        details: { session: p.session, keys: sent, watching },
      };
    },

    /**
     * 把一个 session 从台账里摘掉 —— **只是不再管它，不结束它**。
     *
     * 和 `kill` 的分界：
     *   kill    结束进程。只能结束 pi-asd 自己创建的（`createdByUs`）。
     *   unadopt 进程照跑，只是 pi-asd 不再追踪：不挂 watcher、不出现在
     *           asd_agents、Reaper 也不再考虑它（那两处都读台账，摘掉即生效）。
     *
     * 摘掉之后还能再被 `asd_spawn(task, session:)` 指名交给 —— 那会重新收养。
     *
     * **对自己创建的 session 摘除是一扇单向门**，所以要在结果里说清楚：再次收养
     * 会以 `createdByUs: false` 记账，从此 `asd_kill` 永远拒绝它（那道闸门认的是
     * 台账里的标记，不是历史）。只是不想被自动回收的话，用 `persistent` 更合适 ——
     * 那个保留 kill 权。
     */
    async unadopt(p) {
      const rec = registry.get(p.session);
      if (rec === undefined) {
        const known = registry.names();
        return err(
          `"${p.session}" 本来就不在台账里，没什么可解除的。` +
            `当前台账：${known.length > 0 ? known.join(" / ") : "（空）"}`,
        );
      }

      // 先停 watcher 再摘记录：反过来的话，watcher 收尾时拿不到记录，
      // 它那条"已停下"的通知会指向一个 pi-asd 已经不认识的 session。
      watchers.stop(p.session);
      registry.remove(p.session);

      const wasOurs = rec.createdByUs === true;
      return {
        text:
          `已解除对 "${p.session}" 的追踪。**session 本身没有被结束，还在跑。**` +
          `它不再出现在 asd_agents 里，watcher 已停，空闲回收器也不会再动它。` +
          (wasOurs
            ? `\n注意：这个 session 本来是 pi-asd 自己创建的。再次指名交给它会以` +
              `"不是自己创建的"重新记账，从此 asd_kill 永远拒绝结束它 —— ` +
              `如果只是不想被自动回收，用 asd_spawn 的 persistent 参数更合适。`
            : ""),
        details: { session: p.session, wasCreatedByUs: wasOurs, task: rec.task },
      };
    },

    async kill(p) {
      // 硬不变量：只有台账里、且确实是 pi-asd 自己新建的 session 才允许 kill。
      // 这个判断必须在任何 asd 调用之前。
      const decision = registry.canKill(p.session);
      if (!decision.ok) {
        if (decision.reason === "unknown") {
          return err(
            `"${p.session}" 不是本次 spawn 出来的 agent，不会 kill。` +
              `当前台账：${decision.known.length > 0 ? decision.known.join(" / ") : "（空）"}`,
          );
        }
        return err(`"${p.session}" 不是 pi-asd 新建的 session，绝不 kill。`);
      }

      watchers.stop(p.session);
      const existed = await asd.kill(p.session);
      registry.remove(p.session);
      return {
        text: existed ? `已 kill "${p.session}"。` : `"${p.session}" 已经不在了，已从台账移除。`,
        details: { session: p.session, existed },
      };
    },
  };
}
