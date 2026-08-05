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

/**
 * 提示词以前从没提过 asd_steer，boss 想给在跑的 agent 补一句话时只知道 spawn ——
 * 那会走复用/指名交给的路径，把补充信息当成一个新任务发过去，语义是错的。
 * 这条只在有活跃 agent 时才有意义，所以放在清单段。
 */
test("有 agent 时告诉 boss 补充信息用 asd_steer，而不是再 spawn 一遍", () => {
  const p = bossModePrompt({
    enabled: true,
    defaultAgent: "pi",
    agents: [{ session: "pi-a", task: "t", agent: "pi", watching: true }],
  });
  assert.match(p, /asd_steer\(session, message\)/);
  assert.match(p, /不要用 asd_spawn 再发一遍/);

  // 没有活跃 agent 时不该出现 —— 那会儿还没人可 steer
  const empty = bossModePrompt({ enabled: true, defaultAgent: "pi", agents: [] });
  assert.doesNotMatch(empty, /asd_steer/);
});

/**
 * 回归：原来的禁令只写了"不要用 bash sleep 轮询"，模型找到了空子 —— 改成连着调
 * asd_agents 看有没有变化，技术上不是 bash sleep，但本质就是轮询。实测见过 boss
 * 连调四次 asd_agents 干等。所以禁令要按**行为**写，不是按工具写。
 *
 * （asd_agents 后来被彻底摘掉了，见下一条。禁令仍然按行为写 —— 剩下的工具照样
 * 能被连着调，尤其 asd_peek。）
 */
test("轮询禁令覆盖「反复调工具」，不只是 bash sleep", () => {
  const p = bossModePrompt({
    enabled: true,
    defaultAgent: "pi",
    agents: [{ session: "pi-a", task: "t", agent: "pi", watching: true }],
  });
  assert.match(p, /反复调任何一个\s*工具看有没有变化/s, "禁令要盖住所有工具，不是列举");
  assert.match(p, /连着调.*就是轮询/s, "要给出判定标准，不是列举工具");
  assert.match(p, /等待只有两种正确做法/, "禁完要给出正确做法");
  assert.match(p, /asd_follow/);
});

/**
 * `asd_agents` 仍然不存在；新增的 `asd_list` 只解决用户明确要看**全部 asd session**
 * 的需求，不能退化成新的等待/完成度工具。提示词要把这两件事同时说清。
 */
test("提示词只把 asd_list 用作全部 session 清单，不恢复 asd_agents", () => {
  const p = bossModePrompt({
    enabled: true,
    defaultAgent: "pi",
    agents: [{ session: "pi-a", task: "t", agent: "pi", watching: true }],
  });
  assert.doesNotMatch(p, /asd_agents/, "这个工具已经不存在了");
  assert.match(p, /上面这份清单每一轮都会重新算/, "要告诉它状态从哪来");
  assert.match(p, /用户明确要看.*全部.*session.*asd_list/s, "只在明确查全部 session 时使用");
  assert.match(p, /asd_list.*不.*任务成败/s, "不能把 session 活动误当成任务完成度");
});

test("有 agent 时明确禁止 sleep 轮询", () => {
  const p = bossModePrompt({
    enabled: true,
    defaultAgent: "pi",
    agents: [{ session: "pi-a", task: "t", agent: "pi", watching: true }],
  });
  assert.match(p, /绝对不要.*bash sleep/);
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
  assert.match(p, /asd_kill 只关得掉.*自己创建的/);
  assert.match(p, /不是自己创建的，关不掉/);
});

/**
 * 派活的三档优先级必须写死在提示词里，而且顺序不能乱：用户点了名就直接发给
 * 那个名字（用户已经替 boss 决定了），没点名才轮到 boss 自己从 candidates 里
 * 挑，一个都不对口才允许新建。少了第一档，boss 会在用户明说"让 mem 去查"时
 * 还去挑一遍甚至另起一个 session。
 */
