# Slash Command 与子命令设计评审（0.8.1）

评审范围：CLI 入口（`src/main.ts`、`src/runtime/bootstrap.ts#parseArgs`、`src/tui/cli.ts`）、命令解析与分发（`src/agent/commands.ts`、`src/tui/commands.ts`、`src/runtime/dingtalk.ts` 忙时路径、`src/runtime/bootstrap.ts#handleEvent` 空闲路径）、session 命令（`src/agent/command-extension.ts`）、子命令实现（`src/runtime/event-commands.ts`、`src/runtime/task-commands.ts`）。

## 结论

**成熟度：中上（约 7/10）。骨架是对的，问题集中在"同一份命令知识散落五处"带来的漂移，以及对错误输入缺兜底。**

做得好的地方，值得保持：

- **两组命令的分层清晰**：transport 命令（`/help /stop /steer /followup /events /tasks /status /usage`）由运行时直接处理，session 命令（`/model /new /compact /session`）经 SDK extension 在 turn 内处理。TUI 借这个分层"免费"复用了全部 session 命令，是这套设计的最大红利。
- **解析器是纯函数且有测试**：`parseBuiltInCommand`、`parseTuiArgs`、`parseTasksCommand`、`parseEventsCommand` 都可独立单测，且实际有测试覆盖。
- **忙时语义完整**：steer/followup/stop + `busyMessageDefault`，加上"窗口关闭则 requeue"的降级路径，是同类系统里少见的细致处理。
- **`/tasks` 子命令的用法校验严格**（多余参数直接报 usage），`approve` 作为显式外部副作用闸门的设计符合个人助手定位。

以下 5 条按优先级排列，前 3 条建议做，后 2 条酌情。

## 1. 命令元数据收敛为一张表（核心建议，做减法）

同一份"有哪些命令、参数是什么、什么时候可用"的知识现在写在 **5 处**：`HELP_TEXT`（`src/agent/commands.ts`）、`TUI_SLASH_COMMANDS`（`src/tui/commands.ts`）、DingTalk 忙时提示字符串（`src/runtime/dingtalk.ts:1276,1284`）、`/tasks` `/events` 各自的 `usage()`、README 命令表。

漂移已经发生：

- `src/tui/commands.ts:88` 的 `/tasks` 自动补全还写着 "read-only"、hint 只有 `[show|archive|doctor]`——落后于现在的 approve/pause/resume/run/stats 整整一个 Task Loop v2。
- `src/runtime/dingtalk.ts:1284` 忙时提示说只有 `/stop /steer /followup /events /tasks` 可用，实际 `/help /status /usage` 忙时也全部可用（上方 if 链就是这么处理的）。

**修法**：在 `src/agent/commands.ts` 建一张命令描述表（`name / argumentHint / description / availableWhileBusy`），`HELP_TEXT`、`TUI_SLASH_COMMANDS`、忙时提示全部从表生成；`parseBuiltInCommand` 的 switch 换成查表。净效果是删代码：三段手写文案变成一张表 + 三个渲染函数。README 表仍手维护但以这张表为准对一遍。

## 2. 未知/打错的命令直接落进 LLM turn

`parseBuiltInCommand` 不认识的 slash 输入（`/modle`、`/hlep`、大写 `/Help`）在空闲时会被当普通消息发给模型——花一整轮 token，模型再猜用户想干什么。SDK 侧只拦截已注册的 extension 命令（`agent-session.js#prompt`），其余照常入 prompt。

另一个同源问题：`parseBuiltInCommand` 用 `indexOf(" ")` 切首词，**换行分隔的命令解析失败**——移动端钉钉里 `/steer⏎修复这个` 会整体变成 `steer\n修复这个`，匹配不上，静默进模型（忙时则收到一条误导性的"only /stop…"提示）。

**修法**（都在 `src/agent/commands.ts` 一个文件内）：

- 切词用 `/\s/` 而非 `indexOf(" ")`；命令名匹配前 `toLowerCase()`。
- 新增一个"已知命令全集"判断（内置 8 个 + session 4 个 + `/skill:` 前缀）。transport 层对 `startsWith("/")` 且首词不在全集内的输入，直接回 `Unknown command: /xxx — see /help`，不进模型。误伤面很小（真想让模型看到 `/` 开头文本的场景几乎不存在，真有也可以加一句"以 `//` 开头可绕过"或干脆不管）。

## 3. DingTalk 忙时路径：死代码 + 8 连 if

`src/runtime/dingtalk.ts:1273` 的 `if (builtInCommand)` 分支不可达——`parseBuiltInCommand` 只可能返回 8 个名字，全部已在上方逐一处理并 return。连同上面 8 个手写 `if (builtInCommand?.name === …)`，这段是最该做减法的地方。

**修法**：删掉 1273–1279 死分支；8 连 if 收敛为查表分发（复用第 1 条的命令表的 `availableWhileBusy` 字段），忙时提示文案由表生成，第 1 条里的文案漂移随之根除。

## 4. CLI 入口对错误输入太宽容

- `pipiclaw <任意打错的词>` 会**静默启动常驻 daemon**（`main.ts` 只认 `argv[2] === "tui"`，其余全走 bootstrap；`parseArgs` 对未知参数不报错）。打错子命令的代价是拉起一个长驻进程。
- `pipiclaw --help` 完全不提 `tui` 子命令——TUI 是主要交互面之一，但从主入口不可发现。
- `parseTuiArgs` 把未知 flag 归入 positional：`pipiclaw tui --pritn 你好` 会把 `--pritn` 当成 prompt 的一部分发给模型。

**修法**：`main.ts` 显式分派（无参 → daemon；`tui` → TUI；其他 → 报错 + help，exit 1）；`parseArgs` 的 help 文案加一段 `Commands: (default) run the DingTalk daemon / tui — interactive terminal chat`；`parseTuiArgs` 对 `--` 开头的未知参数直接报错。三处都是十行以内的改动。

## 5. 分层分发缺编译期兜底（低优先）

`BuiltInCommandName` 有 8 个名字，但 `ChannelRunner.handleBuiltinCommand` 的 switch 只处理 4 个、无 default——另外 4 个（events/tasks/status/usage）靠 bootstrap 和 dingtalk 在上游截胡。今后往 `parseBuiltInCommand` 加第 9 个命令时，若忘了在上游接线，会落进 runner 的 switch、无 case 命中、**静默无任何回复**。

**修法**：二选一，推荐前者——把 `handleBuiltinCommand` 的参数类型收窄为 `Extract<BuiltInCommandName, "help" | "stop" | "steer" | "followup">` 对应的命令类型，让"哪 4 个归 runner"成为编译期事实；或在 switch 加 `default` 走 `assertNever`。

## 不建议做的

- 不要引入命令框架（commander/yargs 之类）：入口只有 daemon/tui 两个形态，手写分派 + 上面第 4 条足够。
- 不要把 session 命令并入 transport 层统一路由：现在"session 命令随 turn 走"让 TUI 零成本复用，合并只会增加耦合。
- 命令回复的中英文混用（`命令执行失败` vs "No task is running"）可以在做第 1 条时顺手统一成一种，不值得单独立项。
