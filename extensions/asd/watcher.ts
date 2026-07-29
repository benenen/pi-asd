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
      // 被 stop 掉了：这个 watcher 的结果已经没人要了，安静退出。
      if (ctrl.signal.aborted) return;
      this.#running.delete(session);

      if (outcome.kind === "gone") {
        this.#deps.notify(`[pi-asd] agent "${session}" 的 session 已结束。`);
        return;
      }
      if (outcome.kind === "timeout") {
        this.#deps.notify(
          `[pi-asd] agent "${session}" 的 watcher 等了 ${this.#deps.timeout} 还没等到它停下，它仍在跑。` +
            `要继续盯就调 asd_follow("${session}")。`,
        );
        return;
      }

      const screen = await this.#deps.asd.peek(session);
      if (ctrl.signal.aborted) return;
      const took = formatDuration(this.#deps.now() - startedAt);
      this.#deps.notify(
        `[pi-asd] agent "${session}" 已停下（历时 ${took}）。\n` +
          `--- 最后一屏 ---\n${screen ?? "(session 已消失)"}`,
      );
    } catch (e) {
      if (ctrl.signal.aborted) return;
      this.#running.delete(session);
      this.#deps.notify(
        `[pi-asd] agent "${session}" 的 watcher 出错：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
