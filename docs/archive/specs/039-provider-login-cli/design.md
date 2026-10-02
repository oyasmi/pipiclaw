# Provider 登录：`pipiclaw auth` CLI 子命令

| 字段 | 值 |
|------|------|
| 状态 | PROPOSED |
| 日期 | 2026-08-04 |
| 前置 | 035 config-and-api-surface（app 目录与公共 API 边界） |
| 产品裁决 | 凭据登录是**运维动作**，只在独立 CLI 子命令暴露；钉钉端永不提供登录入口，TUI 本期也不内嵌 |
| 关联实现 | `src/models/{provider-login,login-ui,auth-cli}.ts`（新）、`src/shared/open-browser.ts`（新）、`src/models/utils.ts`、`src/main.ts` |
| 关联文档 | `docs/configuration.md`（凭据与代理章节）、`docs/architecture.md`、`README.md` |

## 1. 决策摘要

1. **新增 `pipiclaw auth login|logout|status` 子命令**，走 SDK 已有的 `ModelRuntime.login(providerId, authType, AuthInteraction)`。打通 OAuth 订阅类 provider（`openai-codex` = ChatGPT Plus/Pro、`anthropic` = Claude Pro/Max、`github-copilot`、`kimi-coding`、`xai`、`openrouter` 等）以及交互式 API key 录入。
2. **只做 CLI，不改 TUI，不改钉钉。** 登录是短进程、一次性的运维动作；它不需要 runner、session、记忆层或频道目录，也不应该与流式回合争抢输入焦点。
3. **凭据写到 `APP_HOME_DIR/auth.json`（默认 `~/.pipiclaw/auth.json`），不会落到 `~/.pi/agent/auth.json`**——因为 pipiclaw 已经显式传 `authPath`。这不是要新做的事，而是要用护栏**锁住**的事（§4）。
4. **登录编排（`provider-login.ts`）与人机界面（`LoginUi`）分离**。本期只有 readline 一个实现；将来若要 TUI `/login`，只需另写一个 `LoginUi`，编排代码不改（§10）。

## 2. 现状与差距

### 2.1 SDK 侧已经完全就绪

- `pi-ai` 内置 `openai-codex` provider（`node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js`）：`baseUrl` 为 `https://chatgpt.com/backend-api`，**只有 `oauth` 一种认证方式，没有 `apiKey`**——不登录时它的模型根本不出现在 `getAvailable()` 里，登录后自动出现，`/model` 直接可选。
- OAuth 流程在 `pi-ai/dist/auth/oauth/openai-codex.js`，名称 `"OpenAI (ChatGPT Plus/Pro)"`，第一步是一个 `select`：`browser`（PKCE + 本地 `127.0.0.1:1455/auth/callback` 回调，同时开一个"手工粘贴 code / redirect URL"的 `manual_code` prompt 与回调服务器竞速）或 `device_code`（无头，轮询 `auth.openai.com/api/accounts/deviceauth/token`，15 分钟超时）。成功后从 access token 的 JWT 里取 `chatgpt_account_id` 存进凭据。
- `ModelRuntime.login(providerId, type, interaction)`（`pi-coding-agent/dist/core/model-runtime.js:352`）= `models.login()` 落盘 + `refresh()`。`logout()`、`listCredentials()`、`getProviderAuthStatus()`、`isUsingOAuth()` 一并具备。
- 交互契约 `AuthInteraction { signal?, prompt(AuthPrompt): Promise<string>, notify(AuthEvent): void }`；`AuthPrompt` 有 `text | secret | select | manual_code` 四型（外加逐 prompt 的 `signal`，用于回调服务器赢了竞速时撤掉粘贴框），`AuthEvent` 有 `info | auth_url | device_code | progress` 四型。

### 2.2 pipiclaw 侧缺的就是"交互"

`src/models/utils.ts:14` 的 `createModelRuntime` 只传 `authPath`/`modelsPath`；`src/agent/channel-runner.ts:985` 构造 `AgentSession` 时也不传任何 `AuthInteraction`；`src/agent/commands.ts` 的两张命令表里没有 `login`。**唯一缺的是一个能 prompt/notify 的界面，以及把它接到 `ModelRuntime.login` 的胶水。**

