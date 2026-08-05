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
`asd_list` 看全部会话，或用 `asd_candidates` 看看有哪些空闲会话。

## 工具

| 工具 | 做什么 |
|---|---|
| `asd_spawn` | 派任务。指名交给 → 台账内复用 → 新建，按这个顺序 |
| `asd_list` | 列出 daemon 当前的全部 session（含未被 pi-asd 监视的） |
| `asd_candidates` | 列出所有空闲、能接活的 session（含不是本扩展建的），供挑选 |
| `asd_peek` | 读任意显式点名的现存 session 屏幕，不要求由 pi-asd 创建或监视 |
| `asd_follow` | 给任意显式点名的现存 session 挂后台 watcher，立即返回；停下后自动推送 |
| `asd_steer` | 往 agent 会话里打一条消息，然后重挂 watcher |
| `asd_nav` | 往 agent 会话里按键，用来操作它弹出的对话框 |
| `asd_rename` | 给 session 改名 —— **进程和屏幕都不动** |
| `asd_unmonitor` | 不再监视某个 session —— 只是不管它了，**不结束它** |
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

### session 名前缀

新建的 session 默认叫 `<prefix><名字>`（前缀默认 `pi-`）。不想要前缀就在这一次
spawn 里传空串：

```
asd_spawn(task: "…", name: "nvr", prefix: "")   → session 名就是 nvr
asd_spawn(task: "…", name: "nvr")               → pi-nvr
```

> 这里空串 = "不加前缀"，和 `PI_ASD_BOSS=` 那种"空串当没设置"的规则**故意相反**：
> 那是读环境变量，空串多半是意外；这个是一次调用里显式传的参数，写 `""` 就是真要。

前缀纯粹是命名约定，**没有任何安全判断依赖它** —— 能不能 kill、能不能自动复用，
看的都是台账里的 `createdByUs`，不是名字长什么样。

已经建出来的 session 想改名：

```
asd_rename("pi-nvr", "nvr")
```

**进程和屏幕都不动** —— 这正是它比"杀掉重建"值钱的地方。pi-asd 的监视列表和
watcher 会一起跟过去。

> 需要 asd 带 `rename` 子命令。协议（v7 的 `Frame::Rename`）和 daemon 一直支持，
> `asd ui` 里按 `r` 也早就能改，但 CLI 是后加的 —— 装的 asd 太老时工具会明确告诉你
> 去升级，而不是让你以为名字有问题。

### 长期员工：persistent

默认所有 agent 都参与空闲回收。长期负责某个项目的 agent 可以标成长期员工：

```
asd_spawn(task: "…", name: "nvr", prefix: "", persistent: true)
```

`persistent` 和 `createdByUs` 是**两条不同的判断**，回收时两个都要过：

| | 管什么 | 不过关会怎样 |
|---|---|---|
| `createdByUs` | **能不能** kill | 不是自己创建的，任何情况都不许动 |
| `persistent` | **要不要** kill | 是自己创建的，但这是长期岗位，别收 |

`persistent` **只挡自动回收**。`asd_kill` 是显式点名结束，不受它影响 —— 否则设了
persistent 的 agent 就再也关不掉了。

### 投递校验

三条路都会在送出任务之后 **peek 一屏确认它真的进了 agent 的输入框**，没进就如实
报「任务未投递成功：<原因>」并且不记台账。

因为 `asd send` 返回成功只代表"asd 把字节排进了队列"，既不代表 agent 收到、更不
代表它开始干活。以前拿它当"已送达"，任务丢了也照报「已派出 xxx」，然后你干等一个
永远不来的结果。

### 子 agent 的环境变量

**子 agent 是 asd daemon fork 出来的，继承的是 daemon 的环境，不是 pi 的。** 那个
daemon 可能是几天前、从另一个 shell 起来的，你 shell 里的代理设置、`IS_SANDBOX`
之类它一概没有。

所以 pi-asd 会把一组变量从自己的进程环境里**点名透传**给每个新 agent（拼在启动
命令前面）。默认这一组：

```
HTTPS_PROXY  HTTP_PROXY  NO_PROXY  https_proxy  http_proxy  no_proxy
IS_SANDBOX   DISABLE_AUTOUPDATER
```

