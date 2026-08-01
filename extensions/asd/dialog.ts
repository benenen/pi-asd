/**
 * 从一屏文字里认出「agent 弹了个模态对话框，正在等人做决策」。
 *
 * 为什么需要它：`asd follow` 只知道"终端安静下来了"，分不出这一屏是"活干完了"
 * 还是"卡在一个选择框上等你按键"。两者对 boss 来说是完全不同的动作 —— 前者是
 * 去读结果，后者是**必须有人做决策**，不处理就永远卡着。
 *
 * 这是启发式，不可能完备（各家 TUI 长得不一样，而且会改版）。取舍：
 * **宁可漏认，不可错认**。漏认退回原来的"已停下"通知，屏幕内容照样带上，boss
 * 自己也看得出来；错认则会给一屏正常输出扣上"需要决策"的帽子，把 boss 引去
 * 按键——那才是有破坏性的。所以判据要求"编号选项"和"底部按键提示"同时出现，
 * 而不是任一命中。
 */

/** `❯ 1. Yes, I trust this folder` / `  2. No, exit` —— 编号选项行。 */
const OPTION_LINE = /^\s*(❯|>|\*)?\s*(\d+)[.)]\s+(\S.*)$/;
/** 当前选中的那一行（行首有指示符）。 */
const SELECTED_MARK = /^\s*(❯|>|\*)\s*\d+[.)]\s+/;
/**
 * 底部的按键提示。这是"这是个等输入的控件"最强的正向证据 —— 一段普通输出里
 * 很难自然出现这种句式。
 */
const HINT_LINE = /\b(enter\s+to\s+(confirm|select|continue|choose|submit)|press\s+enter|esc\s+to\s+cancel|↑\/↓|space\s+to\s+(toggle|select))/i;

/** 纯装饰行：分隔线、边框、复选符之类，不可能是问题。 */
const DECORATION = /^[─━=—\-_·☐☑✓╭╰│┌└├┤┬┴┼\s]+$/;
/** 往上翻几行去找问题。翻太多会把上一轮的输出当成问题。 */
const QUESTION_LOOKBACK = 6;
/** 看起来像个问句 —— 中英文都收。 */
const INTERROGATIVE = /[?？]\s*$|[?？]/;

export interface DialogInfo {
  /** 选项行原文，按屏幕顺序。 */
  options: string[];
  /** 当前选中项（去掉行首指示符）；认不出就是 undefined。 */
  selected?: string;
  /** 底部按键提示原文。 */
  hint: string;
  /** 对话框上方最近的一行非空文字，通常是问题本身。 */
  question?: string;
  /** 给通知用的一段摘要。 */
  summary: string;
}

/**
 * 认出对话框就返回它的结构，认不出返回 undefined。
 *
 * 只看屏幕**尾部**若干行：对话框是模态的，永远画在最下面；往上翻会把历史输出里
 * 碰巧长得像选项的行（比如 agent 自己打印的编号列表）也算进来。
 */
export function detectDialog(screen: string | null, tailLines = 24): DialogInfo | undefined {
  if (screen === null) return undefined;
  const lines = screen.split("\n").map((l) => l.replace(/\s+$/, ""));
  const tail = lines.slice(-tailLines);

  const hint = tail.find((l) => HINT_LINE.test(l));
  if (hint === undefined) return undefined;

  const options: string[] = [];
  let selected: string | undefined;
  let firstOptionIdx = -1;
  for (const [i, l] of tail.entries()) {
    if (!OPTION_LINE.test(l)) continue;
    if (firstOptionIdx < 0) firstOptionIdx = i;
    const text = l.trim();
    options.push(text);
    if (selected === undefined && SELECTED_MARK.test(l)) {
      selected = text.replace(/^(❯|>|\*)\s*/, "");
    }
  }
  // 两个条件都要满足 —— 见文件头的取舍说明。
  if (options.length < 2) return undefined;

  // 找问题本身：从选项往上翻几行。
  //
  // 不能简单取"最近的一行非空文字" —— 对话框和问题之间常常隔着补充说明或链接。
  // 实测 claude 的信任框那样取会拿到 "Security guide"（一个链接行），而真正的
  // 问句在更上面。所以优先挑**看起来像疑问句**的那一行，找不到再退回最近一行。
  const above: string[] = [];
  for (let i = firstOptionIdx - 1; i >= 0 && above.length < QUESTION_LOOKBACK; i--) {
    const l = tail[i]?.trim() ?? "";
    if (l.length === 0 || DECORATION.test(l)) continue;
    above.push(l);
  }
  const question = above.find((l) => INTERROGATIVE.test(l)) ?? above[0];

  const parts = [
    question !== undefined ? `问题：${question}` : undefined,
    `选项：${options.join(" | ")}`,
    selected !== undefined ? `当前选中：${selected}` : undefined,
    `提示：${hint.trim()}`,
  ].filter((x): x is string => x !== undefined);

  return { options, selected, hint: hint.trim(), question, summary: parts.join("\n") };
}