`docs/configuration.md` 只在第 223 行顺带提过 Codex（代理不覆盖 WS transport），没有任何订阅登录说明——文档同样要补。

## 3. 产品裁决：为什么是独立 CLI，而不是钉钉、也不是 TUI

### 3.1 钉钉端：永不提供

1. **OAuth 浏览器流需要与终端同机的浏览器和 `localhost:1455`**。钉钉是远程 IM，用户点开的 URL 会把回调打到用户自己的机器，而回调服务器在服务器进程里，天然对不上。
2. **群聊里粘贴 authorization code / API key 等同于泄露凭据**：消息会进钉钉服务端、进 `log.jsonl`、进记忆层，且无法撤回。
3. **凭据是进程级、全实例共享的资源**，不是频道级。钉钉命令自带频道语义，会让人误以为"这个群登录了、那个群没有"。
4. **登录带 15 分钟量级的阻塞等待**，与 `ChannelQueue` 的"一个频道一次一回合"冲突，一次登录会把整个频道堵死。

因此 `login` 不进 `BUILT_IN_COMMANDS`，钉钉侧 `isKnownCommandName()` 继续按未知命令拒绝。加回归测试锁死。

### 3.2 TUI：本期不做，因为 CLI 严格更简单

真实场景是"SSH 上服务器，登录一次，退出"。CLI 直接对上这个场景，并且把 TUI 方案里最贵、最容易出错的部分整块省掉：

| 关注点 | 独立 CLI | TUI `/login` |
|---|---|---|
| 输入焦点 | 进程独占 stdin | 要在 `editorContainer` 里换出编辑器、保存/恢复焦点 |
| 取消 | Ctrl-C = SIGINT = 进程退出，回调服务器随进程消亡 | 要在 `pitui-frontend.ts:108` 的全局 Ctrl-C 拦截里插一个模式，且不能破坏 `turn-controller.ts:250` 的两段式退出策略 |
| 粘贴框与回调竞速 | `readline/promises.question(q, { signal })` 原生支持 AbortSignal（Node 22 已验证） | 要自己在模态组件里实现逐 prompt 取消 |
| 密文输入 | readline 静音输出 | pi-tui 的 `Input` 无掩码选项，需自写掩码组件 |
| 与回合互斥 | 不存在 | 要判 `runner.isBusy()`，并处理 `--print` 非交互路径 |
| 接口涟漪 | 无 | `AgentRunner` 加方法打断 3 处测试 fake（`tui-turn-controller.test.ts` 的 `FakeRunner`、`runtime-stop.test.ts` 两处），`Frontend` 加方法再打断 1 处 |
| 启动成本 | `bootstrapAppHome` + `prepareAppServices` + `createModelRuntime` | 完整 runner/session/记忆层 |

而 TUI 内嵌能省下的东西其实很有限：**任何进程都要重启才能看见新凭据**（§8），TUI 自己也不例外。

## 4. 凭据存放位置：现状正确，但要加护栏

### 4.1 现状（不需要改）

`AuthStorage.create(authPath)` 只有在 `authPath` 为 `undefined` 时才回落到 `join(getAgentDir(), "auth.json")`（即 `~/.pi/agent/auth.json`）。pipiclaw 的每条链路都显式传了路径：

```
paths.ts: AUTH_CONFIG_PATH = join(APP_HOME_DIR, "auth.json")
  → bootstrap.ts: DEFAULT_BOOTSTRAP_PATHS.authConfigPath
    → runner-factory / maintenance-context → createModelRuntime({ authConfigPath })
      → ModelRuntime.create({ authPath }) → AuthStorage.create(authPath)
```

`PIPICLAW_HOME` 自动跟随。所以 `ModelRuntime.login()` 写入的就是 `~/.pipiclaw/auth.json`，与现有 `{"anthropic": {"type":"api_key","key":"..."}}` 同文件同格式（新增的 OAuth 项形如 `{"openai-codex":{"type":"oauth","access":"…","refresh":"…","expires":1234,"accountId":"…"}}`）。权限也已对齐：bootstrap 以 `0o600` 创建，SDK 每次写入后同样 `chmod 600`。

