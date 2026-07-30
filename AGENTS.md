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
npm test              # node:test，158 个用例，含一个对着真 asd 跑的 e2e
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
                  读 process.env，注册 7 个工具和 2 个斜杠命令。只接线，不放逻辑。
  ├── cli.ts       asd 命令行的薄封装（注入 exec）
  ├── registry.ts  台账：本次 spawn 出来的 agent。纯逻辑，不碰 IO
  ├── watcher.ts   WatcherPool：后台 follow watcher（注入 asd / notify / now）
  ├── reaper.ts    Reaper：按 idle_ms 定时回收空闲够久的自家 session
  ├── tools.ts     7 个工具的逻辑（注入 asd / registry / watchers / config / mkdirp / now）
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

### 1. `createdByUs` —— 用户手建的 session 碰不得

台账里混着两种记录：pi-asd 自己创建的（`asd new` 出来的，`createdByUs: true`），和被指名
交过任务、因此也进了台账的用户 session（`createdByUs: false`）。**「在台账里」不等于
「是自己创建的」**，两道闸门都只认 `createdByUs === true`：

- `Registry.canKill()` —— `asd_kill` 必须先问过它拿到 `ok: true` 才允许执行 `asd kill`
- `Registry.pickReusable()` —— 自动复用池同样只收自己创建的。这里漏掉这一条的后果是：
  指名交过一次任务之后，任何一次**没点名**的 `asd_spawn` 都可能把用户正在用的会话静默
  塞进下一个任务

自动复用**永远不碰台账外的 session**；台账外的只能由主 agent 看过 `asd_candidates` 之后
指名交给它。

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

### 5. watcher 的冷启动止损要真的等时间

`asd follow` 对一个已经安静了的 session 是**立即返回**的，重挂一次只要几十毫秒。所以
`EARLY_GRACE_MS`（20 秒宽限期）如果不配上 `EARLY_RETRY_DELAY_MS` 的真实 sleep，10 次重挂
会在不到 1 秒内烧光，宽限期就成了死代码，冷启动稍慢的 agent 照样被误判成「已经停下」。

`WatcherDeps.earlyRetryDelayMs` 只给测试注入 0 用，生产代码永远不传。

`#finish()` 用**身份比较**摘 controller（`this.#running.get(session) === ctrl`），不是按 key
无脑删 —— 一个迟到收尾的旧 watcher 绝不能带走下一代的记录。

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

台账只活在进程内存里：主 agent 重启后 `asd_agents` 是空的，但 session 仍在 `asd list` 里。

`/asd:boss-stop` 不杀 agent、不停 watcher，只停止注入提示词。

## 写代码时的口吻

这个仓库的注释密度偏高，而且**注释解释的是「为什么」不是「做了什么」** —— 大量注释在
记录某个反直觉的决定背后踩过的坑（并发窗口、量纲错误、asd 的行为细节）。改动涉及这些
地方时，把新的理由补进去；删掉一条这样的注释之前先确认那个坑真的不存在了。

新功能按 TDD 走：`test/` 下每个模块一个测试文件，回归测试在注释里写清楚它守的是哪个 bug。
