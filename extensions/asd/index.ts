/**
 * pi-asd —— 把任务派给跑在独立 asd session 里的子 agent。
 *
 * 这是唯一接触 pi 的文件：把 pi.exec 适配成注入的 exec、pi.sendMessage 适配成
 * 注入的 notify，再把 tools.ts 的公开能力包成 pi 工具。逻辑全在别处，这里只接线。
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAsd, type Exec } from "./cli.ts";
import { bossModePrompt } from "./prompt.ts";
import { Registry } from "./registry.ts";
import { loadConfigSafely, readConfigFile, resolveWorkspaceBase } from "./config.ts";
import { parseDuration, Reaper } from "./reaper.ts";
import {
  bossStartMessage,
  createTools,
  parseBossDefault,
  PRESETS,
  NAV_KEY_NAMES,
  resolveAgentArg,
  withAlias,
  type AgentPreset,
  type ToolResult,
} from "./tools.ts";
import { WatcherPool } from "./watcher.ts";

const DEFAULT_PREFIX = "pi-";
const DEFAULT_AGENT = "pi";
const DEFAULT_FOLLOW_TIMEOUT = "30m";
/** agent 空闲这么久之后自动回收。`PI_ASD_IDLE_KILL=off` 可以关掉。 */
const DEFAULT_IDLE_KILL = "2m";

/**
 * 默认从 pi 自己的环境里透传给子 agent 的变量名。
 *
 * 子 agent 是 asd **daemon** fork 出来的，继承的是 daemon 的环境 —— 那个 daemon
 * 可能是几天前从另一个 shell 起来的，跟 pi 的环境毫无关系。所以子 agent 需要的
 * 变量必须点名带过去。
 *
 * 这一组是踩出来的：本机以 root 运行时，`claude --dangerously-skip-permissions`
 * 在没有 `IS_SANDBOX=1` 的情况下会直接拒绝启动（"cannot be used with root/sudo
 * privileges"）并**立即退出** —— 表现就是 spawn 出来的 session 一秒就消失；
 * 而缺代理变量则是起得来但 API 403。用户交互 shell 里这些都有（`clp` 之类的
 * 别名设的），daemon 里没有。
 *
 * 只透传**当前进程里确实有值**的那些，不会凭空造变量。用 asd.json 的
 * `envPassthrough` 换掉这张表，或用 `spawnEnv` 直接指定值。
 */
const DEFAULT_ENV_PASSTHROUGH = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "IS_SANDBOX",
  "DISABLE_AUTOUPDATER",
];

