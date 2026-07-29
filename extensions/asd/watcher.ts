/**
 * 后台 follow watcher。
 *
 * 每个 watcher 就是一个挂在 `asd follow` 上的 promise：它阻塞在那里等 agent
 * 安静下来，**不烧任何 LLM token**。agent 一停，watcher 自己 peek 一屏，然后把
 * 结果交给注入的 `notify`（在 index.ts 里接到 `pi.sendMessage`）。
 *
 * 主 agent 因此完全不用轮询，spawn 完可以直接去干别的。
 */

import type { Asd } from "./cli.ts";

export interface WatcherDeps {
  asd: Asd;
  notify: (text: string) => void;
  /** 传给 `asd follow --timeout` 的时长串，例如 "30m"。 */
  timeout: string;
  now: () => number;
}

/** `252000` → `"4m12s"`。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export class WatcherPool {
  readonly #deps: WatcherDeps;
  readonly #running = new Map<string, AbortController>();
  readonly #inflight = new Set<Promise<void>>();

  constructor(deps: WatcherDeps) {
    this.#deps = deps;
  }

  /** 挂一个 watcher；已经挂着就返回 false。 */
  watch(session: string): boolean {
    if (this.#running.has(session)) return false;
    const ctrl = new AbortController();
    this.#running.set(session, ctrl);
    const task = this.#run(session, ctrl, this.#deps.now());
    this.#inflight.add(task);
    void task.finally(() => this.#inflight.delete(task));
    return true;
  }

  isWatching(session: string): boolean {
    return this.#running.has(session);
  }

  stop(session: string): void {
    const ctrl = this.#running.get(session);
    if (!ctrl) return;
    ctrl.abort();
    this.#running.delete(session);
  }

  stopAll(): void {
    for (const ctrl of this.#running.values()) ctrl.abort();
    this.#running.clear();
  }

  /** 等所有在跑的 watcher 回调走完 —— 测试用，让断言不和 fire-and-forget 抢跑。 */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
    }
  }

  async #run(session: string, ctrl: AbortController, startedAt: number): Promise<void> {
    try {
      const outcome = await this.#deps.asd.follow(session, {
        timeout: this.#deps.timeout,
        signal: ctrl.signal,
      });
      // 被 stop 掉了：这个 watcher 的结果已经没人要了，安静退出。entry 已经被
      // stop()/stopAll() 清掉了，这里不用、也不该再动 #running。
      if (ctrl.signal.aborted) return;

      if (outcome.kind === "gone") {
        this.#finish(session, ctrl);
        this.#notify(`[pi-asd] agent "${session}" 的 session 已结束。`);
        return;
      }
      if (outcome.kind === "timeout") {
        this.#finish(session, ctrl);
        this.#notify(
          `[pi-asd] agent "${session}" 的 watcher 等了 ${this.#deps.timeout} 还没等到它停下，它仍在跑。` +
            `要继续盯就调 asd_follow("${session}")。`,
        );
        return;
      }

      // 注意：从这里到 peek 回来之前还有一段 await 窗口，stop() 完全可能在
      // 这段时间内发生 —— 所以 #running 的清理必须等到这里才做，不能在
      // follow 一 resolve 就提前删掉（提前删掉会让 stop() 在这个窗口期找不到
      // controller，变成静默 no-op；也会让 isWatching() 在这个窗口期撒谎说
      // "没在挂"，给外层制造出重复挂 / 误删下一代 watcher 记录的机会）。
      const screen = await this.#deps.asd.peek(session);
      if (ctrl.signal.aborted) return;
      this.#finish(session, ctrl);
      const took = formatDuration(this.#deps.now() - startedAt);
      this.#notify(
        `[pi-asd] agent "${session}" 已停下（历时 ${took}）。\n` +
          `--- 最后一屏 ---\n${screen ?? "(session 已消失)"}`,
      );
    } catch (e) {
      if (ctrl.signal.aborted) return;
      this.#finish(session, ctrl);
      this.#notify(
        `[pi-asd] agent "${session}" 的 watcher 出错：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 收尾时把自己从 #running 里摘掉 —— 但只摘自己注册的那个 controller。
   * 用身份比较（而不是按 session 这个 key 无脑删）是关键：如果这个 session
   * 已经被 stop() 之后重新 watch() 过，#running 里挂的是下一代的 controller，
   * 这一代（已经过时、迟迟才收尾）绝不能把下一代的记录带走。
   */
  #finish(session: string, ctrl: AbortController): void {
    if (this.#running.get(session) === ctrl) this.#running.delete(session);
  }

  /**
   * notify 是外部注入的回调（index.ts 里接到 pi.sendMessage）；它是否好好
   * 实现不是这一层能保证的。一个后台 watcher 的通知失败，不该变成未处理的
   * promise rejection 拖垮整个宿主进程 —— 吞掉，让其它 watcher 照常工作。
   */
  #notify(text: string): void {
    try {
      this.#deps.notify(text);
    } catch {
      // 有意吞掉：通知失败只是丢了这一条消息，不该扩散成进程级故障。
    }
  }
}