### 4.2 需要新增的护栏（本 spec 交付项）

风险不在"会不会写错"，而在"以后有人调了一个带默认值的 SDK API 就悄悄写错"：

1. `createModelRuntime` 入口加断言：`authConfigPath` 必须非空且为绝对路径，不允许隐式回落。
2. **禁用清单**（写进模块注释）：不得调用 `getAuthPath()` / `getAgentDir()` / 无参数的 `readStoredCredential()`；不得设置 `PI_CODING_AGENT_DIR`（它会整体挪走 SDK 默认目录，掩盖问题）。
3. `test/models-auth-path.test.ts`：断言 `AUTH_CONFIG_PATH` 落在 `APP_HOME_DIR` 下、`PIPICLAW_HOME` 生效时同步移动；断言登录编排写入后变化的是该文件而非 `~/.pi/agent/auth.json`。
4. `pipiclaw auth status` 直接打印生效的 auth.json 绝对路径，让运维一眼可验。

## 5. 架构设计

### 5.1 分层

```
src/main.ts                 新增 `auth` 分支（保持薄）
src/models/auth-cli.ts      参数解析 + 子命令分发 + 结果渲染（对标 src/tui/cli.ts）
src/models/login-ui.ts      readline 版 LoginUi（AuthPrompt/AuthEvent ⇄ 终端）
src/models/provider-login.ts  传输中立的编排（不 import 任何终端代码）
src/shared/open-browser.ts  尽力打开浏览器，失败静默
```

启动只需 `bootstrapAppHome(paths, io)` + `prepareAppServices(paths)`（后者顺带装好代理，见 §7）+ `createModelRuntime({ authConfigPath, modelsConfigPath })`。不构造 runner、session、记忆调度器、频道目录。

### 5.2 `src/models/provider-login.ts`

```ts
import type { Api, AuthEvent, AuthPrompt, AuthType, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export class LoginCancelledError extends Error {}

/** 人机交互面。本期只有 readline 实现；TUI 模态将来可另实现一份。 */
export interface LoginUi {
	/** 取消时 reject(LoginCancelledError)。select 返回 option id。 */
	ask(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
	/** 整个流程的取消信号（SIGINT）。 */
	signal: AbortSignal;
}

export interface ProviderLoginOption {
	id: string;
	name: string;
	authType: AuthType;
	/** OAuth 的订阅登录文案，如 "OpenAI (ChatGPT Plus/Pro)"。 */
	loginLabel?: string;
	configured: boolean;
	configuredAs?: AuthType;
	source?: string;
}

export interface ProviderLoginResult {
	providerId: string;
	credentialType: AuthType;
	/** 登录后新可用的模型（前后 getAvailable 差集）。 */
	newModels: Model<Api>[];
}

export function listProviderLoginOptions(runtime: ModelRuntime, authType?: AuthType): ProviderLoginOption[];
export async function loginProvider(runtime: ModelRuntime, providerId: string, authType: AuthType, ui: LoginUi): Promise<ProviderLoginResult>;
export async function logoutProvider(runtime: ModelRuntime, providerId: string): Promise<void>;
export async function renderAuthStatus(runtime: ModelRuntime, authPath: string): Promise<string>;
```

- `listProviderLoginOptions` 遍历 `runtime.getProviders()`，对每个 provider 按 `provider.auth.oauth` / `provider.auth.apiKey` 各产出一条，配合 `getProviderAuthStatus(id)`（`{configured, source?, label?}`）与 `isUsingOAuth(id)` 标注状态，按 `name` 排序。
- `loginProvider` 先取 `runtime.getAvailableSnapshot()`，调用 `runtime.login(providerId, authType, { signal: ui.signal, prompt: (p) => ui.ask(p), notify: (e) => ui.notify(e) })`，再取一次快照做差集得到 `newModels`（`login()` 内部已 `refresh()`）。
- 取消语义：`LoginCancelledError` 向上冒泡，不写任何文件（`credentials.modify` 在 `login()` 拿到凭据之后才执行）。
- 错误分类：`ModelsError`（code `auth`/`oauth`/`provider`）与网络错误统一转成人话，末尾带下一步（例如 device code 超时 → "重新执行 pipiclaw auth login 并在 15 分钟内完成"）。

