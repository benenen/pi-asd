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
    // 这个 isError 是惰性的，而且是故意的：pi 核心不读自定义工具返回对象里
    // 的 isError（`ToolResultMessage.isError` 只由 execute() 是否抛异常
    // 决定，见 dist 里的 agent-session 那一层），它顶多影响调用方自己怎么
    // 读 details。**不要**把这里改成 `throw`——kill 守卫的两条拒绝路径
    // （台账外的名字、`createdByUs !== true`）都是"正常的业务分支"，改成异常
    // 会把它们变成错误路径，还会让上面几个 tools.* 调用点全部要包 try/catch。
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
  // ASD_SESSION 是 boss 自己所在的 asd session 名，进程启动时就定了，不会像
  // parentSession 那样随 session_start 变化 —— 一次性读出来注入即可。
  // `tools.ts` 不读 process.env，这是它拿到这个值的唯一路径。
  const bossSession = process.env.ASD_SESSION;
  /**
   * boss mode 开关，默认关闭 —— 只有 `/asd:boss-start` 才打开。
   * 进程内状态，不持久化（和台账一致），重启后回到关闭。
   */
  let bossMode = false;
  const tools = createTools({
    asd,
    registry,
    watchers,
    now: () => Date.now(),
    config: {
      defaultAgent: process.env.PI_ASD_AGENT ?? DEFAULT_AGENT,
      defaultCwd: process.cwd(),
      followTimeout: process.env.PI_ASD_FOLLOW_TIMEOUT ?? DEFAULT_FOLLOW_TIMEOUT,
      bossSession,
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
        enabled: bossMode,
        bossSession,
        agents: registry.list().map((r) => ({
          session: r.session,
          task: r.task,
          agent: r.agent,
          // 台账不记 watching —— WatcherPool 才是唯一真相（同一条理由见
          // tools.ts 的 agents()）。提示词里"watcher 已挂/未挂"这句必须跟着
          // 真实状态走，不然 watcher 超时收尾之后提示词还在说"已挂"，boss
          // 会照着这句假话继续什么都不做。
          watching: watchers.isWatching(r.session),
        })),
      }),
  }));

  // 只掐 watcher，绝不杀 session —— 子 agent 照跑，用户可以 asd attach 接管。
  pi.on("session_shutdown", async (_event, ctx) => {
    watchers.stopAll();
    // 台账是内存快照，可能已经跟 asd 的实际状态脱节（agent 早退出了、或者
    // 反过来台账里的记录其实还活着）—— 退出前跟 `asd list` 对账一遍，只报告
    // 真正还存活的，不能拍脑袋说台账里每一条都"仍在运行"。
    let remaining = registry.list();
    try {
      const live = await asd.list();
      registry.reconcile(new Set(live.map((s) => s.session)));
      remaining = registry.list();
    } catch {
      // asd 都联系不上了，没什么好对账的 —— 清空台账，不再对用户做任何
      // "还在运行"这类无法验证的断言。
      registry.reconcile(new Set());
      remaining = [];
    }
    if (remaining.length > 0 && ctx.hasUI) {
      const ours = remaining.filter((r) => r.createdByUs);
      const adopted = remaining.filter((r) => !r.createdByUs);
      const names = remaining.map((r) => r.session).join(" / ");
      const parts = [`pi-asd：${remaining.length} 个 agent session 仍在运行（${names}）。`];
      if (ours.length > 0) {
        parts.push(
          `用 asd attach <名字> 接管，或 asd kill <名字> 结束（限：${ours
            .map((r) => r.session)
            .join(" / ")}）。`,
        );
      }
      if (adopted.length > 0) {
        // 收养来的是用户自己的 session —— 不建议 kill，pi-asd 自己的
        // asd_kill 也永远会拒绝它们（createdByUs !== true）。
        parts.push(
          `${adopted.map((r) => r.session).join(" / ")} 是收养来的用户会话，` +
            `用 asd attach 接管就好，不建议 kill。`,
        );
      }
      ctx.ui.notify(parts.join(""), "info");
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

  pi.registerCommand("asd:boss-start", {
    description: "打开 boss mode：把任务拆开派给跑在独立 asd session 里的子 agent",
    handler: async (_args, ctx) => {
      if (bossMode) {
        ctx.ui.notify("boss mode 已经是开着的。", "info");
        return;
      }
      bossMode = true;
      ctx.ui.notify("boss mode 已打开。下一轮起会注入拆任务和监控的提示词。", "info");
    },
  });

  pi.registerCommand("asd:boss-stop", {
    description: "关闭 boss mode：不再注入提示词（已派出去的 agent 不受影响）",
    handler: async (_args, ctx) => {
      if (!bossMode) {
        ctx.ui.notify("boss mode 本来就是关着的。", "info");
        return;
      }
      bossMode = false;
      const alive = registry.names().length;
      ctx.ui.notify(
        alive > 0
          ? `boss mode 已关闭。${alive} 个 agent 仍在跑，它们停下时结果照样会推给你；要结束用 asd_kill。`
          : "boss mode 已关闭。",
        "info",
      );
    },
  });
}
