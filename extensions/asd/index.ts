/**
 * pi-asd —— 把任务派给跑在独立 asd session 里的子 agent。
 *
 * 这是唯一接触 pi 的文件：把 pi.exec 适配成注入的 exec、pi.sendMessage 适配成
 * 注入的 notify，再把 tools.ts 的七个函数包成 pi 工具。逻辑全在别处，这里只接线。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAsd, type Exec } from "./cli.ts";
import { bossModePrompt } from "./prompt.ts";
import { Registry } from "./registry.ts";
import { createTools, PRESETS, type ToolResult } from "./tools.ts";
import { WatcherPool } from "./watcher.ts";

const DEFAULT_PREFIX = "pi-";
const DEFAULT_AGENT = "pi";
const DEFAULT_FOLLOW_TIMEOUT = "30m";

function toolResult(r: ToolResult) {
  return {
    content: [{ type: "text" as const, text: r.text }],
    details: r.details ?? {},
    ...(r.isError === true ? { isError: true } : {}),
  };
}

export default function (pi: ExtensionAPI): void {
  // 被 spawn 出来的 pi 子 agent：只把自己挂到 boss 的会话下面，不注册任何工具
  // （否则子 agent 也会开始 spawn 孙 agent）。
  if (process.env.PI_SPAWNED) {
    const parent = process.env.PI_PARENT_SESSION;
    if (parent) {
      pi.on("session_start", async (_event, ctx) => {
        // SessionHeader（node_modules/@earendil-works/pi-coding-agent 的
        // core/session-manager.d.ts）本来就带 `parentSession?: string`
        // 字段，不需要任何类型断言。
        const header = ctx.sessionManager.getHeader();
        if (header) header.parentSession = parent;
      });
    }
    return;
  }

  const exec: Exec = (cmd, args, opts) => pi.exec(cmd, args, opts);
  const asd = createAsd(exec);
  const registry = new Registry(process.env.PI_ASD_PREFIX ?? DEFAULT_PREFIX);
  const watchers = new WatcherPool({
    asd,
    timeout: process.env.PI_ASD_FOLLOW_TIMEOUT ?? DEFAULT_FOLLOW_TIMEOUT,
    now: () => Date.now(),
    notify: (text) => {
      // pi.sendMessage 的类型签名是 void，实测（dist/core/agent-session.js
      // 的 _bindExtensionCore）也确实是同步 void：内部 sendCustomMessage()
      // 的 promise 已经在 pi 自己那层用 .catch() 接住并转成 runner.emitError，
      // 不会向外抛出未处理 rejection。所以这里不需要、也没有额外的 .catch()。
      pi.sendMessage(
        { customType: "pi-asd-agent", content: text, display: true },
        // followUp：不打断 boss 手头正在执行的工具调用，等这一轮做完再送。
        // triggerTurn：boss 已经闲坐着时也要把它唤醒。
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });

  let parentSession: string | undefined;
  const tools = createTools({
    asd,
    registry,
    watchers,
    now: () => Date.now(),
    config: {
      defaultAgent: process.env.PI_ASD_AGENT ?? DEFAULT_AGENT,
      defaultCwd: process.cwd(),
      followTimeout: process.env.PI_ASD_FOLLOW_TIMEOUT ?? DEFAULT_FOLLOW_TIMEOUT,
      get parentSession() {
        return parentSession;
      },
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt:
      event.systemPrompt +
      bossModePrompt({
        bossSession: process.env.ASD_SESSION,
        agents: registry.list().map((r) => ({
          session: r.session,
          task: r.task,
          agent: r.agent,
          watching: r.watching,
        })),
      }),
  }));

  // 只掐 watcher，绝不杀 session —— 子 agent 照跑，用户可以 asd attach 接管。
  pi.on("session_shutdown", async (_event, ctx) => {
    watchers.stopAll();
    const alive = registry.names();
    registry.reconcile(new Set());
    if (alive.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `pi-asd：${alive.length} 个 agent session 仍在运行（${alive.join(" / ")}）。` +
          `用 asd attach <名字> 接管，或 asd kill <名字> 结束。`,
        "info",
      );
    }
  });

  pi.registerTool({
    name: "asd_spawn",
    label: "Spawn agent",
    description: [
      "把一个自包含的任务派给子 agent，它跑在独立的 asd session 里。",
      "会先找台账里 agent 和 cwd 都对得上、且已空闲的 session 复用，找不到才新建。",
      "默认挂一个后台 watcher：agent 停下来时结果会自动推给你，不需要轮询。",
    ].join("\n"),
    parameters: Type.Object({
      task: Type.String({ description: "给 agent 的任务描述，必须自包含" }),
      name: Type.Optional(Type.String({ description: "session 名（会自动加前缀并避重）" })),
      cwd: Type.Optional(Type.String({ description: "工作目录，默认当前目录" })),
      agent: Type.Optional(
        StringEnum(Object.keys(PRESETS) as [string, ...string[]], { description: "用哪个 agent" }),
      ),
      watch: Type.Optional(Type.Boolean({ description: "是否挂后台 watcher，默认 true" })),
      reuse: Type.Optional(Type.Boolean({ description: "是否复用空闲 agent，默认 true" })),
      session: Type.Optional(
        Type.String({
          description:
            "指名把任务交给这个已存在的空闲 session（可以不是本扩展建的）。先用 asd_candidates 看过再给。",
        }),
      ),
    }),
    async execute(_id, params) {
      return toolResult(await tools.spawn(params));
    },
  });

  pi.registerTool({
    name: "asd_agents",
    label: "List agents",
    description: "列出本次 spawn 出来的 agent 和它们的实时状态（running / idle）。",
    parameters: Type.Object({}),
    async execute() {
      return toolResult(await tools.agents());
    },
  });

  pi.registerTool({
    name: "asd_candidates",
    label: "List candidate sessions",
    description: [
      "列出所有当前空闲、且能接活的 session —— 包括不是本扩展建的。",
      "每条给出工作目录、项目文档、正在做什么、闲了多久。",
      '挑好之后用 asd_spawn(task, session: "<名字>") 指名交给它。',
    ].join("\n"),
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "只看工作目录精确等于它的" })),
    }),
    async execute(_id, params) {
      return toolResult(await tools.candidates(params));
    },
  });

  pi.registerTool({
    name: "asd_peek",
    label: "Peek agent",
    description: "读一个 agent 当前的屏幕，不阻塞。",
    parameters: Type.Object({
      session: Type.String({ description: "session 名" }),
      scrollback: Type.Optional(Type.Number({ description: "额外带上屏幕以上多少行历史" })),
    }),
    async execute(_id, params) {
      return toolResult(await tools.peek(params));
    },
  });

  pi.registerTool({
    name: "asd_follow",
    label: "Follow agent",
    description: [
      "阻塞到 agent 停下来，返回期间的输出和最后一屏。",
      "watcher 已经在替你等了，一般不需要主动调 —— 只在要盯死某一个时用。",
    ].join("\n"),
    parameters: Type.Object({
      session: Type.String({ description: "session 名" }),
      mode: Type.Optional(
        StringEnum(["settle", "end"] as const, {
          description: "settle：静默即返回（默认）；end：等到 session 真正结束",
        }),
      ),
      timeout: Type.Optional(Type.String({ description: "时长串，例如 5m；默认 30m" })),
    }),
    async execute(_id, params) {
      return toolResult(await tools.follow(params));
    },
  });

  pi.registerTool({
    name: "asd_steer",
    label: "Steer agent",
    description: "往一个 agent 的会话里打一条消息并回车，然后重新挂上 watcher。",
    parameters: Type.Object({
      session: Type.String({ description: "session 名" }),
      message: Type.String({ description: "要送进去的消息" }),
    }),
    async execute(_id, params) {
      return toolResult(await tools.steer(params));
    },
  });

  pi.registerTool({
    name: "asd_kill",
    label: "Kill agent",
    description: [
      "结束一个 agent 的 session。",
      "只能 kill 本扩展自己新建的 session —— 用户手建的 session 一律拒绝。",
    ].join("\n"),
    parameters: Type.Object({
      session: Type.String({ description: "session 名" }),
    }),
    async execute(_id, params) {
      return toolResult(await tools.kill(params));
    },
  });
}
