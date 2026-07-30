# pi-asd

把任务派给跑在独立 [asd](https://github.com/benenen/asd) session 里的子 agent ——
[pi](https://github.com/earendil-works/pi) 的 boss mode，跑在 asd 上而不是 tmux 上。

参照 [pi-boss](https://github.com/skyfallsin/pi-boss) 实现，但因为 asd 原生带
`send` / `peek` / `follow` / `list --json`，**不需要 tmux，也不需要 pi-room**。

## 它做什么

主 agent 把任务拆成独立子任务，每个 `asd_spawn` 一个子 agent。spawn 时会挂一个
后台 `asd follow` watcher —— 它阻塞在那里等 agent 停下来，**不烧任何 LLM token**。
agent 一停，watcher 自己读一屏，把结果推给主 agent。

所以主 agent 从头到尾不用轮询、也不被阻塞，spawn 完可以直接去干别的。

## 开关

**boss mode 默认关闭，手动开启：**

| 命令 | 作用 |
|---|---|
| `/asd:boss-start [agent]` | 打开 —— 从下一轮起注入拆任务和监控的提示词 |
| `/asd:boss-stop` | 关闭 —— 不再注入提示词 |

`/asd:boss-start` 可以带一个 agent 名（`pi` / `claude` / `codex`，有参数补全），
定这一轮 `asd_spawn` 不显式传 `agent` 时用哪个。**不给参数就回到基线**
（`PI_ASD_AGENT`，默认 `pi`），不会沿用上一次的选择。名字不认识时什么都不改，
也不会打开 boss mode。

关闭状态下系统提示词一个字都不加。开关是进程内状态，不持久化，重启后回到关闭。

默认关闭。想让它装好就开，设 `PI_ASD_BOSS=1`（值认不出来时会提醒一次并保持关闭，
不会静默忽略）。开关本身是进程内状态，不持久化——`/asd:boss-stop` 关掉之后，
下次启动会回到 `PI_ASD_BOSS` 决定的初始值。

`/asd:boss-stop` **不杀任何 agent、也不停 watcher**，只停止注入提示词。已经派出去的
agent 照跑，停下时结果照样推给主 agent —— 关掉 boss mode 不该让你对在跑的活失去知觉。
要结束 agent 就显式用 `asd_kill`（且只对本扩展自己建的有效）。

下面这些工具在关闭状态下**仍然可用**。关的是提示词，不是能力：没开 boss mode 也可能想用
`asd_candidates` 看看有哪些空闲会话。

## 工具

| 工具 | 做什么 |
|---|---|
| `asd_spawn` | 派任务。指名交给 → 台账内复用 → 新建，按这个顺序 |
| `asd_agents` | 列出本次 spawn 的 agent 和实时 running / idle 状态 |
| `asd_candidates` | 列出所有空闲、能接活的 session（含不是本扩展建的），供挑选 |
| `asd_peek` | 读一个 agent 当前的屏幕，不阻塞 |
| `asd_follow` | 阻塞到 agent 停下来，返回过程输出 + 最后一屏 |
| `asd_steer` | 往 agent 会话里打一条消息，然后重挂 watcher |
| `asd_kill` | 结束 session —— **只能结束本扩展自己新建的** |

### 派任务的三条路

1. **指名交给** —— `asd_spawn(task, session: "mem")` 把任务交给一个已经在跑的
   空闲 session，哪怕它是你自己手建的。这条路只在明确点名时走，**永远不会自动
   发生**。交之前会校验它确实空闲、且前台跑的是认得出的 agent；如果那是个裸
   shell 就直接拒绝——把任务描述 `send` 进 bash 提示符会被当命令执行。
2. **台账内复用** —— 没点名时，如果台账里有 agent 和 cwd 都对得上、当前空闲的
   session，就把新任务送进去。`reuse: false` 强制新建。自动复用**不碰台账外的
   session**：自动挑中你正在用的工作会话是不能接受的默认行为。
3. **新建** —— 前两条都没命中才建新 session。

`asd_candidates` 是第 1 条的入口：它合并 `asd card list --json`（工作目录、项目
文档）和 `asd list --json`（正在做什么、闲了多久、跑的哪个 agent），只列空闲且
能接活的，闲最久的排前面，并标出哪些不是本扩展建的。

### 「空闲」是怎么判的

复用、`asd_candidates`、指名交给都要求目标**连续静默至少 15 秒**，不只是
`asd list` 说它不忙。

因为 asd 的 `running` / `status` 字段并不是"进程在执行"的意思——实测它恒等于
"`idle_ms` 小于约 2 秒"，也就是"终端最近有动静"。一个跑着 `sleep 8` 的 session
在第 3.7 秒报的就是 `running: false` / `status: idle`。只看这个字段的话，一个
沉默思考了两秒多的 agent 会被当成空闲，任务直接 `send` 进去，打断它正在做的事。

> **这条判据不可能完备。** asd 只看得到终端字节，一个 shell 出去跑静默大编译的
> agent 可以安静几分钟。真正承重的是另一条：自动复用池只收本扩展自己创建的
> session，所以最坏情况是把两个任务叠进自己的 agent，绝不会叠进你的会话。

### kill 的边界

`asd_kill` 在执行前必须同时满足两条：名字在台账里、且该记录是本扩展 `asd new`
出来的。任何一条不满足就直接报错返回，**不会执行 `asd kill`**。你手建的 session
碰不到——**包括被指名交过任务、因此进了台账的那些**：那些记录带
`createdByUs: false`，永远杀不掉。

`asd kill --all` 在这个项目的任何代码路径里都不存在。

## 安装

```bash
pi install git:github.com/benenen/pi-asd
```

或者直接 clone 到扩展目录：

```bash
git clone https://github.com/benenen/pi-asd ~/.pi/agent/extensions/pi-asd
```

需要 [asd](https://github.com/benenen/asd) 在 PATH 上，以及 Node ≥ 24。

## 配置

所有配置项都可以通过**环境变量**或 **JSON 配置文件**设置，优先级统一为：

```
环境变量 > asd.json 配置文件 > 内置默认值
```

### 配置文件

启动时依次合并两个 asd.json（后面的覆盖前面的）：

1. `~/.pi/agents/<agent-name>/asd.json` —— agent 级通用配置
2. `<项目根>/.pi/asd.json` —— 项目级覆盖（在 `session_start` 事件里加载）

项目级配置目前仅支持 `bossMode.autoStart`：可以在某个项目里放一个 `.pi/asd.json`
申明 `"bossMode": { "autoStart": true }`，打开那个项目时自动开启 boss mode。

```jsonc
{
  // boss mode 自启动 + 默认 agent（对应 PI_ASD_BOSS / PI_ASD_AGENT）
  "bossMode": {
    "autoStart": false,
    "defaultAgent": "pi"
  },
  // 子 agent 工作区基坐目录（对应 PI_ASD_WORKSPACE）
  "workspaceBase": "/path/to/workspaces",
  // session 名前缀（对应 PI_ASD_PREFIX）
  "prefix": "pi-",
  // follow 超时（对应 PI_ASD_FOLLOW_TIMEOUT）
  "followTimeout": "30m",
  // 空闲多久之后自动回收 agent，"off" 关掉（对应 PI_ASD_IDLE_KILL）
  "idleKillAfter": "2m"
}
```

所有字段都可选，不写的字段走默认值。

### 环境变量

| 环境变量 | 配置文件字段 | 默认值 | 作用 |
|---|---|---|---|
| `PI_ASD_PREFIX` | `prefix` | `pi-` | spawn 出来的 session 名前缀 |
| `PI_ASD_AGENT` | `bossMode.defaultAgent` | `pi` | 默认 agent（`pi` / `claude` / `codex`） |
| `PI_ASD_FOLLOW_TIMEOUT` | `followTimeout` | `30m` | watcher 等待上限 |
| `PI_ASD_BOSS` | `bossMode.autoStart` | （未设置） | 装好就默认开启 boss mode。`1` / `true` / `on` / `yes` 开；未设置、空串或 `0` / `false` / `off` / `no` 关 |
| `PI_ASD_WORKSPACE` | `workspaceBase` | `~/.pi/agent/asd-workspaces` | 新 agent 的工作区基坐目录 |
| `PI_ASD_IDLE_KILL` | `idleKillAfter` | `2m` | agent 空闲这么久后自动回收。写法 `30s` / `2m` / `1h`；`off` / `0` 关掉 |

### agent 在哪里开工

不显式给 `cwd` 的话，每个新 agent 拿到 **`<PI_ASD_WORKSPACE>/<session 名>/`** 这样一个
自己的目录（不存在会自动建）。默认基坐目录是 `~/.pi/agent/asd-workspaces`。

**它不会在主 agent 的当前目录里开工。** 多个 agent 挤在同一个工作树上会互相踩，git 尤其
危险——共用一个 index 和 HEAD，一个 agent `checkout` 会掀掉另一个正在编辑的文件。

要让 agent 在某个具体仓库里干活，就显式传 `cwd`：

```
asd_spawn(task: "修 auth 的 bug", cwd: "/path/to/repo")
```

显式给的路径**不会**被自动创建——打错了会让 `asd new` 直接失败，而不是悄悄造出一个空目录。

新 agent 拿到的是空目录，所以要它干仓库里的活，得在 `task` 里写清楚从哪 clone，或者直接
用 `cwd` 指过去。

## 生命周期

### 空闲回收

agent 干完活之后**空闲超过 `PI_ASD_IDLE_KILL`（默认 2 分钟）会被自动 kill**，
免得 session 无限堆积。只回收本扩展自己创建的（`createdByUs: true`）——
指名交过任务的用户 session 和你手建的都不碰，和 `asd_kill` 是同一条闸门。

判据是 asd 的 `idle_ms`（距上次终端活动的时长）。`asd send` 会让它归零，所以
被 `asd_steer` 追加过任务、或者被复用过的 agent 会自动重新计时，不会被误收。

> **注意 `idle_ms` 分不出"闲着"和"在跑一个长时间不输出的命令"。** 一个沉默地
> 跑着大编译的 agent 超过阈值一样会被回收。这种活多的话就把阈值调大，或者
> `PI_ASD_IDLE_KILL=off` 整个关掉。
>
> **不要用 `asd follow` 判"停下"来做回收。** 它的依据是终端安静了约 2 秒，
> 冷启动时完全不可靠：实测一个刚 spawn 出来的 agent 在第 2 秒就会被判成停下
> （那会儿它才刚画完首屏、还在等模型第一个 token）。这条踩过 —— 见
> `extensions/asd/reaper.ts` 顶部的注释。

### 退出

主 agent 退出时**不杀任何 session**，只掐掉 watcher 和回收器，并列出仍在运行的
agent（退出时不会补扫一轮回收）。子 agent 照跑，你可以 `asd attach <名字>`
进去接管 —— 这是 asd 相对 tmux pane 真正多出来的能力。

台账只活在进程内存里：主 agent 重启后 `asd_agents` 是空的，但 session 仍在
`asd list` 里。

## 已知限制

- **spawn 出来的 session 是 80x24。** `asd new` 没有 `--cols` / `--rows`，没有
  客户端 attach 时就是这个尺寸。agent 的 TUI 跑得起来但很挤，`asd_peek` 默认只
  看得到 24 行，要更多得用 `scrollback` 参数。
- **只支持预设表里的 agent**（`pi` / `claude` / `codex`），不接受裸命令。指名交给已有
  session 时也按这张表认前台进程，认不出就拒绝。
- **`asd_candidates` 只对本地 daemon 有效。** 它依赖 `asd card`，而 card 的工作
  目录是从 session 自己的进程读的，远端 daemon 给不出。
- **不做远程 spawn。** asd 支持 SSH 远端 daemon，pi-asd 只打本地 `asd`。

## 开发

```bash
npm install
npm test         # node:test，含一个对着真 asd 跑的 e2e
npm run typecheck
```

> **要隔离一个 asd 实例做测试，必须同时设 `ASD_SOCKET` 和 `XDG_DATA_HOME`。**
> asd 的 `data_dir()` 认 `XDG_DATA_HOME`，而持久化 session 列表
> `<data_dir>/sessions.tsv` **不按 socket 隔离**。只设 `ASD_SOCKET` 起一个
> "隔离" daemon，它会照着全局 `sessions.tsv` 把你现有的 session 名全部重建一遍。

### 手动验证 watcher

有一条核心假设自动化测试覆盖不了：**agent 的 TUI 持续重绘，所以 `asd follow`
不会把"正在思考"误判成"已停下"**。e2e 用 `sh` 当探针，行为不完全一样。真要确认
就手动跑一次：

```bash
# 在 pi 里
用 boss mode 派一个 agent 去数一下这个仓库有多少个 .ts 文件
```

观察：agent 干活期间不应该有任何推送；它停下来等输入之后，watcher 的通知应当在
几秒内到达。

## License

MIT