test("定义段写明派活的三档顺序：点名 → 自己挑 → 新建", () => {
  const p = bossModePrompt({ enabled: true, defaultAgent: "pi", agents: [] });
  assert.match(p, /严格按这个顺序/);

  const named = p.indexOf("用户点了名");
  const pick = p.indexOf("没点名");
  const create = p.indexOf("一个都不对口");
  assert.ok(named > 0, "第一档：用户点名直接发过去");
  assert.ok(pick > 0, "第二档：没点名时自己挑");
  assert.ok(create > 0, "第三档：都不对口才新建");
  assert.ok(named < pick && pick < create, "三档必须按 点名 → 自己挑 → 新建 的顺序出现");

  // 第一档要说清"那个名字就是 asd session 名"，否则 boss 可能把它当成别的东西
  assert.match(p, /那个名字就是[\s\S]*asd session 名/);
  assert.match(p, /不要再挑、也不要新建/);
});

/**
 * 第一档最危险的失败模式：用户点的名字根本不存在（打错了、或者那个 session
 * 已经结束了）。这时 boss 有两种自作主张的走法 —— 改派给一个看起来差不多的，
 * 或者拿这个名字新建一个 —— 两种用户都会以为任务进了它点名的那个会话，而
 * 实际上没有。提示词必须要求先确认存在，找不到就停下来问。
 */
test("第一档要求先确认 session 存在，找不到就中止并问用户", () => {
  const p = bossModePrompt({ enabled: true, defaultAgent: "pi", agents: [] });
  assert.match(p, /先用 asd_candidates 确认它真的在/, "发之前必须先确认存在");
  assert.match(p, /停下来问用户/, "找不到时必须中止并问用户，不能自己往下走");
  assert.match(p, /绝不要自己改派/, "不许改派给别的 session");
  assert.match(p, /绝不要拿这个名字新建/, "不许拿这个名字新建");
});

test("第二档挑候选的依据里必须有 session 名字 —— 它最能说明用途", () => {
  const p = bossModePrompt({ enabled: true, defaultAgent: "pi", agents: [] });
  // asd_candidates 每行开头就是 session 名（见 tools.ts 的 candidates()），
  // 判断依据里漏掉它，等于让 boss 忽略信号最强的那一项。
  assert.match(p, /名字（session）/);
  for (const key of ["cwd", "docs", "title"]) {
    assert.match(p, new RegExp(`（${key}）`), `判断依据里应当有 ${key}`);
  }
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

/**
 * 用户实测：boss 看到 asd_agents 里的「安静」就判断不了成败，于是**反复重发任务**。
 * 光让工具输出变准还不够 —— 提示词里必须直说"别据此重发"，并指出真凭据在哪。
 *
 * asd_agents 摘掉之后这条**更要守**：清单还在（提示词自己带的），能造成同一个误判
 * 的那个空隙也还在 —— 它同样只说"派了什么"，不说"干成了没有"。
 */
test("提示词明说清单判断不了成败、不许据此重发任务", () => {
  const p = bossModePrompt({
    enabled: true,
    defaultAgent: "pi",
    agents: [{ session: "pi-a", task: "t", agent: "pi", watching: true }],
  });
  assert.match(p, /派了什么.*不是.*干成了没有/s, "要把这份清单的能力边界说清");
  assert.match(p, /绝不要因为一个 agent 半天没动静就断定它失败/, "点名这个具体误判");
  assert.match(p, /重发/, "要提到重发这个具体后果");
  assert.match(p, /asd_peek/, "要指出真凭据在哪");
});

test("提示词说明「卡在对话框」不是失败、重发无用", () => {
  const p = bossModePrompt({
    enabled: true,
    defaultAgent: "pi",
    agents: [{ session: "pi-a", task: "t", agent: "pi", watching: true }],
  });
  assert.match(p, /卡在对话框/);
  assert.match(p, /asd_nav/);
  assert.match(p, /不是失败/);
});
