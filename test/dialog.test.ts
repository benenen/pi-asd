import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDialog } from "../extensions/asd/dialog.ts";

/** claude 在未信任目录里弹的信任确认 —— 从真实屏幕抄下来的。 */
const CLAUDE_TRUST = `
 Quick safety check: Is this a project you created or one you trust?
 Claude Code'll be able to read, edit, and execute files here.
 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

/** 用户描述的那种形态：分隔线 + 复选符 + 编号选项 + Enter to select。 */
const MEM_STYLE = `
──────────────────────────────────────────
 ☐ 这个 Skill 的产物形态？
 ❯ 1. 只生成 SKILL.md
   2. SKILL.md + references/
   3. 完整脚手架
 ↑/↓ 选择 · Enter to select
`;

test("认出 claude 的信任对话框，并抽出问题、选项、选中项", () => {
  const d = detectDialog(CLAUDE_TRUST);
  assert.ok(d !== undefined, "应当认出来");
  assert.equal(d.options.length, 2);
  assert.match(d.selected!, /Yes, I trust this folder/);
  assert.match(d.hint, /Enter to confirm/);
  // 问题行要挑到真正的问句，而不是它下面那个 "Security guide" 链接行
  assert.match(d.question!, /Is this a project you created or one you trust\?/);
  assert.match(d.summary, /选项：/);
  assert.match(d.summary, /当前选中：/);
});

test("认出带分隔线/复选符的那种形态，问题行不会取到装饰行", () => {
  const d = detectDialog(MEM_STYLE);
  assert.ok(d !== undefined);
  assert.equal(d.options.length, 3);
  assert.match(d.selected!, /只生成 SKILL\.md/);
  assert.match(d.question!, /产物形态/, "问题行应当跳过纯分隔线和复选符");
});

/**
 * 取舍：宁可漏认，不可错认。漏认只是退回"已停下"的通知（屏幕照样带上）；
 * 错认会给一屏正常输出扣上"需要决策"的帽子，把 boss 引去按键 —— 那才有破坏性。
 * 所以「编号选项」和「底部按键提示」必须同时出现。
 */
test("只有编号列表、没有按键提示 → 不认（agent 自己打印的编号列表很常见）", () => {
  const notDialog = `
 我找到三个问题：
 1. 配置没生效
 2. 回车被吞
 3. session 一秒消失
 接下来我去逐个验证。
`;
  assert.equal(detectDialog(notDialog), undefined);
});

test("只有按键提示、没有编号选项 → 不认", () => {
  assert.equal(detectDialog("正在等待…\n Press Enter to continue"), undefined);
});

test("只有一个选项 → 不认（够不上「要做选择」）", () => {
  assert.equal(detectDialog(" ❯ 1. OK\n Enter to confirm"), undefined);
});

test("普通屏幕 / 空屏 / null 都不认", () => {
  assert.equal(detectDialog(null), undefined);
  assert.equal(detectDialog(""), undefined);
  assert.equal(detectDialog("0.0%/1.0M (auto)   deepseek-v4-pro • high"), undefined);
});

/**
 * 对话框是模态的，永远画在屏幕最下面。只看尾部若干行，免得把历史输出里
 * 碰巧长得像选项的行也算进来。
 */
test("只看屏幕尾部 —— 老早滚上去的编号列表不算数", () => {
  const old = " ❯ 1. 旧的选项\n   2. 另一个\n Enter to confirm";
  const noise = Array.from({ length: 40 }, (_, i) => `输出行 ${i}`).join("\n");
  assert.equal(detectDialog(`${old}\n${noise}`), undefined, "对话框已经滚出尾部窗口");
  assert.ok(detectDialog(`${noise}\n${old}`) !== undefined, "在尾部就认得出");
});

test("问题和选项之间隔着说明/链接行时，仍然挑得到真正的问句", () => {
  const d = detectDialog(`
 要把这个结论写进 Skill 吗？
 这一步会改动 SKILL.md，且不可撤销。
 参考文档
 ❯ 1. 写入
   2. 跳过
 Enter to select
`);
  assert.ok(d !== undefined);
  assert.match(d.question!, /要把这个结论写进 Skill 吗？/, "不该取到最近的「参考文档」");
});

test("一个问句都没有时，退回最近的一行非装饰文字", () => {
  const d = detectDialog(`
 接下来怎么做
 ❯ 1. 继续
   2. 停下
 Enter to select
`);
  assert.ok(d !== undefined);
  assert.match(d.question!, /接下来怎么做/);
});
