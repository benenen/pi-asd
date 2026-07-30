import fs from "node:fs";
import path from "node:path";

export interface AsdConfig {
  /** boss mode 是否在 session_start 时自动打开 */
  bossMode: {
    autoStart: boolean;
    /** boss mode 默认用哪个 agent（pi / claude / codex） */
    defaultAgent?: string;
  };
  /** 新 agent 的工作区基坐目录。不显式给 cwd 的 spawn 会拿到 <workspaceBase>/<session 名> */
  workspaceBase?: string;
  /** session 名前缀 */
  prefix?: string;
  /** follow 超时，如 "30m" */
  followTimeout?: string;
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

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    bossMode: { autoStart, defaultAgent },
    workspaceBase,
    prefix,
    followTimeout,
  };
}

export function resolveWorkspaceBase(raw: string | undefined, fallback: string): string {
  const v = (raw ?? "").trim();
  return v.length > 0 ? v : fallback;
}
