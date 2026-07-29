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
   * 台账里"的同义词：`tools.ts` 的 `adopt()` 会把指名收养来的用户 session 也
   * 记进台账，但以 `createdByUs: false` 记账 —— 台账内因此混着两种记录，这个
   * 字段才是用户手建 session 和"pi-asd 能不能动它"之间唯一的拦截。
   */
  createdByUs: boolean;
}

export interface ReuseQuery {
  /** 已经过 `candidateName` 处理的完整 session 名；给了就只认这一个。 */
  name?: string;
  agent: string;
  cwd: string;
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

  /** 加前缀 + 洗名，不做避重 —— 复用时拿它算"该找哪个 session"。 */
  candidateName(name: string): string {
    return sanitizeName(`${this.#prefix}${name}`);
  }

  /** 加前缀 + 洗名 + 避开 `taken`（应当是 `asd list` 里的全部名字）。 */
  allocateName(name: string | undefined, taken: ReadonlySet<string>): string {
    this.#seq += 1;
    const raw = name ?? `agent${this.#seq}`;
    return uniqueName(sanitizeName(`${this.#prefix}${raw}`), taken);
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
   * 硬不变量："自动复用只在台账内；台账外的 session 只能由主 agent 看过
   * `asd_candidates` 后指名收养，绝不自动挑中。" —— `createdByUs === true` 这
   * 一条必须在这里守住：`adopt()` 会把指名收养来的用户 session 也记进台账
   * （`createdByUs: false`），如果这里只看"在不在台账里"，那么收养一次之后，
   * 后续任何一次**没点名**的 `asd_spawn` 都可能把它当成自己人自动复用 ——
   * 用户正在用的会话就这样被静默塞进了下一个任务。
   */
  pickReusable(q: ReuseQuery, live: ReadonlyMap<string, SessionInfo>): AgentRecord | undefined {
    const fits = (r: AgentRecord): boolean => {
      const info = live.get(r.session);
      return (
        info !== undefined &&
        !info.running &&
        r.agent === q.agent &&
        r.cwd === q.cwd &&
        r.createdByUs === true
      );
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