### 5.3 `src/models/login-ui.ts`（readline 实现）

用 `node:readline/promises`。四类 prompt 的映射：

| AuthPrompt | 终端行为 |
|---|---|
| `select` | 打印带序号的选项（附 `description`），读数字；回车取默认第一项；非法输入重问 |
| `text` | `rl.question(message)`，`placeholder` 作为 `(例如：…)` 提示 |
| `secret` | 同上但静音回显（替换 `rl._writeToOutput` 或用 muted Writable），提交后不回显内容 |
| `manual_code` | 同 `text`，且**必须**把 `prompt.signal` 透传给 `rl.question(q, { signal })`——回调服务器赢了竞速时 SDK 会 abort 它，Node 22 原生支持，abort 后安静收尾不报错 |

`AuthEvent` 的渲染：`auth_url` 打印 URL（OSC 8 超链接）并调用 `openBrowser()`；`device_code` 打印 `verificationUri` + 醒目的用户码 + 有效期；`info` 打印文本与链接；`progress` 打印单行进度。**全部走 stderr**，让 stdout 只承载可被脚本消费的结果。

顶层安装一次 SIGINT handler → `AbortController.abort()` → `LoginCancelledError` → 打印"已取消"并以 130 退出。回调服务器在进程内，随进程消亡，无需额外清理。

### 5.4 `src/models/auth-cli.ts`

对标 `src/tui/cli.ts`：`parseAuthArgs(args)` 是纯函数（可单测），`runAuth(argv, io)` 负责装配。

```
pipiclaw auth status
pipiclaw auth login [provider] [--api-key] [--oauth] [--device-code] [--no-browser]
pipiclaw auth logout [provider] [--yes]
```

- **`status`**：表格列出每个 provider 的 `configured` / 凭据类型 / 来源标签，末尾打印 auth.json 绝对路径、`runtime.getError()`（models.json 解析错误，若有）、以及"守护进程需重启"提示。
- **`login`**：无参数 → 先问认证类型（订阅 OAuth / API key，文案取 `loginLabel`），再选 provider；带 provider 参数 → 按 id 或 name 精确匹配（大小写不敏感），唯一命中且只有一种认证方式则直接开始，命中同一 provider 的两种方式则只问类型。`--oauth`/`--api-key` 跳过类型选择。`--device-code` 是**给 SDK 那个 select 的预设答案**（`LoginUi` 对首个 select 若已有预设则直接返回，不再打断），供脚本化与无头场景使用。`--no-browser` 只打印 URL 不尝试打开。
- **`logout`**：候选来自 `listCredentials()`，为空时提示"没有已保存的凭据"。删除前二次确认（`--yes` 跳过）。
- 成功输出：provider 名 + 凭据类型 + 新可用模型列表 + 下一步（`pipiclaw tui` 里 `/model <ref>`，或写进 `settings.json` 的 `defaultProvider`/`defaultModel`）。**不自动改默认模型**——CLI 是独立运维动作，静默改运行时默认值不合适；改为打印可直接复制的配置片段。
- 退出码：成功 0、用法错误 1（`BootstrapExitError`）、登录失败 2、用户取消 130。

`src/main.ts` 加一个分支即可，仍然只做分发：

```ts
} else if (command === "auth") {
	runAuth(process.argv).then(() => process.exit(0), handleError);
}
```

## 6. 典型流程：ChatGPT Plus/Pro