只透传当前进程里**确实有值**的那些，不会凭空造变量。用 `envPassthrough` 换掉这张
表，或用 `spawnEnv` 直接给值。

> 这一组是踩出来的。以 root 运行时，`claude --dangerously-skip-permissions` 在没有
> `IS_SANDBOX=1` 的情况下会直接拒绝启动（"cannot be used with root/sudo
> privileges"）并**立即退出** —— 表现就是 spawn 出来的 session 一秒就消失。缺代理
> 变量则是起得来但 API 403。这些变量在交互 shell 里通常由别名（如 `clp`）设好，
> daemon 里没有。

### 用本机别名启动 agent

如果你本机有个自带环境变量的包装（比如 `alias clp='HTTPS_PROXY=… IS_SANDBOX=1
claude --dangerously-skip-permissions'`），可以直接让 pi-asd 用它：

```jsonc
{ "aliases": { "claude": "clp" } }
```

比在 `envPassthrough` 里维护变量名单省心，而且**包装改了不用重启 pi** —— 配置是
每次加载时读的，而环境透传是启动时快照的。

pi-asd 会用 `bash -ic '<别名>'` 去跑它。**shell 别名只在交互式 bash 里展开**：
`/bin/sh` 常是 dash，非交互 bash 既不 source `~/.bashrc` 也不展开别名。实测：

```
clp              → session 立刻消失（command not found）
sh -c 'clp'      → session 立刻消失（command not found）
bash -ic 'clp'   → 起得来，别名带的环境变量也生效
```

代价是会 source 整个 `~/.bashrc`。好处是 `asd list` 报的前台进程仍是被 exec 的
真命令（实测就是 `claude --dangerously-skip-permissions`），所以按前台进程认
agent 的那套判断不受影响。

### 启动期的模态 UI

**claude 在没被信任过的目录里会先弹工作目录信任确认**，而每个新 session 拿到的
正是一个全新空目录 —— 所以它每次必然撞上。那个对话框盖在输入框上层：任务文本会
送到它后面，回车被它吃掉，而默认选项是 `2. No, exit`，session 会直接消失。

现在 claude 改成**裸启动 → 认出并过掉对话框 → 再把任务打进去**。这套按 agent 配在
预设表里（`deliver` + `startupDialogs`），以后别的 agent 有类似启动期 UI 照这个加。

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

### `asd_list` 是全部 session 清单，不是等待工具

`asd_list` 直接从 `asd list --json` 取成员，所以用户手建、尚未被 pi-asd 监视的 session
也会出现。输出只列 session 名，不逐个读取屏幕，也不显示 `running` / `idle_ms` / title。
这是刻意的：`asd_peek` / `asd_follow` 可以**显式点名**任意现存 session，但清单工具不能
借着「补状态」自动把所有用户手工会话的屏幕批量读出来。

显式读取和后台监视不等于纳入复用/回收台账：对台账外 session 调 `asd_peek` 只读一屏；
调一次 `asd_follow` 会挂后台 watcher 并立即返回，停下后自动把最终屏幕推回来，但不会让
Reaper 管它。要发送输入并纳入台账，仍然用 `asd_spawn(task, session: "<名字>")` 指名交给它；
`asd_kill` 仍只能结束 pi-asd 自己创建的。只想停掉这个外部 watcher 时用 `asd_unmonitor`。

#### 用户问点名 session 的状态时必须读屏

这是用户明确指定的 boss 行为：用户问「`lnny` 状态」「看下 `mem`」这类点名问题时，
`asd_list` / `asd_candidates` 只能用来找名字或确认 session 存在，**不能拿表面状态直接作答**。
boss 必须接着对该 session 调一次 `asd_peek`，根据屏幕汇报它正在执行或已经执行完的具体内容。

如果 `asd_peek` 读不到，先如实说明原因，再用本轮唯一一次 `asd_list` 确认 session 是否还存在；
本轮已经查过清单就复用已有结果。这里只 peek 一次，不能为了等变化反复 peek 退化成轮询。

