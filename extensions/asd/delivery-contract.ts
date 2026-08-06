import type { Asd } from "./cli.ts";

/** 长文本经 PTY 进入 TUI 时会逐帧回显；轮询到真正稳定以后才能送 Enter。 */
export const ECHO_POLL_MS = 100;
/** 必须连续稳定这么久；高于 Codex paste-burst 的 120ms Enter 抑制窗口。 */
export const ECHO_STABLE_MS = 250;
/** 文本始终不出现或一直不稳定时放弃，不能无限卡住工具调用。 */
export const ECHO_TIMEOUT_MS = 5_000;
/** Enter 后布局变化保持这么久，才认为第一颗 Enter 只插入了换行。 */
export const SUBMIT_STABLE_MS = 250;

export type DeliveryPhase = "text" | "submit";
type DeliveryFailure = { ok: false; phase: DeliveryPhase; reason: string };
export type Delivery =
  | { ok: true }
  | (DeliveryFailure & { gone: true; retainControl?: never; pendingComposer?: never })
  | (DeliveryFailure & { gone?: never; retainControl?: never; pendingComposer?: never })
  | (DeliveryFailure & {
      gone?: never;
      /** 已有屏幕证据表明我们修改过 session；失败后仍须保留输入控制权。 */
      retainControl: true;
      /** 唯一 proof 仍在原 composer，去掉 TUI 布局空白后的可见正文匹配本次 payload。 */
      pendingComposer?: true;
    });

export interface DeliveryDeps {
  asd: Asd;
  sleep(ms: number): Promise<void>;
}
