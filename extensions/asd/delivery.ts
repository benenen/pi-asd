/**
 * 往 agent TUI 投递文本并确认它真的启动了一个 turn。
 *
 * 这里不判断 session 能不能接活，也不碰台账；调用方在 tools.ts 做完所有权和复用
 * 决策后才进来。单独成层是因为「稳定回显 → Enter → 提交确认 → 最多补一次 Enter」
 * 本身已经是一套状态机，不该继续塞在工具编排函数里。
 */

import { randomUUID } from "node:crypto";
import type { Asd, ScreenSnapshot } from "./cli.ts";
import { detectDialog } from "./dialog.ts";

const SIGNATURE_CHARS = 24;
const NOISE = /[\s─-╿│█│┃┆┊|>›❯»·]+/g;
const BORDERS = /[─-╿│█│┃┆┊|>›❯»·]+/g;

/** 长文本经 PTY 进入 TUI 时会逐帧回显；轮询到真正稳定以后才能送 Enter。 */
export const ECHO_POLL_MS = 100;
/** 必须连续稳定这么久；高于 Codex paste-burst 的 120ms Enter 抑制窗口。 */
export const ECHO_STABLE_MS = 250;
/** 文本始终不出现或一直不稳定时放弃，不能无限卡住工具调用。 */
export const ECHO_TIMEOUT_MS = 5_000;
/** Enter 后空白布局变化保持这么久，才判定它只插入了换行、需要补一次。 */
export const SUBMIT_STABLE_MS = 250;

export type DeliveryPhase = "text" | "submit";
export type Delivery =
  | { ok: true }
  | { ok: false; phase: DeliveryPhase; reason: string; gone?: true };

export interface DeliveryDeps {
  asd: Asd;
  sleep(ms: number): Promise<void>;
}

type ComposerAnchor =
  | { kind: "prompt"; marker: string; prefix: string }
  | { kind: "framed" };

interface ComposerView {
  fullLines: string[];
  beforeCursorLines: string[];
  clipped?: true;
  rootRow?: number;
}

type ComposerPayloadState = "present" | "mismatch" | "absent" | "unknown";

function deliveryMarker(): string {
  return `<!-- pi-asd-delivery:${randomUUID()} -->`;
}

function screenFingerprint(screen: string): string {
  return screen.replace(NOISE, "");
}

function screenLayout(screen: string): string {
  return screen.replace(BORDERS, "");
}

/** 结构解析失效时的最后防线：唯一 proof 是否还清楚可见在当前屏幕。 */
function screenHasProof(screen: string, proof: string): boolean {
  const needle = screenFingerprint(proof);
  return needle.length > 0 && screenFingerprint(screen).includes(needle);
}

export function screenHasText(screen: string, text: string): boolean {
  const needle = screenFingerprint(text).slice(0, SIGNATURE_CHARS);
  return needle.length > 0 && screenFingerprint(screen).includes(needle);
}

const COMPOSER_PROMPT = /^(\s*[│┃|]?\s*)([›❯>])\s?/;
const CODEX_FOOTER = /(?:\bContext \d+% used\b|\b\d+% context left\b|\btab to queue message\b)/i;
const CODEX_PLACEHOLDERS = new Set(["Explain this codebase", "Ask anything"]);
const PI_MORE_FRAME = /^─{3}\s+↑\s+(\d+)\s+more\s+─+$/;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const KEYCAP_OR_EMOJI_VARIANT = /[\u20e3\ufe0f]/u;
const MARKS_ONLY = /^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u;

/**
 * 把 `peek --json` 补成完整终端行数，并先验证光标/尺寸。没有这些结构证据时，
 * 宁可拒绝投递，也不能拿历史区或 placeholder 猜一个 composer 边界。
 */
