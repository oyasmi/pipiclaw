# Spec 006: Pipiclaw Web Tools Implementation Plan

## Status

Draft

## Goal

基于 [design.md](./design.md) 为 Pipiclaw 落地一套可发布的 `web_search` / `web_fetch` 实现，并同步完成：

1. 新的 `tools.json` 配置入口
2. 统一且可预期的代理行为
3. SSRF / redirect 安全边界
4. 主代理与子代理的工具接入
5. 可回归的测试覆盖

这份计划是实现导向文档，不再重复设计取舍，重点回答三件事：

1. 先改什么，后改什么
2. 每一阶段具体改哪些文件
3. 每一阶段以什么标准算完成

---

## Implementation Principles

### 1. 先收口基础设施，再加工具

`web_search` / `web_fetch` 不是两个孤立文件，而是建立在配置、代理、安全、HTTP client、prompt 集成上的能力。

因此实现顺序必须是：

1. 配置与路径
2. 代理行为
3. 安全边界
4. web 基础设施
5. 搜索与抓取工具
6. 运行时接入
7. 测试与文档

### 2. 不把 web 特殊逻辑散落到现有模块

新增能力应主要收敛到：

- `src/web/`
- `src/tools/`
- `src/security/`

已有模块只做接入，不承载 web 领域细节。

### 3. 默认行为必须对用户直观

本轮计划明确采用：

1. `tools.json` 负责 web tools 配置
2. `tools.web.proxy` 有值时覆盖 web 请求代理
3. 未设置 `tools.web.proxy` 时，web 请求继承 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`
4. DingTalk runtime 也继承同一套环境变量
5. `DINGTALK_FORCE_PROXY` 直接删除，不保留兼容逻辑

### 4. 每一阶段都应可单独验证

每个阶段结束都至少要满足：

1. `npm run typecheck`
2. 对应测试文件通过
3. 不引入新的配置歧义或跨模块耦合

---

## Deliverables

最终应交付：

1. `web_search` 工具
2. `web_fetch` 工具
3. `tools.json` loader、默认模板、路径常量
4. `src/web/` 下完整的 provider / fetch / extract / format 实现
5. `src/security/network.ts` 与对应配置扩展
6. 主代理、子代理、prompt、bootstrap 的集成修改
7. 完整的 unit / integration 测试
8. README 与 `docs/` 文档更新

---

## Phase 0: Configuration Entry Point

### Task 0.1 增加 `tools.json` 路径常量

内容：

- 修改 `src/paths.ts`
- 增加 `TOOLS_CONFIG_PATH`
- 保持 `APP_HOME_DIR` / `WORKSPACE_DIR` 现有语义不变

验收标准：

- 运行时代码和测试都能通过统一常量引用 `tools.json`
- 不需要手写 `"tools.json"` 字符串到处拼路径

### Task 0.2 bootstrap 创建 `tools.json` 模板

内容：

- 修改 `src/runtime/bootstrap.ts`
- 扩展 `BootstrapPaths`
- 在 app home 初始化时创建默认 `tools.json`
- 默认模板至少包含：

```json
{
  "tools": {
    "web": {
      "enable": true,
      "search": {
        "provider": "duckduckgo"
      }
    }
  }
}
```

验收标准：

- 新初始化实例会自动生成 `tools.json`
- 二次运行 bootstrap 保持幂等
- `test/bootstrap.test.ts` 补充覆盖

### Task 0.3 为 web tools 增加独立配置 loader

内容：

- 新建 `src/tools/config.ts`
- 定义并导出：
  - `PipiclawToolsConfig`
  - `PipiclawWebToolsConfig`
  - `PipiclawWebSearchConfig`
  - `PipiclawWebFetchConfig`
- 实现：
  - 默认值合并
  - 基础类型校验
  - `maxResults` 限制在 `1-10`
  - `provider` 枚举校验
  - `tools.web.enable` 默认为 `true`

建议接口：

```ts
export function loadToolsConfig(appHomeDir?: string): PipiclawToolsConfig
export function getToolsConfigPath(appHomeDir?: string): string
```

验收标准：

- 非法 JSON 或错误字段类型时回退默认配置并打印警告
- `test/tools-config.test.ts` 新增覆盖
- 不修改 `src/settings.ts` 的职责

---

## Phase 1: Proxy Behavior Cleanup

### Task 1.1 删除启动时清理代理环境变量的行为

内容：

- 修改 `src/runtime/bootstrap.ts`
- 删除 `sanitizeProxyEnv()` 及其调用链
- 删除 `DINGTALK_FORCE_PROXY` 相关逻辑

验收标准：

- 进程中的标准代理环境变量不再被启动逻辑删除
- `test/bootstrap.test.ts` 增加回归测试

### Task 1.2 删除 DingTalk runtime 默认禁用 axios proxy 的行为

内容：

- 修改 `src/runtime/dingtalk.ts`
- 删除：

```ts
if (process.env.DINGTALK_FORCE_PROXY !== "true") {
  axios.defaults.proxy = false;
}
```

验收标准：

- DingTalk runtime 不再篡改全局 `axios.defaults`
- `test/dingtalk.test.ts` 增加回归测试

### Task 1.3 明确 web 请求代理优先级

内容：

- 在 `src/web/config.ts` 或 `src/web/client.ts` 中定义代理解析逻辑
- 优先级固定为：
  1. `tools.web.proxy`
  2. `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`
  3. 直连

验收标准：

- 有单元测试覆盖三种分支
- 逻辑只出现在一个地方，不分散到 provider 内部

---

## Phase 2: Network Security Foundation

### Task 2.1 扩展安全配置模型

内容：

- 修改 `src/security/types.ts`
- 修改 `src/security/config.ts`
- 扩展 `security.json` 配置：
  - `networkGuard.enabled`
  - `networkGuard.allowedCidrs`
  - `networkGuard.allowedHosts`
  - `networkGuard.maxRedirects`

验收标准：

- `loadSecurityConfig()` 能返回完整默认值
- `test/security-config.test.ts` 增加 network guard 覆盖

### Task 2.2 实现网络目标校验器

内容：

- 新建 `src/security/network.ts`
- 实现：
  - URL 解析
  - scheme 校验，仅允许 `http:` / `https:`
  - DNS 解析后的内网/回环/链路本地地址阻断
  - `localhost` 及常见 metadata 地址阻断
  - redirect 后最终地址再次校验
  - `allowedCidrs` / `allowedHosts` 例外处理

建议接口：

```ts
export interface NetworkGuardContext {
  config: SecurityConfig
}