/** 按名单从 env 里挑出有值的变量。 */
function pickEnv(names: string[], env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = env[n];
    if (typeof v === "string" && v.length > 0) out[n] = v;
  }
  return out;
}

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
  const agentDir = getAgentDir();

  // 静态配置只从 agent 目录读（cwd 随 session 变，workspaceBase/prefix/followTimeout 不应跟着变）。
  // 用 loadConfigSafely：配置坏了不能掀掉整个扩展的加载，问题攒着等有 UI 了再报。
  const startup = loadConfigSafely({
    files: [readConfigFile(path.join(agentDir, "asd.json"))],
    env: process.env,
    cwd: process.cwd(),
    agentDir,
  });
  const staticConfig = startup.config;

  const prefix = process.env.PI_ASD_PREFIX ?? staticConfig.prefix ?? DEFAULT_PREFIX;
  const followTimeout = process.env.PI_ASD_FOLLOW_TIMEOUT ?? staticConfig.followTimeout ?? DEFAULT_FOLLOW_TIMEOUT;
  const workspaceBase = resolveWorkspaceBase(
    process.env.PI_ASD_WORKSPACE ?? staticConfig.workspaceBase,
    path.join(agentDir, "asd-workspaces"),
  );

  // 透传给子 agent 的环境：先按名单从自己的 process.env 里挑，再让配置里显式给的
  // spawnEnv 覆盖同名项。
  const spawnEnv = {
    ...pickEnv(staticConfig.envPassthrough ?? DEFAULT_ENV_PASSTHROUGH, process.env),
    ...(staticConfig.spawnEnv ?? {}),
  };

  // agent → 本机别名/包装命令。配了的用别名启动，没配的保持预设原样。
  // 认不出的 agent 名不静默忽略 —— 配错了字最容易表现成"配置没生效"。
  const presets: Record<string, AgentPreset> = { ...PRESETS };
  for (const [name, alias] of Object.entries(staticConfig.aliases ?? {})) {
    const base = PRESETS[name];
    if (base === undefined) {
      startup.problems.push(`aliases.${name}：不认识的 agent，可选：${Object.keys(PRESETS).join(" / ")}`);
      continue;
    }
    presets[name] = withAlias(base, alias);
  }

  const registry = new Registry(prefix);

  // pi.sendMessage 的类型签名是 void，实测（dist/core/agent-session.js 的
  // _bindExtensionCore）也确实是同步 void：内部 sendCustomMessage() 的 promise
  // 已经在 pi 自己那层用 .catch() 接住并转成 runner.emitError，不会向外抛出未
  // 处理 rejection。所以这里不需要、也没有额外的 .catch()。
  const notify = (text: string): void => {
    pi.sendMessage(
      { customType: "pi-asd-agent", content: text, display: true },
      // followUp：不打断 boss 手头正在执行的工具调用，等这一轮做完再送。
      // triggerTurn：boss 已经闲坐着时也要把它唤醒。
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const watchers = new WatcherPool({
    asd,
    timeout: followTimeout,
    now: () => Date.now(),
    notify,
    // asd_follow 能给台账外 session 挂只读 watcher，但 asd_nav 会发送按键，
    // 仍只允许台账内目标。对话框通知必须按这道边界给出可执行的下一步。
    canNavigate: (session) => registry.get(session) !== undefined,
    // session 在 asd 里真的没了 —— 台账里那条已经是幽灵记录，清掉它，
    // 免得提示词里的「当前 agent」清单和 pickReusable 还拿它当活的。
    //
    // 这里只清台账、不 kill：都没了，没什么可 kill 的。真正的"干完活之后回收"
    // 交给下面的 Reaper，它按 idle_ms 判断，不碰 settle 这个不可靠信号 ——
    // 曾经这个回调挂在 settle 上并且真的 kill，把刚 spawn 出来还在冷启动的
    // agent 杀了。见 WatcherDeps.onGone 的注释。
    onGone: (session) => {
      registry.remove(session);
    },
  });

  let parentSession: string | undefined;
  // ASD_SESSION 是 boss 自己所在的 asd session 名，进程启动时就定了，不会像
  // parentSession 那样随 session_start 变化 —— 一次性读出来注入即可。
  // `tools.ts` 不读 process.env，这是它拿到这个值的唯一路径。
  const bossSession = process.env.ASD_SESSION;

  // 延迟回收：干完活之后空闲够久的自家 agent 自动 kill 掉。判据是 asd 的
  // idle_ms（送任何输入都会让它归零），所以被 steer / 被复用之后不会再被回收，
  // 不需要额外的取消逻辑。认不出的时长值不静默忽略，攒进 startupProblems 一起报。
  const idleKill = parseDuration(
    process.env.PI_ASD_IDLE_KILL ?? staticConfig.idleKillAfter ?? DEFAULT_IDLE_KILL,
  );
  if (idleKill.problem !== undefined) startup.problems.push(`idleKillAfter：${idleKill.problem}`);
  const reaper =
    idleKill.ms === undefined
      ? undefined
      : new Reaper({
          asd,
          registry,
          idleKillMs: idleKill.ms,
          bossSession,
          notify,
        });
  reaper?.start();
  // boss mode 开关：env PI_ASD_BOSS 优先于配置文件 bossMode.autoStart
  const bossDefault = parseBossDefault(process.env.PI_ASD_BOSS);
  /**
   * boss mode 开关。默认关闭，可通过配置文件 `bossMode.autoStart` 或
   * 环境变量 `PI_ASD_BOSS=1` 让它在 session 启动时自动打开。
   * 进程内状态，不持久化（和台账一致）。
   */
  // configured 而不是 `!== undefined`：`PI_ASD_BOSS=`（.env 空行、docker -e VAR=、
  // 没展开的 shell 变量）必须当"没设置"，让配置文件的 autoStart 正常生效。
  let bossMode = bossDefault.configured ? bossDefault.enabled : staticConfig.bossMode.autoStart;

  /** 不给参数时回到的基线 agent。env PI_ASD_AGENT > 配置文件 bossMode.defaultAgent > 内置默认 */
  const baselineAgent =
    process.env.PI_ASD_AGENT ?? staticConfig.bossMode.defaultAgent ?? DEFAULT_AGENT;
  /** 这一轮用哪个 agent，由 `/asd:boss-start <agent>` 定。 */
  let bossAgent = baselineAgent;
  const tools = createTools({
    asd,
    registry,
    watchers,
    now: () => Date.now(),
    config: {
      get defaultAgent() {
        return bossAgent;
      },
      workspaceBase,
      followTimeout,
      bossSession,
      get parentSession() {
        return parentSession;
      },
      spawnEnv,
      presets,
    },
    mkdirp: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    // 生产环境用真的定时器：投递校验要等 TUI 渲染，启动等待要轮询。
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  pi.on("session_start", async (_event, ctx) => {
    parentSession = ctx.sessionManager.getSessionFile() ?? undefined;

    // 加载会话级配置：agent 目录 + 项目目录 .pi/asd.json
    const loaded = loadConfigSafely({
      files: [
        readConfigFile(path.join(agentDir, "asd.json")),
        readConfigFile(path.join(ctx.cwd, ".pi", "asd.json")),
      ],
      env: process.env,
      cwd: ctx.cwd,
      agentDir,
    });
    const sessionConfig = loaded.config;

    // 启动时那份问题也在这儿一起报 —— 它来自同一个 agent asd.json，去重后正好
    // 是"这台机器上所有坏掉的配置"。配置坏了相关设置已经退回默认，得说清楚。
    const problems = [...new Set([...startup.problems, ...loaded.problems])];
    if (problems.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `pi-asd 配置有 ${problems.length} 处问题，相关设置已退回默认：\n- ${problems.join("\n- ")}`,
        "warning",
      );
    }

    // 项目级配置声明了 bossMode.autoStart 且还没开 → 自动打开
    if (!bossMode && sessionConfig.bossMode.autoStart) {
      bossMode = true;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `boss mode 已自动开启（${ctx.cwd}/.pi/asd.json），默认 agent ${bossAgent}。`,
          "info",
        );
      }
    }

    if (bossDefault.unrecognized !== undefined && ctx.hasUI) {
      ctx.ui.notify(
        `PI_ASD_BOSS 的值 "${bossDefault.unrecognized}" 认不出来，boss mode 保持关闭。` +
          `可用值：1 / true / on / yes（开），0 / false / off / no（关）。`,
        "warning",
      );
    }
  });

  pi.on("before_agent_start", async (event) => {
    // 一轮 agent 执行里只允许 asd_list 真查一次。工具结果不会重新触发
    // before_agent_start，所以同一轮内连续调用不会误充值；新的用户消息、飞书消息
    // 或 watcher followUp 开启下一轮时才重新放行。
    tools.resetListAllowance();
    return {
      systemPrompt:
        event.systemPrompt +
        bossModePrompt({
          enabled: bossMode,
          defaultAgent: bossAgent,
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
    };
  });

  // 只掐 watcher，绝不杀 session —— 子 agent 照跑，用户可以 asd attach 接管。
  pi.on("session_shutdown", async (_event, ctx) => {
    watchers.stopAll();
    // 退出时停掉回收器。**不在这里补扫一轮** —— 退出时不杀任何 session 是
    // README「生命周期」明写的契约：子 agent 照跑，用户可以 asd attach 接管。
    reaper?.stop();
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
        // 这些不是自己创建的，是用户的 session —— 不建议 kill，pi-asd 自己的
        // asd_kill 也永远会拒绝它们（createdByUs !== true）。
        parts.push(
          `${adopted.map((r) => r.session).join(" / ")} 不是 pi-asd 自己创建的，` +
            `是用户的会话，用 asd attach 接管就好，不建议 kill。`,
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
        StringEnum(Object.keys(presets) as [string, ...string[]], { description: "用哪个 agent" }),
      ),
      watch: Type.Optional(Type.Boolean({ description: "是否挂后台 watcher，默认 true" })),
      reuse: Type.Optional(Type.Boolean({ description: "是否复用空闲 agent，默认 true" })),
      persistent: Type.Optional(
        Type.Boolean({
          description:
            "长期员工：不被空闲回收器超时收掉（默认 false）。适合长期负责一个项目的 agent。asd_kill 仍然能结束它。",
        }),
      ),
      prefix: Type.Optional(
        Type.String({
          description:
            '覆盖 session 名前缀。传空串 "" 就不加前缀（比如想要 "nvr" 而不是 "pi-nvr"）。不给则用全局配置。',
        }),
      ),
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
    name: "asd_list",
    label: "List all sessions",
    description: [
      "列出 asd daemon 当前的全部 session，包括不是 pi-asd 创建或监视的。",
      "只返回 session 名，不读取屏幕，也不提供活动或任务成败状态。",
      "每轮 agent 执行只允许查询一次；需要等待用 asd_follow，或等 watcher 自动推送。",
    ].join("\n"),
    parameters: Type.Object({}),
    async execute() {
      return toolResult(await tools.list());
    },
  });

  // asd_agents 仍然故意**不注册** —— `tools.agents()` 的实现还在，但不暴露给 boss。
  //
  // 它只看 pi-asd 台账，曾让 boss 陷进连续调用的轮询循环。上面的 asd_list 不是把它
  // 换名接回来：asd_list 的成员集合来自 daemon 的全部 session，但只返回名字、不读取
  // 任一屏幕；只在用户明确要清单时调一次，不能拿它等待或判断任务成败。
  //
  // 「pi-asd 派了什么、watcher 挂没挂」仍由每轮系统提示词里的「当前 agent」清单
  // 回答；任务结果仍然只能看 asd_peek / asd_follow。不要再注册 asd_agents。

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
    description:
      "读显式点名的任意现存 asd session 当前屏幕，不阻塞；不要求它由 pi-asd 创建或监视。",
    parameters: Type.Object({
      session: Type.String({ description: "任意现存 asd session 名" }),
      scrollback: Type.Optional(Type.Number({ description: "额外带上屏幕以上多少行历史" })),
    }),
    async execute(_id, params) {
      return toolResult(await tools.peek(params));
    },
  });

  pi.registerTool({
    name: "asd_follow",
    label: "Watch agent",
    description: [
      "给显式点名的任意现存 asd session 挂后台 watcher，然后立即返回。",
      "session 停下来后，watcher 会自动把最终屏幕推送回来；不要阻塞当前轮次，也不要轮询。",
      "不要求它由 pi-asd 创建或已在台账里；外部 session 不会因此进入复用或回收台账。",
    ].join("\n"),
    parameters: Type.Object({
      session: Type.String({ description: "任意现存 asd session 名" }),
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
    name: "asd_nav",
    label: "Send keys to agent",
    description: [
      "往一个 agent 的会话里按键，用来操作它弹出的对话框（选择框、确认框之类）。",
      "对话框是模态的，会把输入框顶掉 —— 那时 asd_steer 会投递失败并拒绝按回车，",
      "因为那一下回车会去确认对话框当前选中的项。要操作对话框就用这个工具。",
      "**先用 asd_peek 看清楚当前是什么界面、选中的是哪一项，再按。**",
      "这个工具不做投递校验（按键本就不是往输入框送的），但会把按完之后的屏幕一并返回。",
    ].join("\n"),
    parameters: Type.Object({
      session: Type.String({ description: "session 名" }),
      keys: Type.Array(
        StringEnum(NAV_KEY_NAMES as [string, ...string[]]),
        {
          description:
            '按顺序送出的按键，例如 ["ArrowDown", "Enter"]。C-a..C-z 表示 Ctrl 组合键（C-c 会中断 agent）。',
        },
      ),
    }),
    async execute(_id, params) {
      return toolResult(await tools.nav(params));
    },
  });

  pi.registerTool({
    name: "asd_rename",
    label: "Rename agent session",
    description: [
      "给一个 session 改名。**进程和屏幕都不动** —— 比杀掉重建强的地方就在这。",
      "典型用途：spawn 时自动加了前缀，想要 nvr 结果成了 pi-nvr。",
      "（新建时直接传 prefix: \"\" 更省事，这个是给已经建出来的补救。）",
      "改完 pi-asd 的监视列表和 watcher 会一起跟过去。",
    ].join("\n"),
    parameters: Type.Object({
      session: Type.String({ description: "当前 session 名" }),
      newName: Type.String({ description: "新名字，[A-Za-z0-9_-]{1,64}" }),
    }),
    async execute(_id, params) {
      return toolResult(await tools.rename(params));
    },
  });

  pi.registerTool({
    name: "asd_unmonitor",
    label: "Stop monitoring agent",
    description: [
      "不再监视某个 session —— 用户说「不监视 xxx 了」就用这个。",
      "**只是不管它了，不结束它**：进程照常跑，只是不再出现在监视列表里、",
      "不再挂 watcher、空闲回收器也不动它。",
      "之后还能用 asd_spawn(task, session: \"…\") 再次指名交给它，那会重新纳入监视。",
      "要结束进程用 asd_kill；只是不想被自动回收用 asd_spawn 的 persistent 参数。",
    ].join("\n"),
    parameters: Type.Object({
      session: Type.String({ description: "session 名" }),
    }),
    async execute(_id, params) {
      return toolResult(await tools.unmonitor(params));
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
    description: "打开 boss mode（可带 agent 名：pi / claude / codex）",
    getArgumentCompletions: (prefix: string) => {
      const items = Object.keys(presets)
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({ value: n, label: n }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const resolved = resolveAgentArg(args ?? "", baselineAgent, presets);
      if (!resolved.ok) {
        // 参数不对就什么都不改 —— 半开状态比不开更糟。
        ctx.ui.notify(resolved.message, "error");
        return;
      }
      const was = bossMode;
      const from = bossAgent;
      bossAgent = resolved.agent;
      bossMode = true;
      ctx.ui.notify(bossStartMessage({ wasOn: was, from, to: bossAgent }), "info");
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
