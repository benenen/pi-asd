/**
 * boss mode 的系统提示词。
 *
 * 分两段：定义段恒在；清单段只在有活跃 agent 时出现，并且负责把"别轮询"这条
 * 讲清楚 —— watcher 已经替模型在等了，它再 sleep 就是纯浪费。
 */

export interface PromptAgent {
  session: string;
  task: string;
  agent: string;
  watching: boolean;
}

export interface PromptInput {
  /**
   * boss mode 开关。**默认关闭**，由 `/asd:boss-start` 打开。
   *
   * 关闭时整个函数返回空串 —— 系统提示词一个字都不加。这个判断放在这里而不是
   * `index.ts`，是因为 `index.ts` 是唯一 import pi 的文件、没有单测夹具。
   */
  enabled: boolean;
  /** 这一轮 `asd_spawn` 不显式传 `agent` 时用哪个（由 `/asd:boss-start <agent>` 定）。 */
  defaultAgent: string;
  agents: PromptAgent[];
  /** boss 自己所在的 asd session（`ASD_SESSION`），可能没有。 */
  bossSession?: string;
}

const TASK_PREVIEW_MAX = 80;

function preview(task: string): string {
  const line = task.replace(/\s+/g, " ").trim();
  return line.length <= TASK_PREVIEW_MAX ? line : `${line.slice(0, TASK_PREVIEW_MAX)}…`;
}

export function bossModePrompt(input: PromptInput): string {
  if (!input.enabled) return "";

  const sections: string[] = [];

  const definition = [
    "",
    "",
    "## Boss Mode",
    "",
    "你现在处于 boss mode。你的职责是**分派任务，不是自己干**：",
    "",
    "1. 收到用户请求后，把它细化成一段带足上下文的任务描述。",
    "2. 调 asd_candidates 看看有没有对口的空闲 session —— 根据每条记录的",
    "   目录（cwd）、项目文档（docs）、当前在做的事（title）来判断谁最合适。",
    `3. 找到对口的就 asd_spawn(task, session: "<名字>") 指名交过去；`,
    "   没找到就新建一个带对应目录的。",
    "4. 交给子 agent 后就等着，watcher 会自动把结果推回来。",
    "",
    "**绝不要自己动手 —— 不读文件、不跑命令、不做调研。** 那些都是子 agent 的活。",
    "你的价值在于把用户意图翻译成子 agent 能独立消化的任务，而不是替它干。",
    "",
    `这一轮 spawn 默认用 ${input.defaultAgent}；要换就在 asd_spawn 里显式传 agent。`,
    "收养来的 session 不是 pi-asd 建的，asd_kill 不会结束它。这是有意的，别绕。",
  ];
  if (input.bossSession !== undefined) {
    definition.push("", `你自己跑在 asd session "${input.bossSession}" 里，不要对它做任何操作。`);
  }
  sections.push(definition.join("\n"));

  if (input.agents.length > 0) {
    const lines = input.agents.map(
      (a) =>
        `- ${a.session}（${a.agent}，${a.watching ? "watcher 已挂" : "watcher 未挂"}）：${preview(a.task)}`,
    );
    sections.push(
      [
        "",
        "",
        "## 当前 agent",
        "",
        ...lines,
        "",
        "怎么盯它们：",
        "",
        "- **默认什么都不用做。** watcher 已经挂上了，agent 一停下来结果会自动推给你。",
        "  在那之前你可以去干别的、或者回复用户。",
        "- 想主动看一眼状态就调 asd_agents —— running / idle 都是现成的，不用逐个 peek。",
        "- 要盯死某一个就调 asd_follow，它会阻塞到那个 agent 停下来。",
        "- **绝对不要用 bash sleep 轮询。** 那是 tmux 时代的做法，在这里纯属浪费。",
      ].join("\n"),
    );
  }

  return sections.join("");
}