它只有两个合法入口：用户明确要看**全部 session**；或者点名状态查询的单次 `asd_peek`
读不到，需要兜底确认 session 是否仍存在。它不是选空闲 agent 的入口（那是
`asd_candidates`），不是判断任务结果的入口（那是 `asd_peek`），也不是等待方式（用 watcher
或 `asd_follow`）。两个入口共享每轮一次额度；同一轮再次调用会直接拒绝，不会再碰 daemon。
新的用户/飞书消息或 watcher 推送开启下一轮后才重新放行。

早先另有一个 `asd_agents`，只列 pi-asd 台账里的 agent。它仍然**没有注册**：这个只读工具
曾让 boss 陷进连续调用的循环里。它和 `asd_list` 不是别名，也不要把它接回来：

- **daemon 里有哪些 session** —— 用户明确要求时，或点名状态的 peek 失败兜底时，调用一次 `asd_list`
- **pi-asd 派了什么、watcher 挂没挂** —— boss mode 每轮自带的「当前 agent」清单
- **它干得怎么样** —— `asd_peek`
- **想等** —— 已有 watcher 就什么都不做；没有就调一次 `asd_follow` 注册后台监视，然后继续干别的

> 顺带一提这条更一般的教训，剩下的工具仍然照它设计：**一个工具如果给不出某个结论，
> 它的输出就不能长得像给出了。** 所以状态词是「安静 / 在动」而不是 idle / running ——
> 后者读起来像"闲着 = 没事干 = 做完了"，而它其实只是终端没动静：可能做完了、可能在
> 沉默地想、也可能卡住了。拿"安静"当失败信号去重发任务，只会让 agent 从头再来一遍，
> 或者两份任务同时在跑。

### watcher 会分清三种「安静」

`asd follow` 判"停下"的依据只是终端安静了约 2 秒，它分不出 agent 是**干完了**、
**在思考**、还是**卡在对话框上等人**。watcher 现在把三者分开：

| 情况 | 怎么判 | 通知 |
|---|---|---|
| 思考中 | settle 后每隔 1.2s 连续复核两次；三屏或 final peek 任一变化都说明还在重绘 | 不通知，安静重挂并从零累计 |
| 等决策 | 三屏连续稳定，final peek 也未变化且认出是模态对话框 | ⚠️ **需要用户决策** + 问题/选项/当前选中 + 怎么作答 |
| 真停下 | 三屏连续稳定，final peek 也未变化且不是对话框 | 已停下（历时 …）+ final peek 的最后一屏 |

"思考中"这一条是唯一能把它和"停下"分开的判据 —— asd 自己给不出（`running` 恒等于
`idle_ms < 2s`）。原理是干活的 agent 会持续重绘（转圈、逐字输出），静止的不会。
连续变化达到保护上限时 watcher 只会报「未确认停下」，不会绕过确认宣称已经停下。

对话框的通知长这样：

```
[pi-asd] ⚠️ agent "pi-dlg" 需要用户决策（已等待 4s）。
问题：Quick safety check: Is this a project you created or one you trust?
选项：❯ 1. Yes, I trust this folder | 2. No, exit
当前选中：1. Yes, I trust this folder
提示：Enter to confirm · Esc to cancel
用 asd_nav("pi-dlg", [...]) 按键作答；作答之后 watcher 会自动重挂，不用重新 spawn。
```

**作答之后 watcher 自动重挂** —— `asd_nav` 和 `asd_steer` 都会重挂，不需要重新
`asd_spawn`。

上例适用于已经在 pi-asd 台账里的 session。`asd_follow` 单独监视的台账外 session 仍受
写操作边界保护，`asd_nav` 不会碰它；这时通知会改为提示运行 `asd attach <session>` 手动
作答，处理完再调一次 `asd_follow` 重新挂后台监视。

识别对话框是启发式，取舍是**宁可漏认、不可错认**：漏认退回"已停下"的通知（屏幕
照样带上，你自己也看得出来），错认会给一屏正常输出扣上"需要决策"的帽子、把 boss
引去按键。所以要求「编号选项」和「底部按键提示」同时出现才算数。

### agent 弹了对话框怎么办

