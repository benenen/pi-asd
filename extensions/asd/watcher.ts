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

/**
 * "刚挂上就报已停下"的止损窗口：一个新建/刚重挂的 session，`asd follow` 可能
 * 在它连第一帧都还没吐出来的时候就因为"安静了 2 秒"而 settle —— 冷启动的
 * agent（尤其是并发 spawn 一堆时）很容易撑不过这 2 秒。这个窗口内如果
 * settle 时屏幕仍是空的，判定为"还没真的开始"而不是"已经做完"，重挂一次
 * 而不是通知。时间和次数都设了上限，避免一个屏幕永远空白的 session 被无限
 * 重挂。
 */
const EARLY_GRACE_MS = 20_000;
const EARLY_MAX_RETRIES = 10;

export class WatcherPool {
  readonly #deps: WatcherDeps;
  readonly #running = new Map<string, AbortController>();
  readonly #inflight = new Set<Promise<void>>();
  /** session → 这一轮"冷启动止损"的挂载时间和已经重挂过几次。 */
  readonly #early = new Map<string, { mountedAt: number; attempts: number }>();

  constructor(deps: WatcherDeps) {
    this.#deps = deps;
  }

  /** 挂一个 watcher；已经挂着就返回 false。 */
  watch(session: string): boolean {
    if (this.#running.has(session)) return false;
    const ctrl = new AbortController();
    this.#running.set(session, ctrl);
    // 只在这个 session 没有正在进行的"冷启动止损"时开一轮新的 —— 内部重挂
    // （见 #run 里的 early-empty 分支）复用同一轮，好让"距挂载多久"是从最初
    // 那次 watch() 算起，而不是每重挂一次就清零。
    if (!this.#early.has(session)) {
      this.#early.set(session, { mountedAt: this.#deps.now(), attempts: 0 });
    }
    const task = this.#run(session, ctrl, this.#deps.now());
    this.#inflight.add(task);
    void task.finally(() => this.#inflight.delete(task));
    return true;
  }

  isWatching(session: string): boolean {
    return this.#running.has(session);
  }

  stop(session: string): void {
    // 外部主动 stop（steer/kill/dropGone/session_shutdown）意味着这一轮
    // 监视彻底结束，下次 watch() 应该当成全新的一轮冷启动止损来算，不能继承
    // 上一轮的挂载时间/次数。
    this.#early.delete(session);
    const ctrl = this.#running.get(session);
    if (!ctrl) return;
    ctrl.abort();
    this.#running.delete(session);
  }

  stopAll(): void {
    for (const ctrl of this.#running.values()) ctrl.abort();
    this.#running.clear();
    this.#early.clear();
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
        this.#early.delete(session);
        this.#finish(session, ctrl);
        this.#notify(`[pi-asd] agent "${session}" 的 session 已结束。`);
        return;
      }
      if (outcome.kind === "timeout") {
        this.#early.delete(session);
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

      // 冷启动止损：屏幕真的是空的（不是 null —— null 是"session 已经不在
      // 了"，那是完全不同的情况，必须照常通知，见下面的默认分支），而且这个
      // session 还在"刚挂上没多久"的宽限期里、重挂次数也没到上限 —— 这更像
      // "agent 还没来得及吐出第一帧"，不是"真的做完了"。摘掉这一代、悄悄
      // 重挂一代新的，不通知；`isWatching()` 全程保持 true（#finish 和
      // watch() 之间没有任何 await，外部观察不到"没在挂"的空档）。
      const early = this.#early.get(session);
      const screenIsEmpty = screen !== null && screen.trim().length === 0;
      if (
        screenIsEmpty &&
        early !== undefined &&
        this.#deps.now() - early.mountedAt < EARLY_GRACE_MS &&
        early.attempts < EARLY_MAX_RETRIES
      ) {
        early.attempts += 1;
        this.#finish(session, ctrl);
        this.watch(session);
        return;
      }

      this.#finish(session, ctrl);
      // "历时"从这一轮冷启动止损最初挂载的时刻算起（如果有过重挂），而不是
      // 从这次侥幸成功的重挂算起 —— 不然 boss 看到的耗时会比实际短一大截。
      const took = formatDuration(this.#deps.now() - (early?.mountedAt ?? startedAt));
      this.#early.delete(session);
      this.#notify(
        `[pi-asd] agent "${session}" 已停下（历时 ${took}）。\n` +
          `--- 最后一屏 ---\n${screen ?? "(session 已消失)"}`,
      );
    } catch (e) {
      if (ctrl.signal.aborted) return;
      this.#early.delete(session);
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
