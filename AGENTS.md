# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) and other coding agents when working
with code in this repository. `CLAUDE.md` is a symlink to this file — edit this one.

## 这是什么

pi-asd 是 [pi](https://github.com/earendil-works/pi) 的扩展：把任务派给跑在独立
[asd](https://github.com/benenen/asd) session 里的子 agent。asd 原生带
`send` / `peek` / `follow` / `list --json`，所以不需要 tmux、也不需要 pi-room。

核心机制：`asd_spawn` 出一个子 agent，同时挂一个后台 `asd follow` watcher —— 它阻塞在那里
等 agent 停下来，**不烧任何 LLM token**。agent 一停，watcher 自己 peek 一屏推给主 agent。
主 agent 因此从头到尾不用轮询、也不被阻塞。

## 命令

```bash
npm install
npm test              # node:test，293 个用例，含一个对着真 asd 跑的 e2e
npm run typecheck     # tsc --noEmit
```

跑单个测试：

```bash
node --test test/config.test.ts                                   # 单文件
node --test --test-name-pattern "resolveWorkspaceBase" "test/**/*.test.ts"   # 按名字
```

**别写 `node --test test/`。** Node 24 不会递归展开裸目录参数，会报
`Cannot find module '.../test'` —— 和测试内容无关。要么给具体文件，要么用
`"test/**/*.test.ts"` 这样的 glob（`package.json` 的 `test` 脚本就是这么写的）。

e2e 在 `asd` 不在 PATH 上时自动跳过。

### 测试里起 asd 必须同时设两个变量

> **要隔离一个 asd 实例做测试，必须同时设 `ASD_SOCKET` 和 `XDG_DATA_HOME`。**
> asd 的 `data_dir()` 认 `XDG_DATA_HOME`，而持久化 session 列表
> `<data_dir>/sessions.tsv` **不按 socket 隔离**。只设 `ASD_SOCKET` 起一个"隔离" daemon，
> 它会照着全局 `sessions.tsv` 把用户现有的 session 名全部重建一遍。

`test/e2e.test.ts` 里唯一的例外是 `asd --version`（clap 内置元数据子命令，碰 daemon 之前就
返回）。任何会碰 daemon 的子命令都必须走那个文件里的 `realExec()`。别把这处例外当模板抄。

## 架构：一层薄壳 + 六层纯逻辑

理解这个代码库只需要抓住一条：**`index.ts` 是唯一 import pi 的文件**。其它每一层的外部
依赖都是注入进来的，所以整个代码库不装 pi、不装 asd 也能测。

```
index.ts        ← 唯一碰 pi 的文件。把 pi.exec 适配成 exec、pi.sendMessage 适配成 notify，
                  读 process.env，注册 10 个工具和 2 个斜杠命令。只接线，不放逻辑。
  ├── cli.ts       asd 命令行的薄封装（注入 exec）
  ├── registry.ts  台账：本次 spawn 出来的 agent。纯逻辑，不碰 IO
  ├── watcher.ts   WatcherPool：后台 follow watcher（注入 asd / notify / now）
  ├── reaper.ts    Reaper：按 idle_ms 定时回收空闲够久的自家 session
  ├── dialog.ts    从一屏文字里认出「agent 弹了对话框在等决策」。纯函数
  ├── tools.ts     工具逻辑（注入 asd / registry / watchers / config / mkdirp / now）。
                   另有两个内部入口：`agents()` 故意不注册；`resetListAllowance()` 由生命周期调用
  ├── prompt.ts    boss mode 系统提示词。纯函数
  └── config.ts    asd.json 的读取、合并、校验
```

几条跟着这个结构走的硬规矩：

- **`tools.ts` 不读 `process.env`。** 它需要的每个值（`bossSession`、`workspaceBase`、
  `followTimeout`…）都由 `index.ts` 读了环境变量再经 `ToolConfig` 注入。想加配置项就
  照这条路走，别在下层直接摸 env。
- **`prompt.ts` 自己判断 `enabled`**（关闭时返回空串），而不是让 `index.ts` 判断 ——
  因为 `index.ts` 是唯一没有单测夹具的文件，能下沉的判断都要下沉。
- **`PRESETS` 可以按调用方覆盖。** `ToolConfig.presets` / `buildSpawnCommand({presets})`
  让测试传自己的一份假预设（e2e 用 `sh` 当探针），不用改模块级 `PRESETS` 污染别人。
- **asd 的退出码 3 / 4 是有语义的状态，不是错误。** `cli.ts` 把它们翻译成返回值
  （`peek` → `null`、`send` → `false`、`follow` → `{kind:"gone"|"timeout"}`），不抛异常。

## 必须守住的不变量

改这个仓库时下面几条会真的咬人，动相关代码前先读懂：

### 1. `createdByUs` —— 用户手建的 session 不能被自动复用或结束

台账里混着两种记录：pi-asd 自己创建的（`asd new` 出来的，`createdByUs: true`），和被指名
交过任务、因此也进了台账的用户 session（`createdByUs: false`）。**「在台账里」不等于
「是自己创建的」**，两道闸门都只认 `createdByUs === true`：

- `Registry.canKill()` —— `asd_kill` 必须先问过它拿到 `ok: true` 才允许执行 `asd kill`
- `Registry.pickReusable()` —— 自动复用池同样只收自己创建的。这里漏掉这一条的后果是：
  指名交过一次任务之后，任何一次**没点名**的 `asd_spawn` 都可能把用户正在用的会话静默
  塞进下一个任务

自动复用**永远不碰台账外的 session**；台账外的只能由主 agent 看过 `asd_candidates` 之后
指名交给它。

**显式只读/等待是正交的，不走这道所有权判断。** `asd_peek` / `asd_follow` 可以点名任意
现存 asd session，不要求它先由 pi-asd spawn 或进入台账；两者不发送输入、不 kill、不让
Reaper 接管，也不会把外部 session 纳入监视列表。`steer` / `nav` 仍会发送输入，所以只允许
台账内目标；要操作外部 session，先用 `asd_spawn(task, session: "<名字>")` 指名交给它。

**`persistent` 是另一条正交的判断，别和 `createdByUs` 混起来。** 空闲回收要两条都过：

| | 管什么 |
|---|---|
| `createdByUs` | **能不能** kill —— 不是自己创建的，任何情况都不许动 |
| `persistent` | **要不要** kill —— 是自己创建的，但这是长期岗位，别收 |

`persistent` 只挡 `Reaper` 那条自动路径，**不影响 `canKill`** —— 否则设了 persistent
的 agent 就再也关不掉了。缺省（undefined）按 false 处理，老记录不会突然变成不可回收。

第三个容易混的是 `unmonitor`：它把记录从监视列表里**摘掉**，进程不动。提示词里的
「当前 agent」清单和 `Reaper` 都读台账，所以摘掉即生效 —— 那两处**不需要**为它加任何
判断（有用例把这个隐含依赖钉住了，免得以后给 Reaper 换数据源时悄悄破坏）。

`rename` 是第四个相关操作：它**改名字，不动进程**。台账是按名字索引的，所以顺序很
要紧 —— **先改 asd、成功了再动台账**（反过来的话 asd 失败了台账已经指向不存在的名字，
比不改还糟），而且要把 watcher 一起搬过去，否则 pi-asd 跟丢。新名字在台账里已被占用
时必须先拦下来：让 asd 改成功而这边搬不过去，会覆盖掉另一条记录、那个 agent 凭空消失。

四者放一起看：`kill` 结束进程 / `persistent` 留着且不自动收 / `unmonitor` 留着但不管
/ `rename` 换个名字接着管。
**对自己创建的 session 用 `unmonitor` 是单向门**：重新纳入会记成 `createdByUs: false`，
从此 kill 不掉 —— 工具返回里必须提醒这一点。

命名上没用 `unwatch`：`asd_spawn` 的 `watch` 参数含义窄得多（只是这次挂不挂 watcher，
session 照样进列表、照样被回收器管），撞名会让人以为两者等价。

session 名前缀纯属命名约定，**没有任何安全判断依赖它**。`SpawnParams.prefix` 可以按次
覆盖，传 `""` 就是不加前缀 —— 注意这里空串是"真的要空"，和读环境变量时"空串当没设置"
那条规则故意相反（那是防 `.env` 空行，这是调用方显式传参）。

术语：用户可见的文案一律说**「自己创建的」/「不是自己创建的」**（对应 `createdByUs`），
动作说**「指名交给」**。不要用「收养」——中文里那是收养孩子的意思，和这里的动作对不上。

### 2. `asd kill --all` 在任何代码路径里都不存在

一次都不许出现。要结束 session 只能点名，且只能点自己建的。

### 3. `createTools` 闭包里的 `reserved` 屏障

pi 的并发工具执行模型下，同一条助手消息里的多个 `asd_spawn` 是**并发**跑的，会在同一份
`await asd.list()` 快照上各自决策。没有这道屏障，两个并发 spawn 会抢中同一个空闲 agent
（后者的任务覆盖前者），或者撞同一个新名字（第二个 `asd new` 被拒）。

注意它占的是「接下来会落进 registry 的那个 key」：新建路径上 `allocateName` 算出的名字和
`asd new` 实际回显的名字可能不一样，两个都要占，否则中间那条缝隙会漏。失败、成功、复用转
新建的中途改道，收尾时都必须放行预留。

### 4. asd 的 `running` 不是「进程在执行」，`settle` 不是「干完了」

实测 asd 0.1.9（`extensions/asd/reaper.ts` 顶部有完整记录）：

- **`SessionInfo.running` 恒等于「`idle_ms` 小于约 2 秒」**，也就是"终端最近有动静"。
  一个跑着 `sleep 5` 的 session 在第 3.5 秒报的是 `running: false`；它刚跑完的那
  一瞬间反而报 `running: true`。**别把它当成"agent 在干活"。**
- **`asd follow` 的 settle 判据同样是终端安静约 2 秒**，所以一个刚 spawn 出来、
  画完 TUI 首屏、正在等模型第一个 token 的 agent，会在第 2 秒被判成"已停下"。
- **`idle_ms` 是唯一可靠的空闲信号**，且 `asd send` 会让它归零。

由此得出两条硬规矩：

**a. 任何不可逆的动作（尤其 kill）都不许挂在 settle 上。** 这条是踩出来的 ——
曾经 watcher 的回调在 settle 时触发并直接 `asd kill`，结果 spawn 出来的 agent
全部在真正开始干活之前被杀掉，而 164 个单测全绿（单测把 asd mock 掉了，测不到
这个时序）。回收改成 `Reaper` 按 `idle_ms` 扫描之后才对。`Reaper` 也因此不需要
"被 steer 了要取消"这类逻辑：送任何输入都会把 `idle_ms` 打回零，够不够格每轮现算。

**b. 判"这个 session 能不能接活"要用 `looksIdle()`，不许直接读 `info.running`。**
`tools.ts` 的 `looksIdle()` 要求连续静默 ≥ `REUSE_MIN_IDLE_MS`（15s）。三个决策点
（自动复用的候选池、`candidates()`、`adopt()`）都走它。直接读 `running` 会让一个
沉默思考了两秒多的 agent 被当成空闲，任务 send 进去打断它。

两条都不可能完备（asd 只看得到终端字节，静默跑大编译的 agent 可以安静几分钟）。
真正承重的是 `createdByUs` 那道闸门：最坏情况只会叠进自己的 agent，不会碰用户的。

### 5. 送文本必须分两次发：正文一次，Enter 一次

`Asd.send()` 先 `asd send --text <正文>`，等 `ENTER_DELAY_MS`（300ms），再
`asd send --key Enter`。**不许合成 `--text X --enter` 一次发。**

`--enter` 会把 CR 拼进同一个 payload，被控端一次 `read()` 全收到。实测（429 字节正文）：

```
一次调用：C1 len=430 tail=…,0d cr=YES        ← 正文和 CR 同一个 chunk
分两次：  C1 len=429 cr=no ；C2 len=1 cr=YES ← CR 是独立按键
```

agent 的 TUI 输入框普遍按"一大坨字节一次到达"判定粘贴，那个尾部 CR 于是被当成粘贴
内容里的换行插进输入框，**不触发提交** —— 症状是"内容发过去了但没有回车成功"，文本
越长越容易命中，所以表现为"有时候"。asd 的 `--enter` 帮助文本明说了它让 session
"see one keypress rather than a line break and then Enter"：对 shell 正确，对 TUI 有害。

写测试时注意：**一次逻辑送达现在是两条 `send`**。想断言"恰好送达一次"要用
`deliveries()`（只数带 `--text` 的那条），拿 `subcommands().filter(c => c === "send")`
数会翻倍。单测构造 `createAsd` 时传 `{ enterDelayMs: 0 }`，别真睡 300ms。

### 6. 投递必须校验 —— `send` 返回 true 不代表对方收到了

`asd send` 退出码 0 的语义**只是"asd 把字节排进了这个 session 的队列"**。asd 0.1.9
的 daemon（`crates/asd-daemon/src/conn.rs` 的 `Frame::SendInput`）拿到帧之后是
`let _ = handle.tx.send(...)` —— 连排队结果都丢弃 —— 紧接着无条件回 `Ack`；真正写
pty 在之后异步发生，失败只 `debug!` 一行。

所以**任何往 session 里投任务的地方都要走 `deliver()`**，它做三步：
`sendText` → peek 校验文本真的出现在屏幕上 → `key("Enter")`。

两个不能改的细节：

- **校验必须卡在"文本已送、回车未送"那个窗口里。** 回车会清空输入框，按下去之后
  屏幕上有没有这段文本就再也分不出"没送到"和"送到了并且已提交"。
- **校验不过就绝不按回车。** 此刻输入框里可能是别的东西（比如一个模态对话框），
  那一下回车会去确认它 —— claude 的信任对话框默认项是 "2. No, exit"。

投递失败要如实报「任务未投递成功：<原因>」并且**不记台账** —— 记了就等于宣称
"已派出"，正是这次要修掉的病。

### 7. 启动期的模态 UI 要按 preset 过掉

有些 agent 首次在一个目录里启动会弹模态 UI，盖在输入框上层。claude 在**未信任的
目录**里会弹工作目录信任确认，而 pi-asd 给每个新 session 建的正是全新空目录 ——
所以它每次必然撞上。

`AgentPreset` 因此有两个字段：

- `deliver: "argv" | "send"` —— 任务是拼进启动命令，还是裸启动之后打进去
- `startupDialogs` —— 认出来 + 过掉它要按的键

claude 走 `deliver: "send"`（argv 里的 prompt 在对话框后面永远轮不到执行）；
pi / codex 保持 `argv`（没有验证过的替代方案就别改它们，见下）。

没有可用的 CLI 开关：`--dangerously-skip-permissions` 管的是权限不是信任，唯一能
跳过信任确认的是 `-p`/非 TTY 的非交互模式，而子 agent 必须活着接受后续 steer。

### 8. 子 agent 的环境要点名透传，别指望继承

子 agent 是 asd **daemon** fork 出来的，继承的是 daemon 的环境 —— 那个 daemon 可能
是几天前从另一个 shell 起来的，跟 pi 的环境毫无关系。

`ToolConfig.spawnEnv` 由 `index.ts` 从自己的 `process.env` 按名单挑好注入
（`tools.ts` 不读 process.env，这条不变量还在），`withEnv()` 把它拼在启动命令前面。

**两条投递路径都要带**：`buildSpawnCommand`（argv）和裸启动（`deliver: "send"`）。
裸启动那条绕开了 `buildSpawnCommand`，最容易漏 —— 而走它的正是 claude，也正是最
需要 `IS_SANDBOX` 的那个。

踩过的坑：以 root 运行时 `claude --dangerously-skip-permissions` 没有 `IS_SANDBOX=1`
会拒绝启动并**立即退出**，表现为 spawn 出来的 session 一秒消失；缺代理变量则是
起得来但 API 403。

**验证这类问题时，探针本身的环境是最大的陷阱。** 我第一版 e2e 用
`{...process.env}` 起 daemon，而我的 shell 里恰好有那些变量 —— 于是"验证通过"
是假阳性，测的其实是别名版命令。**要验证环境相关的行为，必须显式把环境剥干净**，
不能靠继承。

### 9. 别让工具输出暗示它给不出的结论

（这一条的由来是后来被摘掉的 `asd_agents` —— 见不变量 13。现在的 `asd_list` 为了
避开这个坑只列名字、不展示状态；`asd_candidates` / `asd_peek` 仍受这条约束。）

`asd_agents` 只有终端活动元数据 —— 它**回答不了"任务干成了没有"**。但它以前每行
只写一个 `idle 3m`，boss 就把"安静"读成"完成/失败"，判断不了就**反复重发任务**
（实测踩到过）。

三条对策，缺一不可：
1. **措辞不暗示**：`idle` → `安静`，`running` → `在动`。英文的 idle 自带"闲着=没事
   干=做完了"的联想
2. **给真凭据**：每行带屏幕最后一行（跳过状态栏那种每屏都一样的），卡在对话框上的
   用 `detectDialog()` 单独标出来
3. **明说边界和下一步**：输出底部和工具 description 里都写"这不是成败信号，别据此
   重发任务，要判断结果去 asd_peek"

**通用教训：一个工具如果给不出某个结论，它的输出就不能长得像给出了。** 措辞、字段
选择都会被调用方当成信号。

### 10. settle 之后要连续复核，才分得出「思考中」和「真停下」

`asd follow` 的 settle 只代表"终端安静约 2 秒"。watcher 在报"停下"之前会隔
`SETTLE_CONFIRM_MS`(1.2s) 连续复核两次：baseline 加两次复核必须**三屏一致**；任一屏
变化都表示 agent 还在重绘，整轮作废、安静重挂并从零累计。全部通过后再单独 peek
最终屏幕，用它做对话框识别和通知内容，不能拿确认前的旧画面冒充执行结果；final peek
若与上一屏不同，它本身就是新的活动信号，同样整轮作废重挂，绝不能报停下。

连续变化达到 `MAX_QUIET_REARMS` 上限时只能报「未确认停下」，**绝不能绕过复核谎报
已停下**。这是目前唯一能把两者分开的判据 —— asd 自己给不出。

最终 peek 之后，再用 `dialog.ts` 的 `detectDialog()` 分「等决策」和「真停下」，
两种通知的措辞完全不同：前者必须有人按键、不处理就永远卡着，后者是去读结果。

`detectDialog` 的取舍是**宁可漏认、不可错认**，所以要求「编号选项」和「底部按键
提示」同时出现。漏认只是退回"已停下"（屏幕照样带上）；错认会把 boss 引去对一屏
正常输出按键。

写测试注意：watcher 的夹具默认 `settleConfirmMs: 0`（跳过整段连续复核和 final peek）——
这一组用例大多按 follow/peek 的调用序列断言，多三次 peek 会全部错位。要测复核本身
就显式传一个很小的非零值。

### 11. watcher 的冷启动止损要真的等时间

`asd follow` 对一个已经安静了的 session 是**立即返回**的，重挂一次只要几十毫秒。所以
`EARLY_GRACE_MS`（20 秒宽限期）如果不配上 `EARLY_RETRY_DELAY_MS` 的真实 sleep，10 次重挂
会在不到 1 秒内烧光，宽限期就成了死代码，冷启动稍慢的 agent 照样被误判成「已经停下」。

`WatcherDeps.earlyRetryDelayMs` 只给测试注入 0 用，生产代码永远不传。

`#finish()` 用**身份比较**摘 controller（`this.#running.get(session) === ctrl`），不是按 key
无脑删 —— 一个迟到收尾的旧 watcher 绝不能带走下一代的记录。

### 12. `asd list` 的 `command` 前面会顶着前缀，认 agent 不能只看第一个 token

`agentOfCommand` 是「能不能把任务交给这个 session」那道闸门。它拿到的字符串**不是**
干净的 `<agent> <args>`，实测有两层前缀，两层都不是用户干的：

| 前缀 | 真实样例 | 老实现取到的 |
|---|---|---|
| 解释器（agent 装成脚本时） | `node /root/.nvm/…/bin/codex` | `node` |
| 环境变量赋值 | `HTTPS_PROXY='http://h:31172' … codex '任务'` | `31172'`（basename 切到了端口号） |

第二条是自伤：`asd new --cmd` 交给 `sh -c` 跑，带赋值前缀时 dash 不 exec 自己，前台进程
一直是那个 wrapper，asd 剥掉 `sh -c ` 后报的就是整条命令行 —— 而那个前缀正是 `withEnv`
和 pi 预设的 `PI_SPAWNED=1` 拼的。于是 pi-asd 把**自己 spawn 出来的 agent** 当成了裸 shell。

症状偏偏只打中一半：claude 的启动器是原生 binary，报的就是 `claude …`，一路正常；codex
是 node 脚本，`asd_candidates` 里一个都不出现，`asd_spawn` 指名交给它也被拒。所以很容易
误诊成「codex 特有的毛病」，实际是认 agent 这一处的解析太窄。

修法只放宽**位置**，不放宽判据：从左边剥掉赋值前缀、再至多剥**一层**解释器，剥完那个
token 必须自己就是预设名。不许改成"在命令行里搜有没有预设名"—— 那样 `sh -c 'echo codex'`、
`vim codex.ts` 全会被认成 agent，正是这道闸门要挡的东西。切词要认引号（`A='x y' codex`）。

### 13. `asd_list` 只查全部 session，绝不能拿来当 sleep

旧的 `asd_agents` 仍然**不注册**（`tools.agents()` 的实现还在，只是没接出去）。它只列
pi-asd 台账里的 agent，曾被模型拿来当 sleep：连续调用、看同一份输出、永远不退出。

现在公开的 `asd_list` 是另一条明确需求：**列出 daemon 里的全部 session**，包括用户手建、
没进 pi-asd 台账的。它的成员集合只来自 `asd list --json`，不能悄悄退回 `registry.list()`；
输出只取 session 名，**绝不逐个 peek**。`asd_peek` / `asd_follow` 可以显式点名台账外会话，
但 list 不能借着「补状态」自动把用户手工会话的屏幕批量读出来。

这仍然是只读工具，轮询风险没有凭空消失，所以公开它必须同时守住五道边界：

1. **用途收窄**：只有用户明确要看全部 asd session 时才调用一次；挑能接活的仍用
   `asd_candidates`，看结果仍用 `asd_peek`，等待仍用 watcher / `asd_follow`
2. **只列名字**：不输出 `running` / `idle_ms` / title，不读屏幕，不给调用方猜成败的材料
3. **输出和 description 都明说边界**：这是名字清单，不是状态或等待信号
4. **代码层单次额度**：`createTools` 在第一次 `await` 前同步耗掉额度，挡住并发调用；同一轮
   agent 执行里的后续调用直接拒绝且不再碰 daemon
5. **只在新一轮重置**：`index.ts` 的 `before_agent_start` 调 `resetListAllowance()`；同一轮里的
   工具结果不会重触发它。新的用户/飞书消息或 watcher followUp 开启下一轮才重新放行

别把两个工具混成一回事：`asd_list` 回答「asd 里当前有哪些 session」；内置的「当前
agent」清单回答「这一轮 pi-asd 派了什么、watcher 挂没挂」；两者都回答不了任务成败。

改提示词时仍然**一次都不能出现 `asd_agents`**；提 `asd_list` 时必须和「用户明确要看
全部 session」「只调一次」「不是成败/等待信号」放在一起。有用例钉着这些边界。

## 配置

优先级统一为 **环境变量 > asd.json > 内置默认值**，两个 asd.json 后面的覆盖前面的：

1. `~/.pi/agents/<agent-name>/asd.json` —— agent 级（扩展加载时读）
2. `<项目根>/.pi/asd.json` —— 项目级（`session_start` 里读，目前仅 `bossMode.autoStart` 有效）

字段和环境变量的对应关系见 README 的「配置」一节。

判断「用户设了没」要用 `parseBossDefault()` 返回的 `configured`，**不要用
`process.env.X !== undefined`** —— 后者挡不住 `PI_ASD_BOSS=`（.env 空行、`docker -e VAR=`、
没展开的 shell 变量），空值会把配置文件里的 `autoStart` 无声压掉。

`loadConfig()` 在配置有问题时抛 `ConfigError`。**调用方一律用 `loadConfigSafely()`**：扩展
入口抛 = 整个 pi-asd 加载失败；`session_start` 的 async handler 里抛 = unhandled rejection，
坏掉的 `.pi/asd.json` 会让那个项目起不来 session。

## 生命周期

`session_shutdown` 只掐 watcher，**绝不杀 session** —— 子 agent 照跑，用户可以
`asd attach <名字>` 接管，这是 asd 相对 tmux pane 真正多出来的能力。退出前会跟 `asd list`
对一次账，只报告真正还存活的。

台账只活在进程内存里：主 agent 重启后台账是空的（提示词里的「当前 agent」清单也就空了），
但 session 仍在 `asd list` 里 —— 用 `asd_candidates` 能看到，指名交给它就重新纳入监视。

`/asd:boss-stop` 不杀 agent、不停 watcher，只停止注入提示词。

## 写代码时的口吻

这个仓库的注释密度偏高，而且**注释解释的是「为什么」不是「做了什么」** —— 大量注释在
记录某个反直觉的决定背后踩过的坑（并发窗口、量纲错误、asd 的行为细节）。改动涉及这些
地方时，把新的理由补进去；删掉一条这样的注释之前先确认那个坑真的不存在了。
