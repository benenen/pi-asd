import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * 回归：asd_agents 被拿掉的承重点是「不再注册」，不是删掉 tools.agents() 的内部实现。
 * 只测提示词里没有这个名字挡不住以后误把 registerTool 接回来，所以直接钉公开注册面。
 */
test("只注册 9 个公开工具，且不包含 asd_agents", () => {
  // index.ts 是仓库规定的唯一接线文件。不要 import 它做这条断言：pi 的依赖包会留下
  // 短时活动句柄，让一个纯注册测试平白多等十几秒；读接线源码既直接又无副作用。
  const source = readFileSync(new URL("../extensions/asd/index.ts", import.meta.url), "utf8");
  const registrations = source.match(/pi\.registerTool\s*\(\s*\{/g) ?? [];

  assert.equal(registrations.length, 9);
  assert.doesNotMatch(source, /name:\s*["']asd_agents["']/);
});
