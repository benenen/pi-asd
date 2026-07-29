# pi-asd 设计

2026-07-29

## 目标

把 [pi-boss](https://github.com/skyfallsin/pi-boss) 的 "boss mode" 搬到
[asd](https://github.com/benenen/asd) 上：pi 主 agent 把任务拆成若干独立子任务，
每个子任务 spawn 一个 agent 进独立的 asd session，主 agent 监控、引导、收尾。

pi-boss 靠 tmux 分屏 + 依赖 pi-room 提供 peek/steer。pi-asd 只依赖 `asd` 一个
外部命令——`send` / `peek` / `follow` / `wait` / `list --json` asd 原生就有。

## 与 pi-boss 的关键差异

| | pi-boss (tmux) | pi-asd (asd) |
|---|---|---|
| 承载 | tmux pane，跟着窗口走 | asd session，daemon 持有 PTY，独立于任何客户端 |
| 布局 | split-window + tiled + pane 高亮 | 无分屏概念；`asd ui` 侧边栏一行一个 session |
| peek/steer | 依赖 pi-room | asd 原生 `peek` / `send` |
| 完成信号 | `bash sleep 15` 轮询 | `asd follow` 阻塞到 agent 停下（daemon 静默信号） |
| 主 agent 是否被卡住 | 是，循环占满它的回合 | 否，后台 watcher 子进程等，`sendMessage` 推结果 |
| 退出时 | 无条件杀掉所有 pane | 不杀 session，只掐 watcher 并列出存活的 |
| 激活条件 | `TMUX_PANE` 存在，否则整个扩展不工作 | 无条件加载；daemon 按需启动 |

## 架构

```
pi-asd/
├── package.json          # pi 包：keywords ["pi-package"], pi.extensions ["./extensions"]
├── tsconfig.json
├── extensions/asd/
│   ├── index.ts          # 唯一接触 pi 的文件：把 tools.ts 包成 pi 工具 + 挂事件
│   ├── tools.ts          # 六个工具的实际逻辑，纯依赖注入，不 import pi
│   ├── cli.ts            # asd 命令行封装：参数拼装、--json 解析、退出码分流
│   ├── registry.ts       # 本次 boss spawn 出来的台账 + 命名 + 复用挑选 + kill 守卫
│   ├── watcher.ts        # 后台 follow 子进程的生命周期 + 结束回调
│   └── prompt.ts         # boss mode 系统提示词拼装
├── test/                 # node:test
│   ├── cli.test.ts
│   ├── registry.test.ts
│   ├── watcher.test.ts
│   ├── prompt.test.ts
│   ├── tools.test.ts
│   └── e2e.test.ts
└── README.md / LICENSE
```

### 依赖边界

`cli.ts`、`registry.ts`、`watcher.ts`、`prompt.ts`、`tools.ts` **都不 import pi**。
`index.ts` 只做接线：把 `pi.exec` 适配成注入的 `exec`、把 `pi.sendMessage` 适配成
注入的 `notify`、把 `tools.ts` 的六个函数包成 `pi.registerTool` 调用。工具逻辑
本身（尤其 kill 守卫）因此能在 `tools.test.ts` 里用假 `exec` 直接测。

- `cli.ts` 接收一个注入的 `exec(cmd: string, args: string[], opts?) => Promise<{ stdout, stderr, exitCode }>`。
- `watcher.ts` 接收同一个 `exec` 再加一个 `notify(text: string) => void` 回调。
- `registry.ts` 是纯内存 `Map` + 纯函数（命名、洗名、对账）。
- `prompt.ts` 是纯字符串拼装。

`index.ts` 负责把 `pi.exec` 和 `pi.sendMessage` 接上去。这条边界的用处是：所有
命令拼装、JSON 解析、退出码语义、watcher 状态机都能用假 `exec` 在 `node:test`
里测，不需要真起 asd daemon。

### 依赖的 asd 命令与契约

| 命令 | 用途 | 契约 |
|---|---|---|
| `asd new <name> --cwd <d> --cmd <s>` | 建 session | stdout 是最终 session 名；`--cmd` 走 `sh -c`；daemon 不在会自动拉起 |
| `asd list --json` | 状态对账 | 数组，元素含 `session` / `status` / `running` / `idle_ms` / `title` / `command` / `pid` / `cols` / `rows` |
| `asd card list --json` | 挑选候选 | 数组，元素含 `session` / `status` / `cwd` / `docs[]`。`cwd` 是从 session 自己的进程读的工作目录；`docs` 是该目录下的项目文档（README/CLAUDE/AGENTS/CONTRIBUTING）。**仅本地 daemon 可用。** |
| `asd peek <name> [--scrollback N]` | 读一屏 | stdout 是渲染后的屏幕文本 |
| `asd send <name> --text <t> --enter` | 打字 | `--text` 原样送出，不做转义、不隐式换行 |
| `asd follow <name> [--forever] [--timeout D]` | 阻塞到停下 | 退出码 0=静默/结束，3=无此 session，4=超时 |
| `asd kill <name>` | 结束 session | SIGHUP，2 秒后 SIGKILL |

session 名合法字符集：`[A-Za-z0-9_-]{1,64}`（asd 的硬约束）。

## 工具面

六个工具，全部带 `asd_` 前缀——pi-room 的工具就叫 `peek` / `steer`，pi-boss 的叫
`spawn`，带前缀是为了和它们共存时不撞名。

### `asd_spawn(task, session?, name?, cwd?, agent?, watch?, reuse?)`

派一个任务给 agent。三条路，按优先级：**指名收养 → 台账内自动复用 → 新建**。

#### 1. 指名收养（`session` 给了时）

把任务交给一个**已经存在的** session，不管它是不是 pi-asd 建的。这条路只在
boss 明确点名时走，**永远不会自动发生** —— 往用户自己正在用的会话里塞任务是有
后果的动作，必须是模型看过 `asd_candidates` 的输出之后作出的选择。

收养前逐条校验，任何一条不过就返回 `isError` 且**不发送任何东西**：

- session 在 `asd list` 里存在；
- `running === false`（它闲着）；
- `asd list --json` 的 `command` 字段能匹配上某个已知 agent 预设（`pi` /
  `claude` / `codex`）。**这一条是硬拦截**：`command` 是 pty 的前台进程，如果那
  是个裸 shell（`bash` / `zsh`），把任务描述 `send` 进去会被当命令执行。宁可拒绝。

通过后 `asd send <名> --text <task> --enter`，并以 **`createdByUs: false`** 记进
台账，照常挂 watcher。返回里必须写明"收养了一个不是 pi-asd 建的 session，它不会
被 `asd_kill` 结束"。

#### 2. 台账内自动复用（`session` 没给、`reuse !== false`）

候选只在台账内找：`agent` 相同、`cwd` 相同、session 仍在 `asd list` 里且
`running === false`。给了 `name` → 只认叫 `<prefix><洗过的 name>` 的那一个；
没给 → 取 `idle_ms` 最大的（闲最久的）。命中就 `asd send` 打进去、重挂 watcher，
返回标明"复用"。

**自动复用不碰台账外的 session。** 自动挑中用户的工作会话是不能接受的默认行为，
外部 session 只能走上面的指名收养。

#### 3. 新建（前两条都没命中）

- **命名**：`<prefix><name>`，`prefix` 默认 `pi-`（env `PI_ASD_PREFIX` 可改）。
  给了 `name` 就是 `pi-auth-fix`；没给就按台账序号 `pi-agent1` / `pi-agent2`。
  名字先洗一遍（非 `[A-Za-z0-9_-]` 的字符换成 `-`，压缩连续 `-`，截断到 64），
  再和 `asd list` 对一遍，撞上就追加 `-2` / `-3`，直到不撞。
- **命令**：`asd new <名> --cwd <cwd> --cmd "<env 前缀> <agent 命令>"`。
  `cwd` 默认 `process.cwd()`。
- **agent 预设表**（`agent` 参数选，env `PI_ASD_AGENT` 改默认，默认 `pi`）：

  | key | 命令 |
  |---|---|
  | `pi` | `pi <task>` |
  | `claude` | `claude --dangerously-skip-permissions <task>` |
  | `codex` | `codex <task>` |

  `task` 用单引号包裹 + `'\''` 转义（和 pi-boss 同款六行 `shellEscape`，不引依赖）。
- **env 注入**：只有 `agent === "pi"` 时注入 `PI_SPAWNED=1` 和
  `PI_PARENT_SESSION=<boss 的 session 文件>`，让子 agent 在 pi 的会话选择器里挂到
  boss 下面。claude / codex 拿不到这个，属于预期内的能力差异。
- **`watch`**（默认 `true`）：spawn 成功后立刻在后台起一个 follow watcher，见下。
- **返回**：最终 session 名、实际执行的命令、cwd、watcher 是否已挂。

### `asd_agents()`

列出**本次 boss spawn 的** agent，和 `asd list --json` 对账后合并实时状态。

- 台账里有、`asd list` 里没有的 → 说明 session 已结束，从台账移除、停掉 watcher，
  在返回里标注 "已结束"。
- 每条返回：session 名、任务摘要（截断 80 字）、`running`/`idle`、`idle_ms`、
  session 标题、watcher 是否在跑。
- 台账为空时明确返回 "没有 spawn 出来的 agent"。

**只列台账里的。** 台账外的 session 要看得用 `asd_candidates`。

### `asd_candidates(cwd?)`

列出**所有当前空闲、且看起来能接活**的 session，供 boss 挑一个交给
`asd_spawn(task, session: "<名字>")`。这是"指名收养"那条路的入口，也是它唯一
正当的信息来源 —— 让模型在看清一个 session 在哪、在做什么之后再决定要不要占用它。

数据来自两条命令的合并（按 `session` 名 join）：

- `asd card list --json` → `cwd`、`docs[]`
- `asd list --json` → `running`、`idle_ms`、`title`、`command`

过滤与排序：

- 只留 `running === false` 的；
- 只留 `command` 能匹配上已知 agent 预设的（裸 shell 不是候选，理由见
  `asd_spawn` 的收养校验）；
- 给了 `cwd` 就只留工作目录精确等于它的；
- 按 `idle_ms` 从大到小排（闲最久的排前面）。

每条返回：session 名、`cwd`、`docs` 列表、`title`（它正在做什么 —— agent 会把
当前任务写进终端标题）、认出来的 agent 种类、闲了多久，以及**它是不是本 boss
台账里的**。最后一项决定了收养它之后能不能 `asd_kill`。

一条都没有时明确说明"没有空闲且能接活的 session"，不要返回空列表让模型自己猜。

### `asd_peek(session, scrollback?)`

`asd peek <名> [--scrollback N]`，纯读一屏，不阻塞。给 `scrollback` 就带上屏幕以上
的历史行。

### `asd_follow(session, mode?, timeout?)`

阻塞到 agent 停下来，返回**期间滚出屏幕的输出 + 最终那一屏**。

- `mode: "settle"`（默认）→ `asd follow <名>`，在首次静默 2 秒时返回。
  claude / pi 这类 TUI 在思考和跑工具期间持续重绘 spinner，屏幕一直在动，所以
  不会静默；只有真正停下来等输入时才安静。"静默 2 秒" 对 agent 而言就等于
  "这一轮干完了"。
- `mode: "end"` → `asd follow <名> --forever`，一直流到 session 真正结束。配
  会自行退出的无头命令用。
- `timeout` 默认 `30m`（env `PI_ASD_FOLLOW_TIMEOUT`）。

退出码分流见「错误处理」。

### `asd_steer(session, message)`

`asd send <名> --text <message> --enter`。

**成功后自动重挂 watcher**：agent 停下 → 通知 boss → boss steer 它 → 它又开始干活，
这时需要重新 follow。

### `asd_kill(session)`

`asd kill <名>`，同时停 watcher、从台账移除。

> **硬不变量：只能 kill pi-asd 自己新建的 session。**
>
> 台账每条记录带一个 `createdByUs: boolean`，只有走过 `asd new` 那条路径的才置
> `true`。`asd_kill` 在打 `asd kill` 之前必须同时满足两条：**(1)** 名字在台账里，
> **(2)** 该条记录 `createdByUs === true`。任何一条不满足就直接返回 `isError`，
> **绝不执行 `asd kill`**。
>
> **这个守卫是承重的，不是防御性冗余。** 指名收养（见 `asd_spawn`）会把用户手建的
> session 以 `createdByUs: false` 记进台账 —— 从那一刻起，台账里同时存在"能杀的"
> 和"绝不能杀的"两类记录，而 `createdByUs` 是区分它们的唯一依据。一个只检查
> "在不在台账里"的 kill 会直接杀掉用户正在用的工作会话。守卫要有独立的单测。
>
> 同理，`session_shutdown` 里本来就不杀任何 session，`asd kill --all` 在
> pi-asd 里**任何路径都不允许出现**。

## follow watcher

这是 pi-asd 相对 pi-boss 最实质的改进：**主 agent 完全不轮询、也不被阻塞**。

spawn 成功后（`watch !== false`），`watcher.ts` 起一个后台 `asd follow <名>` 子
进程——`pi.exec(...)` 拿到 promise 后**不 await**，挂 `.then()`。子进程返回时：

1. `asd peek <名>` 读最后一屏；
2. 组装通知文本；
3. `pi.sendMessage({ customType: "pi-asd-agent", content, display: true },
   { deliverAs: "followUp", triggerTurn: true })`。

`deliverAs: "followUp"` 保证不打断 boss 手头正在执行的工具调用，等这一轮做完再送；
`triggerTurn: true` 保证 boss 就算已经闲坐着也会被唤醒去处理。这条路子在 pi 官方
示例 `file-trigger.ts` 里已经用了（`fs.watch` 回调里 `pi.sendMessage({ triggerTurn: true })`），
异步回调注入消息是支持的。

相比"开一个 subagent 去 follow"：watcher 就是个阻塞的子进程，**不烧任何 LLM
token**，也不占用一份上下文。

通知文本形态：

```
[pi-asd] agent "pi-auth-fix" 已停下（历时 4m12s）。
--- 最后一屏 ---
<peek 输出>
```

session 已结束（follow 退出码 3）时：

```
[pi-asd] agent "pi-auth-fix" 的 session 已结束。
```

watcher 超时（退出码 4，默认 30 分钟）时通知 boss "watcher 超时，agent 仍在跑"，
**不自动重挂**——避免超时循环。boss 可以自己再调 `asd_follow`。

台账记 watcher 状态，同一个 session 不重复 follow。

## boss mode 提示词

`before_agent_start` 事件里往 system prompt 追加，两段。

**第一段（恒定）**——沿用 pi-boss 那几条硬约束：

- 用户说 "boss mode" 时，立刻把任务拆成独立子任务并 spawn，**不要自己先调研**，
  让 spawn 出来的 agent 并行去查。
- 每个子任务的描述必须自包含，带足上下文，能独立完成。
- 哪个先好就先处理哪个，**不要等齐**。
- 不许 spawn 完就回来向用户报告，必须跟到全部结束。

外加 asd 特有的一条：boss 自己所在的 session（`ASD_SESSION`，可能没有）会写进
提示词，让模型知道自己在哪、不要误伤。

**第二段（有活跃 agent 时才有）**——当前 agent 清单 + 监控方式：

- 默认**不要轮询**。spawn 时 watcher 已经挂上，agent 一停会自动把结果推过来，
  你可以先去干别的、或者回复用户。
- 想主动看一眼状态就调 `asd_agents()`——`running` / `idle` / `idle_ms` 都是现成的，
  不用 peek 一遍。
- 要盯死某一个就调 `asd_follow(session)` 阻塞等它。
- **绝不要用 `bash sleep` 轮询**。

## 生命周期

`session_shutdown`：

- **不杀任何 asd session。** 这是 asd 相对 tmux pane 真正多出来的能力——boss 挂了
  子 agent 照跑，可以 `asd ui` 进去接管。
- 用 AbortSignal 把所有 watcher 子进程掐掉。
- 对账一遍，把仍存活的 agent 列出来，附上接管命令 `asd attach <名>`。

台账只活在进程内存里。boss 重启后 `asd_agents()` 是空的，但 session 仍在
`asd list` 里——要持久化台账就得再引一个状态文件，YAGNI。

**加载条件**：无条件加载。pi-boss 开头是 `if (!TMUX_PANE) return;`，pi-asd 不这么做，
因为 asd daemon 按需启动，boss 在不在 asd session 里都能 `asd new`。`ASD_SESSION`
只用来在提示词里标注 boss 自己在哪，不作为开关。第一次 spawn 时 `asd` 不在 PATH
才报错。

## 错误处理

按"哪些算错、哪些只是状态"分。

**算错（`isError: true`）：**

- `asd` 不在 PATH（ENOENT）→ 提示装 asd 并给出仓库地址。
- `asd_spawn` 缺 `task`。
- `asd_steer` / `asd_kill` / `asd_peek` / `asd_follow` 的 `session` 不在台账里 →
  明确说"这不是本 boss spawn 的 agent"，并列出台账里有哪些。
- `asd_kill` 的目标在台账里但 `createdByUs !== true` → 拒绝，说明"这个 session
  不是 pi-asd 新建的，不会 kill"。**不执行 `asd kill`。**
- `asd new` 非零退出 → 透传 asd 自己的 stderr。

**不算错，是状态：**

- `asd follow` 退出码 **4**（超时）→ "还在忙"，连同当前屏幕一起返回。
- `asd follow` 退出码 **3**（无此 session）→ "这个 agent 已经结束了"，顺手清台账、
  停 watcher。
- `asd peek` 报 session 不存在 → 同上。

**提前拦掉：**

- 名字非法 → `registry.ts` 先洗名 + 截断，不让 asd 报错。
- daemon 没起 → `asd new` 会自动拉起（已实测），不做特殊处理；`peek` / `kill` /
  `follow` 撞上就透传 asd 的原文案。

## 测试策略

五个纯模块用假 `exec` 全测：

- **`cli.test.ts`** — 每个命令的参数拼装（尤其 `--cmd` 那串 env 前缀 +
  shellEscape）、`asd list --json` 解析、退出码 0/3/4 的分流、stderr 透传。
- **`registry.test.ts`** — 命名：前缀、自动编号、撞名追加后缀、洗名（非法字符、
  连续 `-`）、64 字符截断；对账：`asd list` 里消失的条目被移除；复用挑选：
  agent/cwd 都匹配且 idle 才算候选，多个候选取 `idle_ms` 最大，`running` 的不算，
  给了 `name` 时只认同名那个；**kill 守卫：台账外的名字拒绝、`createdByUs !== true`
  的记录拒绝。
- **`tools.test.ts`** — 六个工具的行为：spawn 命中复用走 `send` 而不是 `new`、
  未命中才 `new`、`reuse: false` 强制新建、`watch: false` 不挂 watcher；steer
  成功后重挂 watcher；peek/follow 撞上 session 消失时清台账；**kill 守卫的两种
  拒绝路径都要断言假 exec 上没有发生过任何 `asd kill` 调用**。
- **`watcher.test.ts`** — 状态机：follow 返回 → 触发 peek → 触发 notify；退出码 3
  走"已结束"文案；退出码 4 走"超时"文案且不重挂；abort 后不再 notify；同一 session
  不重复挂。
- **`prompt.test.ts`** — 无 agent 时只有第一段；有 agent 时带清单且任务被截断到
  80 字；`ASD_SESSION` 有无两种形态。

外加**一个 e2e**（`e2e.test.ts`）：临时目录里**同时**设 `ASD_SOCKET` 和
`XDG_DATA_HOME` 起一个隔离的 daemon，spawn 一个 `sh -c 'echo READY; sleep 30'`
（不真跑 agent），验证 spawn → agents → peek 拿到 `READY` → steer → kill 这条链，
跑完销毁整个临时目录。它挡的是"命令拼错了但假 exec 测不出来"的整类问题。

> **必须同时设两个环境变量。** asd 的 `data_dir()` 认 `XDG_DATA_HOME`，持久化
> session 列表 `<data_dir>/sessions.tsv` **不按 socket 隔离**。只设 `ASD_SOCKET`
> 起一个"隔离" daemon，它会照着全局 `sessions.tsv` 把用户现有的 session 名全部
> 重建一遍，`asd kill --all` 还会把那份列表清空。这条同样要写进 README。

## 非目标 / 已知限制

- **spawn 出来的 session 是 80x24。** `asd new` 没有 `--cols` / `--rows`，没有客户端
  attach 时就是这个默认尺寸。agent 的 TUI 跑得起来但很挤，`asd_peek` 默认只看得到
  24 行，要更多得靠 `scrollback`。asd 当前的硬限制，不在 pi-asd 里绕。
- **不支持任意命令。** `asd_spawn` 只认预设表里的 agent，不接受裸命令。因此
  `asd_follow` 的 `mode: "end"` 在默认预设下用不上（交互式 agent 不会自己退出），
  它是给以后加无头预设留的口子。
- **不做 pane 高亮的等价物。** asd 没有 session 着色，`asd ui` 侧边栏已经有
  running/idle 高亮。
- **不持久化台账。** boss 重启后台账为空。
- **不会自动占用台账外的 session。** 外部 session 只能由 boss 看过
  `asd_candidates` 后指名收养，绝不自动挑中。收养来的 session 永远不会被
  `asd_kill` 结束。
- **不做远程 spawn。** asd 支持 SSH 远端 daemon，但 pi-asd 只打本地 `asd`。
