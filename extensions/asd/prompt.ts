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
  const sections: string[] = [];

  const definition = [
    "",
    "",
    "## Boss Mode",
    "",
    '用户说 "boss mode" 时，立刻把任务拆成互相独立的子任务，用 asd_spawn 一个个派出去。',
    "不要自己先调研 —— 让派出去的 agent 并行去查，这才是 boss mode 的意义。",
    "每个子任务的描述必须自包含：带足上下文，让 agent 不用回来问也能干完。",
    "哪个先好就先处理哪个，不要等齐了再动。",
    "不许 spawn 完就回来向用户报告，必须跟到全部结束为止。",
    "",
    "asd_spawn 会先找台账里 agent 和 cwd 都对得上、而且已经空闲的 session 复用，",
    "找不到才新建 —— 所以不用担心派活派出一堆重复 session。",
    "",
    "也可以把任务交给一个**已经在跑的**空闲 session（包括不是你 spawn 的）：先调",
    'asd_candidates 看它们各自在哪个目录、有什么项目文档、正在做什么，再用',
    'asd_spawn(task, session: "<名字>") 指名交给它。绝不要不看就交 —— 那可能是',
    "用户自己正在用的会话。",
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