agent 有时会弹**模态对话框**（选择框、确认框）。它会把输入框顶掉，这时
`asd_steer` 的投递校验会失败并**拒绝按回车** —— 那是对的：那一下回车会去确认
对话框当前选中的项（claude 信任对话框的第二项是 `2. No, exit`）。

台账内 session 要操作对话框就用 `asd_nav`：

```
asd_peek("pi-a")                          # 先看清楚是什么界面、选中的是哪一项
asd_nav("pi-a", ["ArrowDown", "Enter"])   # 再按
```

支持 `Enter` / `Space` / `Tab` / `Escape` / `Backspace` / `Home` / `End` /
`ArrowUp` `ArrowDown` `ArrowLeft` `ArrowRight` / `C-a`..`C-z`（`C-c` 会中断 agent）。
`ArrowDown` 和 `Down` 两套写法都认，大小写随便。

按键逐个送出、中间留空档，不会挤在一个 payload 里（原因同"送文本必须分两次发"）。
认不出的按键名一律拒绝、**一个都不送** —— 猜错一个键可能就确认了一个对话框。

这个工具**不做投递校验**（按键本就不是往输入框送的），所以调用方要自己先 peek。
它会把按完之后的屏幕一并返回，省掉一次来回。

### 不监视了：asd_unmonitor

指名交过任务的 session 会进监视列表，从此一直被追踪（watcher 挂着、回收器管着、
boss mode 的提示词里也列着它）。`asd_follow` 也可以只给台账外 session 挂 watcher。
不想监视了：

```
asd_unmonitor("nvr")
```

**只是不管它了，不结束它。** 进程照跑，watcher 停掉；如果它原本在台账里，也会从
监视列表摘掉，空闲回收器不再考虑它。之后还能用 `asd_spawn(task, session: "nvr")`
再次指名交给它 —— 重新纳入监视。

> 名字没叫 `asd_unwatch`：`asd_spawn` 已经有个 `watch` 参数，那个窄得多 —— 只是
> "这次挂不挂 watcher"，session 仍然在监视列表里、仍然被回收器管。两个混起来会让
> 人以为 `watch: false` 就等于不监视。

和另外两个工具的分界：

| 想要 | 用 |
|---|---|
| 结束这个进程 | `asd_kill`（只能结束自己创建的） |
| 留着它但别被空闲回收 | `asd_spawn(..., persistent: true)` |
| 进程留着，pi-asd 别再管 | `asd_unmonitor` |

> **对自己创建的 session 停止监视是单向门。** 重新纳入时会以"不是自己创建的"
> 记账，从此 `asd_kill` 永远拒绝结束它（那道闸门认的是台账里的标记，不是历史）。
> 只是不想被自动回收的话用 `persistent` —— 那个保留 kill 权。工具返回里会提醒。

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
  "idleKillAfter": "2m",
  // 从 pi 自己的环境里透传给子 agent 的变量名（不写就用内置那一组）
  "envPassthrough": ["HTTPS_PROXY", "NO_PROXY", "IS_SANDBOX"],
  // 直接指定透传的值，覆盖 envPassthrough 里的同名项
  "spawnEnv": { "IS_SANDBOX": "1" },
  // agent → 本机别名/包装命令。配了就用它启动，没配才用原名
  "aliases": { "claude": "clp" }
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
| （无） | `envPassthrough` | 见上文 | 从 pi 环境透传给子 agent 的变量名 |
| （无） | `spawnEnv` | （空） | 直接指定透传的值，覆盖 `envPassthrough` 同名项 |
| （无） | `aliases` | （空） | agent → 本机别名/包装命令，如 `{"claude": "clp"}` |

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
免得 session 无限堆积。两道判断都要过才收：`createdByUs: true`（是自己创建的）
且 `persistent` 不为 true（不是长期员工）。指名交过任务的用户 session 和你手建的
都不碰，和 `asd_kill` 是同一条闸门。

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

台账只活在进程内存里：主 agent 重启后监视列表是空的，但 session 仍在 `asd list`
里。此时可以直接 `asd_peek` 显式查看，或调一次 `asd_follow` 挂后台 watcher；需要发送输入、
纳入复用/回收台账时，再用 `asd_candidates` 确认后指名交给它。

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