```
$ pipiclaw auth login
  ? 认证方式: 1) 订阅登录（OAuth）  2) API key
  ? provider: 1) Anthropic • 已配置(OAuth)  2) OpenAI Codex • 未配置  …
  ? Select OpenAI Codex login method: 1) Browser login  2) Device code login (headless)
    ├ Browser: 打印 URL + 尝试打开浏览器；同时给出粘贴框
    │          回调服务器 127.0.0.1:1455 与粘贴框竞速，任一先到即取消另一个
    └ Device : 打印 https://auth.openai.com/codex/device + 用户码，轮询至授权（15 分钟超时）
  → 交换 code → 从 JWT 取 chatgpt_account_id → 写 ~/.pipiclaw/auth.json (0600)
  ✓ 已登录 OpenAI Codex（订阅，账号 …a1b2）
    新可用模型: openai-codex/gpt-5.4, openai-codex/gpt-5.3-codex-spark …
    钉钉守护进程需重启后才会使用新凭据。
```

## 7. 无头 / 远程与代理

| 场景 | 做法 |
|---|---|
| SSH 到服务器，本地有浏览器 | 优先 `--device-code`：手机/本地浏览器打开 `auth.openai.com/codex/device` 输入用户码，服务器端轮询取凭据，不需要回调端口 |
| 一定要走 browser 流 | `ssh -L 1455:127.0.0.1:1455 …` 转发回调端口，再在本地浏览器打开打印出的 URL |
| 回调需绑非环回地址 | SDK 支持 `PI_OAUTH_CALLBACK_HOST`（默认 `127.0.0.1`）。文档标注为**有风险**：授权码会在非环回接口上明文经过，仅限可信内网 |
| 1455 被占用 | SDK 的 `listen` 失败会让回调路径永远返回 null，**粘贴框仍然可用**——所以 browser 流必须始终显示粘贴框，不能因为"已打开浏览器"就省略 |

代理：

- **登录流量走 `fetch`**（`auth.openai.com` 的 authorize/token/device 端点），受 `installLlmProxy()` 安装的 undici 全局 dispatcher 管辖。`auth-cli` 调用 `prepareAppServices()`（`bootstrap.ts:1212` 内即装代理），所以 **`PIPICLAW_PROXY` 对登录有效**。
- **回调服务器**监听本机端口，与代理无关。
- **登录成功 ≠ 能用**：`openai-codex-responses` 的模型请求默认走 WebSocket transport，该 transport 用独立 HTTP 客户端、只认标准 `HTTP_PROXY`/`HTTPS_PROXY`（`docs/configuration.md:223`），失败才回落 SSE。因此登录成功后若检测到"设了 `PIPICLAW_PROXY` 但没设 `HTTPS_PROXY`"，结束语必须显式告警：Codex 对话流量可能仍然直连。

## 8. 多进程：其它进程什么时候看到新凭据

- `AuthStorage` 构造时把 `auth.json` 读进内存 `this.data`，`read()` 只读这份快照；只有 `modify()`/`delete()` 才在文件锁内重新读盘。
- 因此 **CLI 登录后，正在运行的守护进程和 TUI 都不会自动获得新 provider**。登录成功文案与 `auth status` 输出都要复述"需重启"。
- 反过来，**token 轮换是跨进程安全的**：OAuth 刷新走 `credentials.modify()`，在 `proper-lockfile` 文件锁内以**盘上当前值**为准（`pi-ai/dist/auth/resolve.js` 的双检锁），所以守护进程不会拿着内存里的旧 refresh token 去换，也不会与 CLI 互相打成 `invalid_grant`。
- **本 spec 不自研 `CredentialStore`**：`AuthStorage` 未从 `@earendil-works/pi-coding-agent` 包入口导出，其 `exports` map 只开放 `.` 与 `./rpc-entry`，深路径导入被 Node 解析规则挡住；自己重写带跨进程锁的凭据存储属于复制 SDK 关键路径，写坏 auth.json 的风险远大于"少重启一次"的收益。

## 9. 安全

- 凭据只经由 SDK 写入 `auth.json`（0600），pipiclaw 自己不复制、不缓存、不落日志。
- `secret` 输入静音回显，提交后不回显内容；`auth login` 全程不进 `log.jsonl`、不进记忆层（CLI 根本不加载这些组件）。
- 审计：登录/登出各写一条 `src/security/logger.ts` 事件，只含 `providerId`、`authType`、时间、结果，**不含任何 token 片段**。
- 成功输出不打印 access/refresh token，`accountId` 只显示后 4 位（便于确认账号）。
- `auth_url` 含 PKCE challenge 与 state，非长期机密，但同样只打印到 stderr、不落盘。

