import { test } from "node:test";
import assert from "node:assert/strict";
import { bossModePrompt } from "../extensions/asd/prompt.ts";

test("没有活跃 agent 时只给定义段，不给清单段", () => {
  const p = bossModePrompt({ agents: [] });
  assert.match(p, /Boss Mode/);
  assert.match(p, /asd_spawn/);
  assert.doesNotMatch(p, /当前 agent/);
});

test("定义段写明不要自己先调研、不要等齐、必须跟到结束", () => {
  const p = bossModePrompt({ agents: [] });
  assert.match(p, /不要自己先调研|不要先自己调研/);
  assert.match(p, /不要等齐/);
  assert.match(p, /不许 spawn 完就|必须跟到/);
});

test("有 agent 时列出清单，任务被截断到 80 字", () => {
  const long = "任".repeat(200);
  const p = bossModePrompt({
    agents: [{ session: "pi-a", task: long, agent: "pi", watching: true }],
  });
  assert.match(p, /当前 agent/);
  assert.match(p, /pi-a/);
  assert.ok(!p.includes(long), "整段超长任务不该原样进提示词");
  assert.match(p, /…/);
});

test("清单里标出 watcher 挂没挂上", () => {
  const p = bossModePrompt({
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
    agents: [{ session: "pi-a", task: "t", agent: "pi", watching: true }],
  });
  assert.match(p, /绝对不要.*bash sleep/);
  assert.match(p, /asd_agents/);
});

test("bossSession 给了就写进提示词，没给就不写", () => {
  assert.match(bossModePrompt({ agents: [], bossSession: "a" }), /你自己跑在 asd session "a"/);
  assert.doesNotMatch(bossModePrompt({ agents: [] }), /你自己跑在 asd session/);
});
