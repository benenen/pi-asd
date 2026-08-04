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
import { detectDialog } from "./dialog.ts";

export interface WatcherDeps {
  asd: Asd;
  notify: (text: string) => void;
  /** 传给 `asd follow --timeout` 的时长串，例如 "30m"。 */
  timeout: string;
  now: () => number;
  /**
   * 冷启动止损重挂前的真实等待（毫秒）。默认 `EARLY_RETRY_DELAY_MS`。
   *
   * 只在测试里需要覆盖成 0 —— 生产代码永远不传这个字段，吃默认值。见
   * `EARLY_RETRY_DELAY_MS` 上面那段注释：这就是 C2 量纲修复的核心。
   */
  earlyRetryDelayMs?: number;
  /**
   * 判定"停下"之前的复核间隔，默认 `SETTLE_CONFIRM_MS`。
   * 只在测试里覆盖成 0 —— 生产代码不传，吃默认值。
   */
  settleConfirmMs?: number;
  /**
   * session 在 asd 里**真的没了**时调用（只有 `gone` 这一条路），用于清台账。
   *
   * **绝不能挂在 settle 上，也绝不能在这里 kill。** 这两条都是踩过的坑：
   *
   * `asd follow` 判"停下"的依据是终端安静了约 2 秒，而这个信号在冷启动时不
   * 可靠 —— 刚 spawn 出来的 agent 画完 TUI 首屏、正在等模型第一个 token 时，
   * 屏幕非空（冷启动止损那条分支不适用）而且安静，正好被判成 settle。曾经
   * 这个回调叫 onDone、settle 也触发、调用方接上去直接 `asd kill`，结果就是
   * agent 在真正开始干活之前被杀掉。
   *
   * 而且 settle 的 agent 是**活着且在等输入**，那是它最有用的状态：可以
   * asd_steer 追加任务、可以被 pickReusable 复用、可以 asd attach 接管
   * （README「生命周期」把最后一条列为 asd 相对 tmux 真正多出来的能力）。
   *
   * timeout 更不调 —— 那个 agent 还在跑。
   */
  onGone?: (session: string) => void;
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

/**
 * C2 量纲修复：`asd follow` 对一个已经安静了一段时间的 session 是**立即
 * 返回**的（不是再等 2 秒）—— 实测重挂一次的真实成本只有几十毫秒。如果重挂
 * 之间不主动等待，`EARLY_GRACE_MS` 这 20 秒宽限期在真机上就是死代码：
 * `EARLY_MAX_RETRIES` 次重挂在远不到 1 秒内就会全部烧光，冷启动稍慢的 agent
 * 照样会被误判成"已经停下"。所以每次决定悄悄重挂之前，先真等这么久，让
 * "宽限期"真的对应真实流逝的时间，而不是重挂次数。
 */
const EARLY_RETRY_DELAY_MS = 1_000;

/**
 * 判定"停下"之前的复核间隔。
 *
 * `asd follow` 的 settle 只代表"终端安静了约 2 秒"，它分不出**在思考**和**真停下**。
 * 但这两者在屏幕上是能分开的：还在干活的 agent 会持续重绘（转圈指示器、逐字输出），
 * 静止的则不会。所以 settle 之后以 1.2 秒为间隔连续复核两次：baseline 加两次复核
 * 必须三屏一致，任一屏变化都说明它还在动。全部确认后再单独 peek 最终屏幕用于通知，
 * 不能拿确认前的旧画面冒充执行结果；final peek 若又变化，同样整轮作废重挂。
 *
 * 这是目前唯一能把"思考中"和"停下了"分开的判据：asd 自己给不出（`running` 恒等于
 * `idle_ms < 2s`，`status` 只是它的字符串版）。
 */
const SETTLE_CONFIRM_MS = 1_200;

/** baseline 之后还要连续稳定这么多次，才把 settle 当成真的停下。 */
const SETTLE_CONFIRMATIONS = 2;

/** 复核后仍在变化时，最多安静重挂多少次；到顶只报未确认，不得谎报已停下。 */
const MAX_QUIET_REARMS = 40;

export class WatcherPool {
  readonly #deps: WatcherDeps;
  readonly #running = new Map<string, AbortController>();
  readonly #inflight = new Set<Promise<void>>();
  /** session → 这一轮"冷启动止损"的挂载时间和已经重挂过几次。 */
  readonly #early = new Map<string, { mountedAt: number; attempts: number }>();
  /** session → 复核发现"还在动"而安静重挂过几次。见 SETTLE_CONFIRM_MS。 */
  readonly #quiet = new Map<string, number>();

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
    this.#quiet.delete(session);
    const ctrl = this.#running.get(session);
    if (!ctrl) return;
    ctrl.abort();
    this.#running.delete(session);
  }

