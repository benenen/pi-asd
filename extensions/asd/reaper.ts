/**
 * 延迟回收：agent 干完活之后空闲够久就 kill 掉，免得 session 无限堆积。
 *
 * **为什么不是"settle 就 kill"**：`asd follow` 判"停下"的依据是终端安静了约
 * 2 秒，这个信号在冷启动时完全不可靠 —— 实测一个刚 spawn 出来的 agent 在
 * 第 2 秒就会被判成 settle（它才刚画完首屏、还在等模型第一个 token）。在这个
 * 信号上挂 kill，agent 会在真正开始干活之前被杀掉。见 `WatcherDeps.onGone`。
 *
 * **为什么用 `idle_ms` 而不是 `running`**：实测 asd 0.1.9 的 `running` 并不是
 * "进程在执行"的意思，它恒等于"`idle_ms` 小于 ~2 秒"，也就是"终端最近有动静"。
 * 一个跑着 `sleep 5` 的 session 在第 3.5 秒报的是 `running: false`，而它刚跑完
 * 的那一瞬间反而报 `running: true`。所以判空闲只能看 `idle_ms`：它是距上次终端
 * 活动的毫秒数，`asd send` 会让它归零 —— 这一条正是"被 steer / 被复用之后不该
 * 再回收"能自动成立的原因，不需要额外的取消逻辑。
 *
 * **代价要说清楚**：`idle_ms` 分不出"闲着"和"在跑一个长时间不输出的命令"。一个
 * 沉默地跑着大编译的 agent，超过阈值一样会被回收。阈值因此可配，也可以整个关掉。
 */

import type { Asd, SessionInfo } from "./cli.ts";
import type { Registry } from "./registry.ts";

/** 关掉延迟回收的取值。 */
const OFF = new Set(["off", "no", "false", "0", "never"]);

/**
 * 解析 `"2m"` / `"90s"` / `"1h"` 这样的时长；关掉时返回 undefined。
 *
 * 空串按"没设置"处理（同 `parseBossDefault` 的理由：`.env` 空行、
 * `docker -e VAR=`、没展开的 shell 变量都会送来空串）。
 */
export function parseDuration(raw: string | undefined): { ms?: number; problem?: string } {
  const v = (raw ?? "").trim().toLowerCase();
  if (v.length === 0) return {};
  if (OFF.has(v)) return {};
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(v);
  if (m === null) {
    return { problem: `认不出的时长 "${raw}"。写法：30s / 2m / 1h，或者 off 关掉。` };
  }
  const n = Number(m[1]);
  const unit = m[2] as "ms" | "s" | "m" | "h";
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
  const ms = Math.round(n * scale);
  if (ms <= 0) return {};
  return { ms };
}

export interface ReapQuery {
  /** `asd list --json` 的结果。 */
  live: SessionInfo[];
  /** 空闲超过这么久就回收。 */
  idleKillMs: number;
  /** boss 自己所在的 session，永远不碰。 */
  bossSession?: string;
}

/**
 * 算出这一轮该回收哪些 session —— 纯函数，不碰 IO，所以能直接测。
 *
 * 三个条件缺一不可：
 * 1. 在台账里、且 `createdByUs === true` —— 和 `asd_kill` 同一条硬不变量：
 *    用户手建的、以及指名交过任务的 session 永远不能被 pi-asd 结束。
 * 2. `idle_ms >= idleKillMs` —— 见文件头，这是唯一可靠的空闲信号。
 * 3. 不是长期员工（`persistent`）—— 那是"要不要收"，和上面"能不能收"是两回事。
 * 4. 不是 boss 自己。
 */
export function sessionsToReap(registry: Registry, q: ReapQuery): string[] {
  const out: string[] = [];
  for (const info of q.live) {
    if (info.session === q.bossSession) continue;
    const rec = registry.get(info.session);
    // createdByUs 这道闸门和 Registry.canKill 是同一条：不是自己创建的绝不动。
    if (rec === undefined || rec.createdByUs !== true) continue;
    // 长期员工不参与自动回收。这两条是**不同**的判断：createdByUs 管"能不能"，
    // persistent 管"要不要"。见 AgentRecord.persistent。
    if (rec.persistent === true) continue;
    if (info.idle_ms < q.idleKillMs) continue;
    out.push(info.session);
  }
  return out;
}

export interface ReaperDeps {
  asd: Pick<Asd, "list" | "kill">;
  registry: Registry;
  /** 空闲超过这么久就回收。 */
  idleKillMs: number;
  /** 多久扫一次。默认取 `idleKillMs` 的 1/4，夹在 [5s, 60s]。 */
  sweepMs?: number;
  bossSession?: string;
  notify: (text: string) => void;
}

function defaultSweepMs(idleKillMs: number): number {
  return Math.min(60_000, Math.max(5_000, Math.round(idleKillMs / 4)));
}

/**
 * 定时扫一遍，把空闲够久的自家 session 回收掉。
 *
 * 不给每个 session 各排一个定时器 —— 那需要一整套"被 steer 了要取消""被复用了
 * 要取消"的取消逻辑，而每一处漏掉都是一次误杀。扫描 + `idle_ms` 让这些情况
 * 自动成立：任何送进去的输入都会把 `idle_ms` 打回零。
 */
export class Reaper {
  readonly #deps: ReaperDeps;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: ReaperDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    const every = this.#deps.sweepMs ?? defaultSweepMs(this.#deps.idleKillMs);
    this.#timer = setInterval(() => {
      void this.sweep();
    }, every);
    // 不要因为这个定时器把宿主进程吊着不退出。
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * 扫一轮。返回这一轮真正 kill 掉的 session —— 测试直接调它，不用等定时器。
   *
   * `asd list` 失败就安静跳过这一轮：联系不上 asd 时什么都不做，远好过基于
   * 猜测去 kill。
   */
  async sweep(): Promise<string[]> {
    let live: SessionInfo[];
    try {
      live = await this.#deps.asd.list();
    } catch {
      return [];
    }
    const targets = sessionsToReap(this.#deps.registry, {
      live,
      idleKillMs: this.#deps.idleKillMs,
      bossSession: this.#deps.bossSession,
    });
    const killed: string[] = [];
    for (const session of targets) {
      try {
        await this.#deps.asd.kill(session);
      } catch {
        // 这一轮没杀掉就下一轮再说，台账留着 —— 不能因为 kill 失败就把记录抹了，
        // 那会让这个 session 从此再没人管。
        continue;
      }
      this.#deps.registry.remove(session);
      killed.push(session);
    }
    if (killed.length > 0) {
      this.#deps.notify(
        `[pi-asd] 已回收空闲超过 ${formatMs(this.#deps.idleKillMs)} 的 agent：${killed.join(" / ")}。`,
      );
    }
    return killed;
  }
}

/** 只给上面那句通知用的紧凑写法。 */
function formatMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
