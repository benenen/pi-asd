import fs from "node:fs";
import path from "node:path";

/**
 * asd.json 配置文件的结构。
 *
 * 所有字段都可选，不写的走内置默认值。环境变量优先级高于配置文件——
 * 如果在 env 里设了对应的变量，配置文件的值会被忽略。
 */
export interface AsdConfig {
  /** boss mode 是否在 session_start 时自动打开。对应环境变量 `PI_ASD_BOSS` */
  bossMode: {
    autoStart: boolean;
    /** boss mode 默认用哪个 agent。对应环境变量 `PI_ASD_AGENT`（pi / claude / codex） */
    defaultAgent?: string;
  };
  /** 新 agent 的工作区基坐目录。不显式给 cwd 的 spawn 会拿到 <workspaceBase>/<session 名>。对应环境变量 `PI_ASD_WORKSPACE` */
  workspaceBase?: string;
  /** session 名前缀。对应环境变量 `PI_ASD_PREFIX` */
  prefix?: string;
  /** follow 超时，如 "30m"。对应环境变量 `PI_ASD_FOLLOW_TIMEOUT` */
  followTimeout?: string;
  /**
   * agent 空闲多久之后自动回收（kill），如 "2m"。`off` 关掉。
   * 对应环境变量 `PI_ASD_IDLE_KILL`
   */
  idleKillAfter?: string;
  /**
   * 从 pi 自己的环境里透传给子 agent 的变量名。缺省见 index.ts 的
   * `DEFAULT_ENV_PASSTHROUGH`（代理 + IS_SANDBOX 那一组）。
   *
   * 子 agent 是 asd daemon fork 的，继承的是 daemon 的环境，不是 pi 的 —— 所以
   * 需要的变量必须点名透传。
   */
  envPassthrough?: string[];
  /** 直接指定透传给子 agent 的环境变量（覆盖同名的 envPassthrough 结果）。 */
  spawnEnv?: Record<string, string>;
  /**
   * agent → 本机别名/包装命令。配了就用它启动，没配才用预设里的原名。
   *
   * ```jsonc
   * { "aliases": { "claude": "clp" } }
   * ```
   *
   * 典型用途：本机有个自带环境变量的包装。比在 `envPassthrough` 里维护变量名单
   * 更省心 —— 包装改了不用重启 pi，配置是每次加载时读的。
   *
   * 实现上会用**交互式 bash** 去跑它（`bash -ic '<别名> …'`），因为 shell 别名
   * 只有那样才展开，详见 `tools.ts` 的 `bashInteractive`。写脚本名也可以，
   * 只是那种情况下走 bash 是多余的一层。
   */
  aliases?: Record<string, string>;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`pi-asd 配置有 ${problems.length} 处问题：\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface ConfigFile {
  /** 已解析的内容；文件不存在时为 undefined */
  value: unknown;
  /** 文件存在但解析失败时的说明；否则为 undefined */
  problem?: string;
}

export type FileReader = (file: string) => string | undefined;

const readFileOrUndefined: FileReader = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * 读一个配置文件。区分「文件不存在」和「文件存在但 JSON 有语法错」——
 * 两者都静默跳过的话，用户改坏了配置只会看到莫名其妙的默认行为。
 */
export function readConfigFile(
  file: string,
  read: FileReader = readFileOrUndefined,
): ConfigFile {
  const raw = read(file);
  if (raw === undefined) return { value: undefined };
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    return { value: undefined, problem: `${file} 不是合法的 JSON：${String(err)}` };
  }
}

export interface LoadConfigArgs {
  /** 低优先级在前，后面的覆盖前面的。可以是已解析的值，也可以是 readConfigFile 的结果 */
  files: (unknown | ConfigFile)[];
  /** 环境变量，兜底覆盖 */
  env: Record<string, string | undefined>;
  /** 当前工作目录 */
  cwd: string;
  /** pi agent 目录 */
  agentDir: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function readBoolean(v: unknown, key: string, fallback: boolean, problems: string[]): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") {
    problems.push(`${key} 必须是布尔值`);
    return fallback;
  }
  return v;
}

function readOptionalString(
  v: unknown,
  key: string,
  problems: string[],
): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    problems.push(`${key} 必须是字符串`);
    return undefined;
  }
  return v;
}

function readStringArray(v: unknown, key: string, problems: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    problems.push(`${key} 必须是字符串数组`);
    return undefined;
  }
  return v as string[];
}

function readStringMap(
  v: unknown,
  key: string,
  problems: string[],
): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    problems.push(`${key} 必须是「名字 → 值」的对象`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") {
      problems.push(`${key}.${k} 必须是字符串`);
      continue;
    }
    out[k] = val;
  }
  return out;
}

export function loadConfig({ files, env, cwd, agentDir }: LoadConfigArgs): AsdConfig {
  const merged: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const f of files) {
    if (f !== null && typeof f === "object" && "value" in f) {
      const entry = f as ConfigFile;
      if (entry.problem !== undefined) problems.push(entry.problem);
      Object.assign(merged, asRecord(entry.value));
      continue;
    }
    Object.assign(merged, asRecord(f));
  }

  // bossMode
  const bossModeRaw = asRecord(merged.bossMode);
  const autoStart = readBoolean(bossModeRaw.autoStart, "bossMode.autoStart", false, problems);
  const defaultAgent = readOptionalString(bossModeRaw.defaultAgent, "bossMode.defaultAgent", problems);

  // 顶层字段
  const workspaceBase = readOptionalString(merged.workspaceBase, "workspaceBase", problems);
  const prefix = readOptionalString(merged.prefix, "prefix", problems);
  const followTimeout = readOptionalString(merged.followTimeout, "followTimeout", problems);
  const idleKillAfter = readOptionalString(merged.idleKillAfter, "idleKillAfter", problems);
  const envPassthrough = readStringArray(merged.envPassthrough, "envPassthrough", problems);
  const spawnEnv = readStringMap(merged.spawnEnv, "spawnEnv", problems);
  const aliases = readStringMap(merged.aliases, "aliases", problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    bossMode: { autoStart, defaultAgent },
    workspaceBase,
    prefix,
    followTimeout,
    idleKillAfter,
    envPassthrough,
    spawnEnv,
    aliases,
  };
}

export interface SafeConfig {
  config: AsdConfig;
  /** 读配置时发现的问题；一切正常时为空数组。 */
  problems: string[];
}

/**
 * `loadConfig` 的不抛版本：配置坏了就整份退回内置默认，把问题原样带出来。
 *
 * 调用方（扩展入口、`session_start`）都不能让 `ConfigError` 逃出去：入口抛 =
 * 整个 pi-asd 加载失败、用户只看到一坨 stack trace；`session_start` 的 async
 * handler 里抛 = unhandled rejection，任何一个 `.pi/asd.json` 坏掉的项目目录
 * 都起不来 session。上面特意区分"文件不存在"和"JSON 有语法错"、特意把
 * problems 汇总成一句人话，就是为了送到用户眼前 —— 没人接住的话那份力气
 * 一次都送不出去。
 *
 * 退回默认是整份退，不是逐字段挑好的留下：配置文件已经被证明不可信，从里面
 * 半信半疑地捡值出来只会让最终生效的配置更难猜。
 */
export function loadConfigSafely(args: LoadConfigArgs): SafeConfig {
  try {
    return { config: loadConfig(args), problems: [] };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // 空 files 没有任何可校验的东西，这一次不可能再抛。
    return { config: loadConfig({ ...args, files: [] }), problems: err.problems };
  }
}

export function resolveWorkspaceBase(raw: string | undefined, fallback: string): string {
  const v = (raw ?? "").trim();
  return v.length > 0 ? v : fallback;
}