  stopAll(): void {
    for (const ctrl of this.#running.values()) ctrl.abort();
    this.#running.clear();
    this.#early.clear();
    this.#quiet.clear();
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
        this.#deps.onGone?.(session);
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
      // "agent 还没来得及吐出第一帧"，不是"真的做完了"。
      const early = this.#early.get(session);
      const screenIsEmpty = screen !== null && screen.trim().length === 0;
      if (
        screenIsEmpty &&
        early !== undefined &&
        this.#deps.now() - early.mountedAt < EARLY_GRACE_MS &&
        early.attempts < EARLY_MAX_RETRIES
      ) {
        early.attempts += 1;
        // 真等一会儿再重挂（见 EARLY_RETRY_DELAY_MS 上面的注释）—— 这段等待
        // 必须放在 #finish 之前：#running 里这一代的 controller 还没被摘掉，
        // isWatching() 全程保持 true。等待本身要响应 abort：stop()/stopAll()
        // 在这期间调用会立刻让 #sleep 返回，下面 `ctrl.signal.aborted` 一
        // 检查就安静退出，不会补发通知，也不会再重挂出下一代。
        await this.#sleep(this.#deps.earlyRetryDelayMs ?? EARLY_RETRY_DELAY_MS, ctrl.signal);
        if (ctrl.signal.aborted) return;
        // #finish 和 watch() 之间没有任何 await，外部观察不到"没在挂"的空档。
        this.#finish(session, ctrl);
        this.watch(session);
        return;
      }

      // 复核：隔一会儿连续看两次。任一屏变化 = agent 还在产出，settle 是误判，
      // 整轮作废、安静重挂，从零重新累计，不打扰 boss。全部稳定之后再单独 peek
      // 最终屏幕用于通知 —— 不能拿确认之前的旧 baseline 冒充执行结果；final peek
      // 若又变化，它本身就是新的活动信号，同样不能报停下。
      const confirmMs = this.#deps.settleConfirmMs ?? SETTLE_CONFIRM_MS;
      const quiet = this.#quiet.get(session) ?? 0;
      // confirmMs 为 0 时整段跳过（含那次复核 peek）—— 测试注入 0 就是要"不复核"，
      // 多打一次 peek 会让所有按调用序列断言的用例错位。
      let finalScreen = screen;
      if (confirmMs > 0 && screen !== null && quiet >= MAX_QUIET_REARMS) {
        this.#quiet.delete(session);
        this.#early.delete(session);
        this.#finish(session, ctrl);
        this.#notify(
          `[pi-asd] agent "${session}" 连续 ${MAX_QUIET_REARMS} 轮复核仍有活动，` +
            `未确认停下，也没有读取最终结果。要继续盯就调 asd_follow("${session}")。`,
        );
        return;
      }
      if (confirmMs > 0 && screen !== null && quiet < MAX_QUIET_REARMS) {
        let previous = screen;
        let disappeared = false;
        for (let i = 0; i < SETTLE_CONFIRMATIONS; i += 1) {
          await this.#sleep(confirmMs, ctrl.signal);
          if (ctrl.signal.aborted) return;
          const again = await this.#deps.asd.peek(session);
          if (ctrl.signal.aborted) return;
          if (again === null) {
            disappeared = true;
            break;
          }
          if (again !== previous) {
            this.#rearmAfterActivity(session, ctrl, quiet);
            return;
          }
          previous = again;
        }
        if (!disappeared) {
          finalScreen = await this.#deps.asd.peek(session);
          if (ctrl.signal.aborted) return;
          if (finalScreen !== null && finalScreen !== previous) {
            this.#rearmAfterActivity(session, ctrl, quiet);
            return;
          }
        } else {
          finalScreen = null;
        }
      }
      this.#quiet.delete(session);

      this.#finish(session, ctrl);
      // "历时"从这一轮冷启动止损最初挂载的时刻算起（如果有过重挂），而不是
      // 从这次侥幸成功的重挂算起 —— 不然 boss 看到的耗时会比实际短一大截。
      const took = formatDuration(this.#deps.now() - (early?.mountedAt ?? startedAt));
      this.#early.delete(session);
      // 这里**没有** onGone —— settle 只是"安静下来了"，session 还活着。
      // 见 WatcherDeps.onGone 的注释。
      // final peek 的这一屏是"等决策"还是"干完了"？对 boss 来说是两个完全不同的动作：
      // 前者必须有人按键，不处理就永远卡着；后者是去读结果。
      const dialog = detectDialog(finalScreen);
      if (dialog !== undefined) {
        this.#notify(
          `[pi-asd] ⚠️ agent "${session}" 需要用户决策（已等待 ${took}）。\n` +
            `${dialog.summary}\n` +
            `用 asd_nav("${session}", [...]) 按键作答；` +
            `作答之后 watcher 会自动重挂，不用重新 spawn。\n` +
            `--- 当前屏幕 ---\n${finalScreen ?? ""}`,
        );
        return;
      }
      this.#notify(
        `[pi-asd] agent "${session}" 已停下（历时 ${took}）。\n` +
          `--- 最后一屏 ---\n${finalScreen ?? "(session 已消失)"}`,
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

  /** 发现终端仍有活动：累计一次，并原子地摘掉当前代、挂上下一代。 */
  #rearmAfterActivity(session: string, ctrl: AbortController, quiet: number): void {
    this.#quiet.set(session, quiet + 1);
    // #finish 和 watch() 之间没有任何 await，外部观察不到"没在挂"的空档。
    this.#finish(session, ctrl);
    this.watch(session);
  }

  /**
   * 真等 `ms` 毫秒，但响应 abort —— `signal` 一 abort 立刻 resolve，不会让
   * stop()/stopAll() 卡在这里等一整个 `EARLY_RETRY_DELAY_MS`。`ms <= 0`
   * 直接同步 resolve（测试用，注入 0 跳过真实等待）。
   */
  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
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