## 10. 将来若要 TUI `/login`

不需要重新设计：`LoginUi` 是传输中立接口，TUI 只需另写一份基于模态的实现，`provider-login.ts` 一行不改。届时的增量是——`Frontend` 契约扩展与两个实现、pi-tui 模态组件、掩码输入组件、Ctrl-C 语义与 `TurnController` 忙碌互斥。作为独立 spec 评估，本期不做。

## 11. 边界情况

| 情况 | 行为 |
|---|---|
| stdin 非 TTY（管道/CI） | 拒绝并提示需要交互式终端；`--device-code` 也不例外（仍需读取选择与确认） |
| SIGINT | `LoginCancelledError` → 打印"已取消" → 退出码 130，不写任何文件 |
| 1455 被占用 | 回调路径失效，粘贴框继续可用 |
| state 不匹配 | SDK 抛 "State mismatch"，原样呈现并建议重新登录 |
| device code 15 分钟超时 | 提示重新执行并在有效期内完成 |
| JWT 缺 `chatgpt_account_id` | SDK 抛 "Failed to extract accountId"；提示确认账号是否具备 Codex 权限（免费账号没有） |
| `logout` 无已存凭据 | 提示"没有已保存的凭据"，退出码 0 |
| provider 只有 ambient api_key（如 bedrock） | `provider.auth.apiKey.login` 缺失时不进登录流，改为说明"该 provider 使用环境凭据"并指向文档 |
| 登录后模型仍不可见 | `auth status` 打印 `runtime.getError()` 与 auth.json 路径以便排查 |

## 12. 测试

- `test/provider-login.test.ts`（新）：fake `ModelRuntime` 驱动 `listProviderLoginOptions` / `loginProvider` / `logoutProvider`——覆盖 select→device_code 成功、取消（`LoginCancelledError` 且不写盘）、`newModels` 差集、`ModelsError` 人话化。
- `test/auth-cli.test.ts`（新）：`parseAuthArgs` 的全部形态（含 `--oauth`/`--api-key`/`--device-code`/`--no-browser`/`--yes`、未知选项拒绝）；`status` 渲染；退出码。
- `test/login-ui.test.ts`（新）：以内存 stdin/stdout 驱动四类 prompt；重点覆盖 `manual_code` 在 `signal` abort 后安静收尾；`secret` 不回显。
- `test/models-auth-path.test.ts`（新）：§4.2 的路径护栏。
- `test/commands.test.ts`（扩）**回归**：`parseBuiltInCommand("/login")` 仍返回 `null`、`isKnownCommandName("login")` 仍为 `false`（钉钉边界）。

## 13. 文档更新

- `docs/configuration.md`：新增"订阅登录（OAuth provider）"一节——支持哪些 provider、`pipiclaw auth login` 用法、凭据落在 `~/.pipiclaw/auth.json`、无头服务器怎么办、其它进程需重启、Codex 模型流量的代理注意事项（与第 223 行既有说明互相链接）。
- `docs/architecture.md`：补充 `pipiclaw auth` 作为第三个入口（daemon / tui / auth）及其"不加载 runtime"的定位。
- `README.md`：命令表加入 `pipiclaw auth`。
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md`。

## 14. 非目标

- 钉钉端任何形式的登录入口。
- 本期的 TUI `/login`（见 §10）。
- 同一 provider 的多账号 / 账号切换（SDK 的 `CredentialStore` 是 provider → 单凭据）。
- 把凭据转存到 keychain、Vault 或其它后端。
- 修改 `auth.json` 格式，或为 OAuth 增加 pipiclaw 私有字段。
- 让 `settings.json` 承载任何凭据或登录开关（违反 spec 035 的"只放产品意图"约束）。
- 登录后自动改写默认模型（只打印可复制的配置片段）。
