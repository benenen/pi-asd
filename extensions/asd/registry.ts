/**
 * 本次 boss spawn 出来的 agent 台账。
 *
 * 只活在进程内存里 —— boss 重启后台账为空，但 session 仍在 asd 里（见规格
 * 「生命周期」一节）。这里全是纯逻辑，不碰 IO，所以能直接测。
 */

import type { SessionInfo } from "./cli.ts";

/** asd 的硬约束：session 名是 `[A-Za-z0-9_-]{1,64}`。 */
export const NAME_MAX = 64;

export interface AgentRecord {
  /** asd 里的 session 名。 */
  session: string;
  task: string;
  cwd: string;
  agent: string;
  createdAt: number;
  /**
   * 这个 session 是不是 pi-asd 自己 `asd new` 出来的。
   *
   * kill 守卫唯一的依据，`pickReusable` 的自动复用池也靠它把关。**不是**"在
   * 台账里"的同义词：`tools.ts` 的 `adopt()` 会把指名交过任务的用户 session 也
   * 记进台账，但以 `createdByUs: false` 记账 —— 台账内因此混着两种记录，这个
   * 字段才是用户手建 session 和"pi-asd 能不能动它"之间唯一的拦截。
   */
  createdByUs: boolean;
  /**
   * 长期员工：**不参与空闲自动回收**。缺省（undefined）按 false 处理。
   *
   * 和 `createdByUs` 是两回事，回收时两个都要看：
   *   - `createdByUs` 管**能不能** kill —— 不是自己创建的，任何情况都不许动
   *   - `persistent`  管**要不要** kill —— 是自己创建的，但这个是长期岗位，别收
   *
   * 只影响 Reaper 那条自动路径。`asd_kill` 是 boss 显式点名结束，不受它影响 ——
   * 否则一个设了 persistent 的 agent 就再也关不掉了。
   */
  persistent?: boolean;
}

export interface ReuseQuery {
  /** 已经过 `candidateName` 处理的完整 session 名；给了就只认这一个。 */
  name?: string;
  agent: string;
  /**
   * 要求工作目录精确等于它。**不给就是不约束目录**。
   *
   * 不约束是给"没显式指定 cwd 的 spawn"用的：那种 spawn 给每个新 agent 分
   * `<base>/<session 名>` 这样一个独立目录，两次算出来的目录必然不同，如果还要求
   * 目录相等，复用就永远不会命中。放宽的只是"挑我们自己的哪个 agent"，
   * `createdByUs === true` 那道闸门不受影响。
   */
  cwd?: string;
}

export type KillDecision =
  | { ok: true; record: AgentRecord }
  | { ok: false; reason: "unknown"; known: string[] }
  | { ok: false; reason: "not-ours" };