function snapshotLines(snapshot: ScreenSnapshot): string[] | undefined {
  const lines = snapshot.screen.split("\n");
  const { row, col } = snapshot.cursor;
  if (
    !Number.isInteger(snapshot.rows) ||
    !Number.isInteger(snapshot.cols) ||
    snapshot.rows <= 0 ||
    snapshot.cols <= 0 ||
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    row >= snapshot.rows ||
    col < 0 ||
    col > snapshot.cols ||
    lines.length > snapshot.rows
  ) {
    return undefined;
  }
  // `asd peek --json` 的 screen 会省略底部空白行，但 cursor 仍按完整终端坐标上报。
  // stdin 正等输入的 shell 常见 `screen="READY"`、cursor.row=1；补空行才能看出
  // 光标其实已经在 READY 下面的空输入位，而不是停在 READY 文本末尾。
  while (lines.length < snapshot.rows) lines.push("");
  return lines;
}

function isFullwidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
      (codePoint >= 0x3040 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
      (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function graphemeWidth(grapheme: string, currentCol: number): number {
  if (grapheme === "\t") return 8 - (currentCol % 8);
  if (grapheme === "" || MARKS_ONLY.test(grapheme)) return 0;
  const first = grapheme.codePointAt(0);
  if (first === undefined || first < 0x20 || (first >= 0x7f && first < 0xa0)) return 0;
  return EMOJI.test(grapheme) ||
    EMOJI_PRESENTATION.test(grapheme) ||
    KEYCAP_OR_EMOJI_VARIANT.test(grapheme) ||
    isFullwidthCodePoint(first)
    ? 2
    : 1;
}

/** 按终端 cell 而不是 JS 索引截断，避免中文让 slice 越过真实光标吃到右侧 proof。 */
function sliceToCursor(line: string, col: number): string {
  let width = 0;
  let end = 0;
  for (const { segment, index } of GRAPHEMES.segment(line)) {
    const next = width + graphemeWidth(segment, width);
    if (next > col) break;
    width = next;
    end = index + segment.length;
  }
  return line.slice(0, end);
}

/**
 * pi 0.83 的边框一定是**终端全宽的 Unicode `─`**；长输入的上框只多一个
 * `↑ N more`。ASCII `----`、短横线或其它线形都可能是用户正文，绝不能当边框。
 */
function piHiddenRows(line: string): number | undefined {
  const match = PI_MORE_FRAME.exec(line);
  if (match === null) return undefined;
  const rows = Number(match[1]);
  return Number.isSafeInteger(rows) && rows > 0 ? rows : undefined;
}

function isPiFrame(line: string, cols: number): boolean {
  if ([...line].length !== cols) return false;
  return /^─+$/.test(line) || piHiddenRows(line) !== undefined;
}

/**
 * pi 输入框必须恰好有一对全宽边框并包住光标。多出任何候选边框都属于歧义：
 * 它可能是用户在草稿里输入的一整行 `─`，此时猜“最近一条”会藏掉旧草稿。
 */
function framedComposerView(snapshot: ScreenSnapshot): ComposerView | undefined {
  const lines = snapshotLines(snapshot);
  if (lines === undefined) return undefined;
  const frames = lines.flatMap((line, row) =>
    isPiFrame(line, snapshot.cols) ? [row] : [],
  );
  if (frames.length !== 2) return undefined;
  const [top, bottom] = frames;
  if (
    top === undefined ||
    bottom === undefined ||
    !(top < snapshot.cursor.row && snapshot.cursor.row < bottom)
  ) {
    return undefined;
  }
  const fullLines = lines.slice(top + 1, bottom);
  const beforeCursorLines = [
    ...lines.slice(top + 1, snapshot.cursor.row),
    sliceToCursor(lines[snapshot.cursor.row]!, snapshot.cursor.col),
  ];
  return {
    fullLines,
    beforeCursorLines,
    clipped: piHiddenRows(lines[top]!) === undefined ? undefined : true,
  };
}

function promptComposerView(
  snapshot: ScreenSnapshot,
  anchor: Extract<ComposerAnchor, { kind: "prompt" }>,
): ComposerView | undefined {
  const lines = snapshotLines(snapshot);
  if (lines === undefined) return undefined;

  let rootRow = -1;
  let rootMatch: RegExpExecArray | undefined;
  for (let row = snapshot.cursor.row; row >= 0; row--) {
    const match = COMPOSER_PROMPT.exec(lines[row]!);
    if (match === null || match[1] !== "") continue;
    // 最近的根 prompt 就是当前 composer；字形不同说明界面已经换代，不能跨过去
    // 拼历史内容。任务正文中的 prompt 字形由 Codex/Claude 缩进，不会走这里。
    if (match[2] !== anchor.marker) return undefined;
    rootRow = row;
    rootMatch = match;
    break;
  }
  if (rootRow < 0 || rootMatch === undefined) return undefined;

  // footer 文案本身可由用户输入。只有它是屏幕**最后一条非空行**时才有结构意义；
  // 草稿中间的 `tab to queue message` 不能把它后面的旧内容截出 composer。
  const footerRow = lines.findIndex(
    (line, row) =>
      row > rootRow &&
      CODEX_FOOTER.test(line) &&
      lines.slice(row + 1).every((tail) => tail.trim().length === 0),
  );
  let bottom = lines.length;
  if (footerRow >= 0) {
    const separator = footerRow - 1;
    if (separator <= rootRow || lines[separator]!.trim().length !== 0) return undefined;
    bottom = separator;
  }
  if (snapshot.cursor.row < rootRow || snapshot.cursor.row >= bottom) return undefined;

  const fullLines = [
    lines[rootRow]!.slice(rootMatch[0].length),
    ...lines.slice(rootRow + 1, bottom),
  ];
  const beforeCursorLines =
    snapshot.cursor.row === rootRow
      ? [sliceToCursor(lines[rootRow]!, snapshot.cursor.col).slice(rootMatch[0].length)]
      : [
          lines[rootRow]!.slice(rootMatch[0].length),
          ...lines.slice(rootRow + 1, snapshot.cursor.row),
          sliceToCursor(lines[snapshot.cursor.row]!, snapshot.cursor.col),
        ];
  // prompt 路径只接受完整 payload：Codex/Claude 裁顶没有可校验的完整首部。
  // pi 即使给出 `↑ N more` 也同样 fail closed，见 viewHasPayload 的竞态说明。
  return { fullLines, beforeCursorLines, rootRow };
}

/** 完整输入与光标前内容都必须精确等于本次带唯一 proof 的 payload。 */
function composerText(input: string): string {
  return input.replace(/\s/g, "");
}

function inputHasPayload(input: string, text: string): boolean {
  // prompt/框线已由上层结构化剔除，这里只忽略 TUI 折行和 continuation
  // 缩进产生的空白。`>`、`─` 等字符也可能是外部 attach 并发输入的
  // 真实草稿，绝不能再用整屏噪声规则删掉，否则会把 `><payload>` 误当精确命中。
  const fullText = composerText(text);
  const actual = composerText(input);
  return actual.length > 0 && actual === fullText;
}

function viewHasPayload(view: ComposerView, text: string): boolean {
  // `↑ N more` 只能证明 pi 裁掉了多少终端行，不能证明裁掉的字符就是
  // 本次 payload。判空后、sendText 前若有人同时输入 `OLD:`，它可以和 payload
  // 首行拼在同一终端行：N 不变、可见尾部和 proof 也全对，但 Enter 会把
  // `OLD:<payload>` 一起提交。没有原子读完整 composer 的协议前，裁顶一律 fail closed。
  if (view.clipped === true) return false;
  return (
    inputHasPayload(view.fullLines.join("\n"), text) &&
    inputHasPayload(view.beforeCursorLines.join("\n"), text)
  );
}

function composerPayloadState(
  snapshot: ScreenSnapshot,
  text: string,
  proof: string,
  anchor: ComposerAnchor,
): ComposerPayloadState {
  const view =
    anchor.kind === "prompt"
      ? promptComposerView(snapshot, anchor)
      : framedComposerView(snapshot);
  if (view === undefined) return "unknown";
  if (viewHasPayload(view, text)) return "present";
  // `absent` 专指唯一 proof 真的已离开当前 composer。如果 Enter 没提交，
  // 外部 attach 只是把它改成 `X<payload>`，全文虽不再 exact，proof 却还在；
  // 把这种 mismatch 当 absent 会谎报已提交。裁顶视图也只能给 mismatch。
  const proofStillInComposer = composerText(view.fullLines.join("\n")).includes(
    composerText(proof),
  );
  return proofStillInComposer || view.clipped === true ? "mismatch" : "absent";
}

function composerHasText(
  snapshot: ScreenSnapshot,
  text: string,
  proof: string,
  anchor: ComposerAnchor,
): boolean {
  return composerPayloadState(snapshot, text, proof, anchor) === "present";
}

/** 发送正文前必须确认当前输入位为空，并保存之后校验要用的 prompt 锚点。 */
function emptyComposerAnchor(snapshot: ScreenSnapshot): ComposerAnchor | undefined {
  const lines = snapshotLines(snapshot);
  if (lines === undefined) return undefined;
  const framed = framedComposerView(snapshot);
  if (framed !== undefined) {
    // 上框已是 `↑ N more` 就证明还有不可见内容；即使当前可见行为空，
    // 也不能冒充空 composer 再把新任务追加进去。这条必须在 sendText 前拦。
    return framed.clipped !== true && framed.fullLines.every((line) => line.trim().length === 0)
      ? { kind: "framed" }
      : undefined;
  }
  const currentLine = lines[snapshot.cursor.row] ?? "";
  const prompt = COMPOSER_PROMPT.exec(currentLine);
  // ASCII `>` 按正文处理：pi 里用户完全可以输入一行 `> `，不能把它当根 prompt。
  // 没有根 prompt、也没有 pi 横线框时，纯文本快照无法证明空光标不是旧草稿的
  // continuation，生产路径一律拒绝；真 e2e 探针也画一个 `›` 根 prompt。
  if (prompt === null || prompt[1] !== "" || prompt[2] === ">") {
    return undefined;
  }
  const anchor = { kind: "prompt", marker: prompt[2]!, prefix: prompt[1]! } as const;
  const view = promptComposerView(snapshot, anchor);
  if (view === undefined || view.rootRow !== snapshot.cursor.row) return undefined;

  const [first = "", ...rest] = view.fullLines;
  const remainingEmpty = rest.every((line) => line.trim().length === 0);
  const genuinelyEmpty = first.trim().length === 0 && remainingEmpty;
  const knownPlaceholder =
    snapshot.cursor.col === prompt[0].length &&
    CODEX_PLACEHOLDERS.has(first.trim()) &&
    remainingEmpty;
  return genuinelyEmpty || knownPlaceholder ? anchor : undefined;
}

/** 只有新正文出现在光标所在 composer，才允许进入稳定计时。 */
function hasNewComposerEcho(
  before: ScreenSnapshot,
  after: ScreenSnapshot,
  text: string,
  proof: string,
  anchor: ComposerAnchor,
): boolean {
  if (screenFingerprint(after.screen) === screenFingerprint(before.screen)) return false;
  return (
    composerPayloadState(after, text, proof, anchor) === "present" &&
    composerPayloadState(before, text, proof, anchor) !== "present"
  );
}

/** 找到任务特征最后一次出现时，在保留空白布局的屏幕里结束于哪个 raw offset。 */
function signatureEnd(screen: string, text: string): number | undefined {
  const needle = screenFingerprint(text);
  if (needle.length === 0) return undefined;

  let compact = "";
  const rawEnds: number[] = [];
  for (let i = 0; i < screen.length; i++) {
    const ch = screen[i]!;
    if (/\s/.test(ch)) continue;
    compact += ch;
    rawEnds.push(i + 1);
  }
  // 同一段任务可能早就在历史区出现过；composer 是屏幕里最后一次出现的位置。
  const start = compact.lastIndexOf(needle);
  if (start < 0) return undefined;
  return rawEnds[start + needle.length - 1];
}

/**
 * 第一颗 Enter 是否只在原 composer 的任务文字**之后**多插入了空白。
 *
 * 整屏文本命中不够：提交成功后任务会移到历史区，文字仍然一模一样。这里要求任务
 * 特征结束前的布局逐字符不动，结束后只允许增加空白；任务前插入空白、移动位置或
 * 改写任何非空白内容都不算换行证据，宁可报未确认也不补 Enter。
 */
function hasComposerNewline(before: ScreenSnapshot, after: ScreenSnapshot, proof: string): boolean {
  const beforeLayout = screenLayout(before.screen);
  const afterLayout = screenLayout(after.screen);
  const end = signatureEnd(beforeLayout, proof);
  if (end === undefined || beforeLayout.slice(0, end) !== afterLayout.slice(0, end)) return false;

  const beforeTail = beforeLayout.slice(end);
  const afterTail = afterLayout.slice(end);
  const beforeContent = beforeTail.replace(/\s/g, "");
  const afterContent = afterTail.replace(/\s/g, "");
  if (beforeContent !== afterContent) return false;
  const layoutWhitespaceGrew =
    afterTail.length - afterContent.length > beforeTail.length - beforeContent.length;
  // raw screen 会省略尾部空行：Enter 只插入换行时 screen 字符串可能原样不动，
  // 但 JSON cursor 已经移到下一行。这也是正向换行证据，ignored Enter 不会移动它。
  return layoutWhitespaceGrew || after.cursor.row > before.cursor.row;
}

type SubmitObservation =
  | { kind: "changed" }
  | { kind: "newline"; snapshot: ScreenSnapshot }
  | { kind: "mismatch" }
  | { kind: "unchanged" }
  | { kind: "gone" };

async function observeSubmission(
  deps: DeliveryDeps,
  session: string,
  before: ScreenSnapshot,
  text: string,
  proof: string,
  anchor: ComposerAnchor,
): Promise<SubmitObservation> {
  const { asd, sleep } = deps;
  const beforeFingerprint = screenFingerprint(before.screen);
  let candidateKey: string | undefined;
  let candidateStableForMs = 0;
  let sawMismatch = false;
  for (let waitedMs = 0; waitedMs < ECHO_TIMEOUT_MS; waitedMs += ECHO_POLL_MS) {
    await sleep(ECHO_POLL_MS);
    const snapshot = await asd.peekSnapshot(session);
    if (snapshot === null) return { kind: "gone" };
    const { screen } = snapshot;
    // 提交后出现对话框也是明确的状态迁移。这里绝不能再补 Enter，否则会替用户确认。
    if (detectDialog(screen) !== undefined) return { kind: "changed" };
    const payloadState = composerPayloadState(snapshot, text, proof, anchor);
    // 仍能识别 composer 且唯一 proof 已经离开它，是比“整屏变了”更强的提交证据。
    if (payloadState === "absent") return { kind: "changed" };
    // agent 开跑后输入框可能整个消失；结构已无法识别时才退回用户指定的整屏变化判据。
    if (payloadState === "unknown") {
      // prompt 字形/UI 换代会让原 anchor 无法识别。不能只因为整屏变了
      // 就报提交：若 Enter 没生效而界面变成 `❯ X<payload>`，proof 仍在可见
      // 输入里。这时只能当 mismatch；唯有可见屏幕也找不到 proof 才用布局变化兜底。
      if (screenHasProof(screen, proof)) {
        sawMismatch = true;
      } else if (screenFingerprint(screen) !== beforeFingerprint) {
        return { kind: "changed" };
      }
    }
    if (payloadState === "mismatch") sawMismatch = true;

    if (payloadState === "present" && hasComposerNewline(before, snapshot, proof)) {
      const key = `${snapshot.cursor.row}:${snapshot.cursor.col}:${screen}`;
      if (key === candidateKey) {
        candidateStableForMs += ECHO_POLL_MS;
      } else {
        candidateKey = key;
        candidateStableForMs = 0;
      }
      if (candidateStableForMs >= SUBMIT_STABLE_MS) {
        return { kind: "newline", snapshot };
      }
    } else {
      candidateKey = undefined;
      candidateStableForMs = 0;
    }
  }
  return sawMismatch ? { kind: "mismatch" } : { kind: "unchanged" };
}

async function waitForStableEcho(
  deps: DeliveryDeps,
  session: string,
  text: string,
  proof: string,
  before: ScreenSnapshot,
  anchor: ComposerAnchor,
): Promise<Delivery | { ok: true; snapshot: ScreenSnapshot }> {
  const { asd, sleep } = deps;
  let previousScreen: string | undefined;
  let stableForMs = 0;
  let sawText = false;

  for (let waitedMs = 0; waitedMs < ECHO_TIMEOUT_MS; waitedMs += ECHO_POLL_MS) {
    await sleep(ECHO_POLL_MS);
    const snapshot = await asd.peekSnapshot(session);
    if (snapshot === null) {
      return {
        ok: false,
        phase: "submit",
        reason: `"${session}" 的 session 已经不在了`,
        gone: true,
      };
    }
    const { screen } = snapshot;
    const dialog = detectDialog(screen);
    if (dialog !== undefined) {
      return {
        ok: false,
        phase: "submit",
        reason: `任务文本送出后 "${session}" 出现了对话框（${dialog.summary}），没有按回车。`,
      };
    }

    if (hasNewComposerEcho(before, snapshot, text, proof, anchor)) {
      sawText = true;
      stableForMs = screen === previousScreen ? stableForMs + ECHO_POLL_MS : 0;
      previousScreen = screen;
      if (stableForMs >= ECHO_STABLE_MS) return { ok: true, snapshot };
    } else {
      previousScreen = undefined;
      stableForMs = 0;
    }
  }

  return {
    ok: false,
    phase: "submit",
    reason:
      (sawText
        ? `任务文本出现在 "${session}" 的屏幕上，但 ${ECHO_TIMEOUT_MS / 1000}s 内一直没有稳定。`
        : `asd 已接收任务文本，但它在 ${ECHO_TIMEOUT_MS / 1000}s 内没有出现在 "${session}" 的屏幕上，无法确认最终写入。`) +
      `没有按回车（此刻输入框里可能是别的东西，回车会误触它）。` +
      `用 asd_peek("${session}") 看看它卡在什么界面上。`,
  };
}

async function retryEnter(
  deps: DeliveryDeps,
  session: string,
  text: string,
  proof: string,
  stable: ScreenSnapshot,
  newline: ScreenSnapshot,
  anchor: ComposerAnchor,
): Promise<Delivery> {
  const { asd } = deps;
  // 补发前再读一屏，把稳定观察和真正按键之间的模态框窗口压到最小。
  const retrySnapshot = await asd.peekSnapshot(session);
  if (retrySnapshot === null) {
    return {
      ok: false,
      phase: "submit",
      reason: `"${session}" 在补发回车之前消失了；任务未确认提交`,
      gone: true,
    };
  }
  const retryScreen = retrySnapshot.screen;
  if (detectDialog(retryScreen) !== undefined) return { ok: true };
  const retryState = composerPayloadState(retrySnapshot, text, proof, anchor);
  if (retryState === "absent") return { ok: true };
  if (
    retryState === "unknown" &&
    !screenHasProof(retryScreen, proof) &&
    screenFingerprint(retryScreen) !== screenFingerprint(stable.screen)
  ) return { ok: true };
  if (
    retryState !== "present" ||
    retryScreen !== newline.screen ||
    retrySnapshot.cursor.row !== newline.cursor.row ||
    retrySnapshot.cursor.col !== newline.cursor.col ||
    !composerHasText(retrySnapshot, text, proof, anchor)
  ) {
    return {
      ok: false,
      phase: "submit",
      reason: `文本已输入 "${session}"，但补发回车前 composer 状态又发生变化；为避免误提交，没有补按键。`,
    };
  }

  if (!(await asd.key(session, "Enter"))) {
    return {
      ok: false,
      phase: "submit",
      reason: `"${session}" 在补发回车之前消失了；任务未确认提交`,
      gone: true,
    };
  }
  const second = await observeSubmission(deps, session, newline, text, proof, anchor);
  if (second.kind === "changed") return { ok: true };
  if (second.kind === "gone") {
    return {
      ok: false,
      phase: "submit",
      reason: `"${session}" 在补发回车后消失了；任务未确认提交`,
      gone: true,
    };
  }
  return {
    ok: false,
    phase: "submit",
    reason: `文本已输入 "${session}"，但两次回车后仍未确认提交；不会重发任务或改派。`,
  };
}

async function deliver(deps: DeliveryDeps, session: string, text: string): Promise<Delivery> {
  const { asd } = deps;
  const before = await asd.peekSnapshot(session);
  if (before === null) {
    return {
      ok: false,
      phase: "text",
      reason: `"${session}" 的 session 已经不在了`,
      gone: true,
    };
  }
  const initialDialog = detectDialog(before.screen);
  if (initialDialog !== undefined) {
    return {
      ok: false,
      phase: "text",
      reason: `"${session}" 正停在对话框上（${initialDialog.summary}），没有发送任务，也没有按回车。`,
    };
  }
  const anchor = emptyComposerAnchor(before);
  if (anchor === undefined) {
    return {
      ok: false,
      phase: "text",
      reason: `"${session}" 的输入框里已有未提交内容；没有追加任务，也没有按回车。`,
    };
  }
  const proof = deliveryMarker();
  const payload = `${text}\n${proof}`;
  if (!(await asd.sendText(session, payload))) {
    return {
      ok: false,
      phase: "text",
      reason: `"${session}" 的 session 已经不在了`,
      gone: true,
    };
  }

  const echoed = await waitForStableEcho(deps, session, payload, proof, before, anchor);
  if (!echoed.ok) return echoed;
  if (!("snapshot" in echoed)) return echoed;

  if (!(await asd.key(session, "Enter"))) {
    return {
      ok: false,
      phase: "submit",
      reason: `"${session}" 在按回车之前消失了；任务未提交`,
      gone: true,
    };
  }
  const first = await observeSubmission(deps, session, echoed.snapshot, payload, proof, anchor);
  if (first.kind === "changed") return { ok: true };
  if (first.kind === "gone") {
    return {
      ok: false,
      phase: "submit",
      reason: `"${session}" 在确认任务提交时消失了`,
      gone: true,
    };
  }
  if (first.kind === "unchanged") {
    return {
      ok: false,
      phase: "submit",
      reason: `文本已输入 "${session}"，但第一颗回车后屏幕完全未变化，无法确认提交；没有盲目补第二颗回车。`,
    };
  }
  if (first.kind === "mismatch") {
    return {
      ok: false,
      phase: "submit",
      reason: `文本已输入 "${session}"，但第一颗回车后唯一 proof 仍在 composer，且全文已发生变化；为避免误提交，没有补第二颗回车。`,
    };
  }
  return await retryEnter(
    deps,
    session,
    payload,
    proof,
    echoed.snapshot,
    first.snapshot,
    anchor,
  );
}

/** 创建一个共享同一 asd/sleep 依赖的投递器。 */
export function createDeliver(
  deps: DeliveryDeps,
): (session: string, text: string) => Promise<Delivery> {
  return async (session, text) => await deliver(deps, session, text);
}
