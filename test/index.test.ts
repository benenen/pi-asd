import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * `asd_list` 是所有 asd session 的公开清单；旧的 `asd_agents` 仍然不能顺手接回来。
 * 后者只看 pi-asd 台账，而且曾让 boss 陷进轮询循环。直接钉接线层，避免两个名字混淆。
 */
test("注册 10 个公开工具：包含 asd_list，仍不包含 asd_agents", () => {
  // index.ts 是仓库规定的唯一接线文件。不要 import 它做这条断言：pi 的依赖包会留下
  // 短时活动句柄，让一个纯注册测试平白多等十几秒；读接线源码既直接又无副作用。
  const source = readFileSync(new URL("../extensions/asd/index.ts", import.meta.url), "utf8");
  const registrations = source.match(/pi\.registerTool\s*\(\s*\{/g) ?? [];

  assert.equal(registrations.length, 10);
  assert.match(source, /name:\s*["']asd_list["']/);
  assert.doesNotMatch(source, /name:\s*["']asd_agents["']/);
});

test("每轮 agent 执行开始时重置 asd_list 的单次调用额度", () => {
  const source = readFileSync(new URL("../extensions/asd/index.ts", import.meta.url), "utf8");
  assert.match(source, /pi\.on\(\s*["']before_agent_start["'][\s\S]*?tools\.resetListAllowance\(\)/);
});