/** 洗成 asd 认的字符集，顺便压掉连续横杠、去首尾横杠、截断。 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned.length > 0 ? cleaned : "agent").slice(0, NAME_MAX);
}

/** 撞名就追加 `-2`、`-3`……，并保证结果仍然不超过 64 字符。 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const head = base.slice(0, NAME_MAX - suffix.length).replace(/-+$/, "");
    const candidate = `${head}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export class Registry {
  readonly #prefix: string;
  readonly #records = new Map<string, AgentRecord>();
  #seq = 0;

  constructor(prefix: string) {
    this.#prefix = prefix;
  }

  get size(): number {
    return this.#records.size;
  }

  /**
   * 加前缀 + 洗名，不做避重 —— 复用时拿它算"该找哪个 session"。
   *
   * `prefix` 显式给了就用它，**空串就是"不加前缀"**（不是"没给"）。这里和
   * `parseBossDefault`/`parseDuration` 那套"空串当没设置"的规则**故意相反**：
   * 那些读的是环境变量/配置，空串多半是 `.env` 空行之类的意外；这个是调用方在
   * 一次 spawn 里显式传的参数，写 `""` 就是真的要一个光名字。
   */
  candidateName(name: string, prefix?: string): string {
    return sanitizeName(`${prefix ?? this.#prefix}${name}`);
  }

  /** 加前缀 + 洗名 + 避开 `taken`（应当是 `asd list` 里的全部名字）。前缀语义同上。 */
  allocateName(name: string | undefined, taken: ReadonlySet<string>, prefix?: string): string {
    this.#seq += 1;
    const raw = name ?? `agent${this.#seq}`;
    return uniqueName(sanitizeName(`${prefix ?? this.#prefix}${raw}`), taken);
  }

  add(rec: AgentRecord): void {
    this.#records.set(rec.session, rec);
  }

  get(session: string): AgentRecord | undefined {
    return this.#records.get(session);
  }

  list(): AgentRecord[] {
    return [...this.#records.values()];
  }

  names(): string[] {
    return [...this.#records.keys()];
  }

  /**
   * 把一条记录换个名字：挪 map 的 key，并同步记录里的 `session` 字段。
   *
   * 台账是按名字索引的，`asd rename` 之后如果不跟着改，pi-asd 就跟丢了 ——
   * boss mode 提示词里的「当前 agent」清单会显示一个已经不存在的旧名字，
   * watcher / kill / Reaper 全部对不上。
   *
   * 新名字已被占用时返回 false 且什么都不改 —— 覆盖掉另一条记录会让那个 agent
   * 凭空从台账里消失。
   */
  rename(from: string, to: string): boolean {
    const rec = this.#records.get(from);
    if (rec === undefined) return false;
    if (from === to) return true;
    if (this.#records.has(to)) return false;
    this.#records.delete(from);
    rec.session = to;
    this.#records.set(to, rec);
    return true;
  }

  remove(session: string): AgentRecord | undefined {
    const rec = this.#records.get(session);
    if (rec) this.#records.delete(session);
    return rec;
  }

  /** 摘掉 asd 里已经不在的条目，把它们返回给调用方去收尾。 */
  reconcile(live: ReadonlySet<string>): AgentRecord[] {
    const gone: AgentRecord[] = [];
    for (const [name, rec] of this.#records) {
      if (!live.has(name)) {
        gone.push(rec);
        this.#records.delete(name);
      }
    }
    return gone;
  }

  /**
   * 挑一个能直接派活的空闲 agent；挑不到返回 undefined。
   *
   * 硬不变量："自动复用只在台账内、且必须是自己创建的；台账外的 session 只能
   * 由主 agent 看过 `asd_candidates` 后指名交给它，绝不自动挑中。" ——
   * `createdByUs === true` 这一条必须在这里守住：`adopt()` 会把指名交过任务的
   * 用户 session 也记进台账（`createdByUs: false`），如果这里只看"在不在台账
   * 里"，那么指名交过一次之后，
   * 后续任何一次**没点名**的 `asd_spawn` 都可能把它当成自己人自动复用 ——
   * 用户正在用的会话就这样被静默塞进了下一个任务。
   */
  pickReusable(q: ReuseQuery, live: ReadonlyMap<string, SessionInfo>): AgentRecord | undefined {
    const fits = (r: AgentRecord): boolean => {
      const info = live.get(r.session);
      if (info === undefined || info.running) return false;
      if (r.createdByUs !== true) return false;
      if (r.agent !== q.agent) return false;
      return q.cwd === undefined || r.cwd === q.cwd;
    };

    if (q.name !== undefined) {
      const r = this.#records.get(q.name);
      return r !== undefined && fits(r) ? r : undefined;
    }

    let best: AgentRecord | undefined;
    let bestIdle = -1;
    for (const r of this.#records.values()) {
      if (!fits(r)) continue;
      const idle = live.get(r.session)!.idle_ms;
      if (idle > bestIdle) {
        best = r;
        bestIdle = idle;
      }
    }
    return best;
  }

  /**
   * kill 守卫。调用方**必须**先问过这里、拿到 `ok: true` 才允许执行 `asd kill`。
   */
  canKill(session: string): KillDecision {
    const rec = this.#records.get(session);
    if (rec === undefined) return { ok: false, reason: "unknown", known: this.names() };
    if (rec.createdByUs !== true) return { ok: false, reason: "not-ours" };
    return { ok: true, record: rec };
  }
}
