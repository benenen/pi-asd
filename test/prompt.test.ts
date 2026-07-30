import { test } from "node:test";
import assert from "node:assert/strict";
import { bossModePrompt } from "../extensions/asd/prompt.ts";

test("没有活跃 agent 时只给定义段，不给清单段", () => {
  const p = bossModePrompt({ enabled: true, defaultAgent: "pi", agents: [] });
  assert.match(p, /Boss Mode/);
  assert.match(p, /asd_spawn/);
  assert.doesNotMatch(p, /当前 agent/);
});

test("定义段写明 boss 只分配不执行、通过 candidates 选 session", () => {
  const p = bossModePrompt({ enabled: true, defaultAgent: "pi", agents: [] });
  assert.match(p, /分派任务.*不是自己干/);
  assert.match(p, /绝不要自己动手/);
  assert.match(p, /asd_candidates/);
  assert.match(p, /不读文件.*不跑命令.*不做调研/);
});

test("有 agent 时列出清单，任务被截断到 80 字", () => {
  const long = "任".repeat(200);
  const p = bossModePrompt({
    enabled: true,
    defaultAgent: "pi",
    agents: [{ session: "pi-a", task: long, agent: "pi", watching: true }],
  });
  assert.match(p, /当前 agent/);
  assert.match(p, /pi-a/);
  assert.ok(!p.includes(long), "整段超长任务不该原样进提示词");
  assert.match(p, /…/);
});

test("清单里标出 watcher 挂没挂上", () => {
  const p = bossModePrompt({
    enabled: true,
    defaultAgent: "pi",
    agents: [
      { session: "pi-a", task: "t", agent: "pi", watching: true },
      { session: "pi-b", task: "t", agent: "claude", watching: false },
    ],
  });
  assert.match(p, /^- pi-a.*watcher 已挂/m);
  assert.match(p, /^- pi-b.*watcher 未挂/m);
});

test("有 agent 时明确禁止 sleep 轮询", () => {
  const p = bossModePrompt({
    enabled: true,
    defaultAgent: "pi",
    agents: [{ session: "pi-a", task: "t", agent: "pi", watching: true }],
  });
  assert.match(p, /绝对不要.*bash sleep/);
  assert.match(p, /asd_agents/);
});

test("bossSession 给了就写进提示词，没给就不写", () => {
  assert.match(
    bossModePrompt({ enabled: true, defaultAgent: "pi", agents: [], bossSession: "a" }),
    /你自己跑在 asd session "a"/,
  );
  assert.doesNotMatch(bossModePrompt({ enabled: true, defaultAgent: "pi", agents: [] }), /你自己跑在 asd session/);
});

test("定义段告诉 boss 可以先看候选再指名把任务交出去", () => {
  const p = bossModePrompt({ enabled: true, defaultAgent: "pi", agents: [] });
  assert.match(p, /asd_candidates/);
  assert.match(p, /session:/);
  assert.match(p, /asd_kill 不会结束它/);
});

test("关闭时返回空串，一个字都不加", () => {
  assert.equal(bossModePrompt({ enabled: false, defaultAgent: "pi", agents: [] }), "");
});

test("关闭时即使有活跃 agent 也不加提示词", () => {
  const p = bossModePrompt({
    enabled: false,
    defaultAgent: "pi",
    agents: [{ session: "pi-a", task: "t", agent: "pi", watching: true }],
  });
  assert.equal(p, "");
});

test("关闭时 bossSession 也不泄漏进提示词", () => {
  assert.equal(bossModePrompt({ enabled: false, defaultAgent: "pi", agents: [], bossSession: "a" }), "");
});

test("开启时提示词写明这一轮默认用哪个 agent", () => {
  const p = bossModePrompt({ enabled: true, defaultAgent: "claude", agents: [] });
  assert.match(p, /默认用 claude/);
});

test("默认 agent 换一个，提示词跟着换", () => {
  const p = bossModePrompt({ enabled: true, defaultAgent: "codex", agents: [] });
  assert.match(p, /默认用 codex/);
  assert.doesNotMatch(p, /默认用 pi/);
});