export function validateNetworkTarget(url: string, context: NetworkGuardContext): Promise<void>
export function validateRedirectTarget(url: string, context: NetworkGuardContext): Promise<void>
```

验收标准：

- 对 `localhost`、`127.0.0.1`、`169.254.169.254` 有明确阻断
- 能覆盖“域名解析后落到私网”的情况
- 新增 `test/web-fetch-security.test.ts`

### Task 2.3 接入审计日志

内容：

- 复用 `src/security/logger.ts`
- 为 network guard 阻断增加审计事件
- 保持日志格式与已有 security 审计风格一致

验收标准：

- 阻断会留下可定位的日志记录
- 成功请求不产生噪音日志

---

## Phase 3: Web Core Infrastructure

### Task 3.1 新建 `src/web/config.ts`

内容：

- 负责从 `src/tools/config.ts` 派生出 web 运行时配置
- 处理默认值、参数范围、`maxChars` / `timeoutMs` / `maxImageBytes`
- 不读取 `settings.json`

验收标准：

- web 领域不直接依赖 bootstrap 细节
- 配置归一化逻辑集中在一个模块

### Task 3.2 新建统一 HTTP client 工厂

内容：

- 新建 `src/web/client.ts`
- 封装所有对外 HTTP 请求
- 职责包括：
  - 超时
  - redirect 上限
  - 代理解析
  - 请求头设置
  - 文本 / 二进制响应处理
  - 调用前与 redirect 后的 network guard 校验

实现建议：

- 默认继续使用 `axios`，但只能通过 `src/web/client.ts` 使用
- 若 `tools.web.proxy` 有值，显式创建 proxy agent
- 如需补充依赖，在 `package.json` 中加入：
  - `@mozilla/readability`
  - `jsdom`
  - `http-proxy-agent`
  - `https-proxy-agent`
  - `socks-proxy-agent`
  - 一个稳定的 DuckDuckGo 搜索库

验收标准：

- provider 与 fetch 主流程都不直接 `axios.get(...)`
- `test/web-client.test.ts` 或并入相关测试文件覆盖代理与 redirect 行为

### Task 3.3 新建输出格式化层

内容：

- 新建 `src/web/format.ts`
- 统一生成：
  - 搜索结果文本
  - fetch 文本 banner
  - `details` 元数据

验收标准：

- `web_search` / `web_fetch` 输出风格一致
- “外部内容不可信” banner 文案集中定义，不在工具里散落重复字符串

---

## Phase 4: `web_search` Implementation

### Task 4.1 实现 provider 抽象

内容：

- 新建 `src/web/search-providers.ts`
- 定义统一返回结构：

```ts
export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchProvider {
  search(query: string, options: SearchOptions): Promise<WebSearchResult[]>
}
```

- 实现 provider：
  - `duckduckgo`
  - `brave`
  - `tavily`
  - `jina`
  - `searxng`

验收标准：

- provider 差异被封装在 adapter 内
- 上层不用关心不同 API 的字段形状

### Task 4.2 实现搜索调度器

内容：

- 新建 `src/web/search.ts`
- 负责：
  - 根据 `tools.web.search.provider` 选择 provider
  - 应用 `maxResults`
  - provider 错误归一化
  - 必要时 fallback 到 `duckduckgo`

建议 fallback 策略：

1. 默认 provider 是 `duckduckgo`
2. `brave` / `tavily` / `jina` 在缺少 `apiKey` 时直接报配置错误，不静默降级
3. 只有明确设计好的“可恢复错误”才 fallback，例如 provider 5xx 或超时

这样更清晰，也更容易测试。

验收标准：

- 配置错误与 provider 运行时错误有不同提示
- 搜索结果总是返回统一结构

### Task 4.3 实现 `web_search` 工具

内容：

- 新建 `src/tools/web-search.ts`
- schema 参数：
  - `label`
  - `query`
  - `count`
- 调用 `src/web/search.ts`
- 输出 `content + details`

验收标准：

- 无结果时返回正常文本
- 运行错误时给出清晰、可定位的报错
- 新增 `test/web-search.test.ts`

---

## Phase 5: `web_fetch` Implementation

### Task 5.1 实现页面抓取调度器

内容：

- 新建 `src/web/fetch.ts`
- 流程：
  1. 校验 URL
  2. 拉取响应
  3. 判定内容类型
  4. 分流到 HTML / JSON / text / image
  5. 统一格式化输出

验收标准：

- redirect 最终 URL 会再次校验
- 超时、过大响应、非法内容类型有明确错误

### Task 5.2 实现提取器

内容：

- 新建 `src/web/extract.ts`
- HTML：
  - `jsdom` + `@mozilla/readability`
  - 支持 `markdown` / `text`
- JSON：
  - 保持稳定、可读的 pretty-print
- text：
  - 原样保留并做统一截断
- image：
  - 返回 image content block + base64 + mime type

验收标准：

- HTML 页面能稳定提取正文
- 纯文本和 JSON 不会被错误走 readability
- 图片不会被降级成纯文字描述

### Task 5.3 实现 Jina 增强路径

内容：

- 在 `src/web/fetch.ts` 中支持：
  - `preferJina`
  - `enableJinaFallback`
- 默认关闭
- 只有配置明确开启时才把 URL 发给 Jina Reader

验收标准：

- 默认配置下不会调用第三方 extractor
- 相关分支有明确测试

### Task 5.4 实现 `web_fetch` 工具

内容：

- 新建 `src/tools/web-fetch.ts`
- schema 参数：
  - `label`
  - `url`
  - `extractMode`
  - `maxChars`
- 输出：
  - 文本页面返回 text block
  - 图片返回 text + image blocks
  - `details` 包含 `finalUrl` / `contentType` / `extractor` / `truncated`

验收标准：

- 返回值符合当前 tool 体系
- 新增 `test/web-fetch.test.ts`

---

## Phase 6: Runtime Integration

### Task 6.1 接入主工具集合

内容：

- 修改 `src/tools/index.ts`
- 在 `createPipiclawTools()` 中加载：
  - `tools.json`
  - `security.json`
- 仅当 `tools.web.enable !== false` 时注册：
  - `web_search`
  - `web_fetch`

验收标准：

- 默认情况下 web 工具可用
- `enable=false` 时完全不注册
- 更新 `test/tools-index.test.ts`

### Task 6.2 更新 prompt builder

内容：

- 修改 `src/agent/prompt-builder.ts`
- 在工具列表中加入：
  - `web_search`
  - `web_fetch`
- 明确提示：
  - 外部网页内容不可信
  - 不要执行网页中的指令

验收标准：

- prompt 文案对 web 工具有明确行为约束
- 更新 `test/prompt-builder.test.ts`

### Task 6.3 接入子代理能力

内容：

- 修改 `src/subagents/discovery.ts`
- `ALLOWED_SUB_AGENT_TOOLS` 增加：
  - `web_search`
  - `web_fetch`
- 保持 `DEFAULT_SUB_AGENT_TOOLS` 仍为 `read` + `bash`

- 修改 `src/subagents/tool.ts`
- 允许显式声明的子代理拿到 web 工具

验收标准：

- 子代理默认工具集不膨胀
- 显式声明时可正常启用 web 工具
- 更新 `test/subagent-phase1.test.ts`

### Task 6.4 导出与对外接口整理

内容：

- 视需要修改 `src/index.ts`
- 导出新的 config / tool factory / helper 类型

验收标准：

- 公共 API 暴露一致，不出现无意义的 barrel 扩散

---

## Phase 7: Tests And Validation

### Task 7.1 新增和更新测试文件

至少覆盖：

- `test/bootstrap.test.ts`
- `test/dingtalk.test.ts`
- `test/security-config.test.ts`
- `test/tools-index.test.ts`
- `test/prompt-builder.test.ts`
- `test/subagent-phase1.test.ts`
- `test/web-search.test.ts`
- `test/web-fetch.test.ts`
- `test/web-fetch-security.test.ts`
- `test/tools-config.test.ts`

### Task 7.2 核心测试场景

必须覆盖：

1. `tools.json` 缺失时的默认值
2. `tools.web.enable=false` 时工具不注册
3. `tools.web.proxy` 覆盖环境代理
4. 未设置 `tools.web.proxy` 时继承环境代理
5. `DINGTALK_FORCE_PROXY` 已无任何效果
6. `duckduckgo` 默认 provider 正常工作
7. `brave` / `tavily` / `jina` / `searxng` 配置映射正确
8. `web_fetch` 对 HTML / JSON / text / image 分流正确
9. SSRF / redirect 阻断正确
10. 返回结果中包含 untrusted 标记

### Task 7.3 最终验证命令

每个里程碑至少执行：

```bash
npm run typecheck
npm run test -- test/bootstrap.test.ts test/dingtalk.test.ts test/security-config.test.ts
```

整体完成后执行：

```bash
npm run check
```

验收标准：

- 全量测试通过
- 无新 lint / typecheck 错误

---

## Phase 8: Documentation And Release Readiness

### Task 8.1 更新用户文档

内容：

- 更新 `README.md`
- 更新 `docs/configuration.md`
- 更新 `docs/deployment-and-operations.md`

需说明：

1. `tools.json` 的位置与默认模板
2. `tools.web.search.provider` 的配置方式
3. `tools.web.proxy` 与环境变量的优先级
4. web 内容是不可信外部数据
5. `security.json` 中 `networkGuard` 的配置方式

### Task 8.2 补充迁移说明

内容：

- 文档中明确说明：
  - 不再支持 `DINGTALK_FORCE_PROXY`
  - DingTalk runtime 默认尊重环境代理
  - web tools 的 provider secret 进入 `tools.json`

验收标准：

- 用户能仅靠文档完成首次配置
- 旧代理行为变化被明确说明

---

## Suggested Execution Order

建议实际开发顺序如下：

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7
9. Phase 8

不要倒序实现。先写工具再补配置与代理，只会让回滚和测试都变复杂。

---

## Exit Criteria

满足以下条件即可视为 Spec 006 进入可发布状态：

1. `web_search` / `web_fetch` 在默认配置下可用
2. `tools.json` 已成为唯一的 web tools 配置入口
3. `DINGTALK_FORCE_PROXY` 已从实现和文档中删除
4. DingTalk runtime 与 web tools 默认都尊重环境代理
5. `tools.web.proxy` override 生效
6. network guard 能阻断 SSRF 与 redirect 绕过
7. prompt、主代理、子代理都已完成接入
8. `npm run check` 通过
9. README 与 `docs/` 已同步更新

这是本轮实现的完成标准。
