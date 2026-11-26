# 072 冷存储全文索引与记忆写入锚点核验验收

## 基线

实施基线为 `ffba769`，Node.js 22.21.0 内置 SQLite 3.50.4，内存库成功创建 FTS5 表。

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 149 个测试文件，1,050 例通过 |
| `npm run test:e2e` | 29 个测试文件，72 例通过 |
| `npm run playbooks:measure` | 全部指南 9,592 units，`memory-operations.md` 650 units / 2,613 字节 |
| 源文件行数 | `session-corpus` 467、`session-search` 315、`search` 350、`reflect` 548、`scheduler` 202、`store` 663、`journal` 167、`tools/session-search` 109、`tools/memory-manage` 341、`registry` 415、`settings` 563 |
| 装配入口 | `bootstrap.ts` 787 行，`session-host.ts` 788 行 |

## 阶段 1–2

索引层和切换合在一个提交，使新增接口与其生产调用方一同通过静态检查。S1 的两次变异已实际执行。恢复按 mtime 只索引最新 12 个会话时，旧标记断言失败。强制每次重建时，`filesRebuilt` 断言失败。恢复实现后重跑全量门禁。

首次副本验收使用 SQLite schema v1。真实数据从 `~/.pipiclaw/workspace/desk-default` 复制到私有临时 app home，测量程序只打开副本内的索引。首次同步 3,471 ms，最长事务 44.38 ms，事件循环最大延迟 88.74 ms。第二次同步没有新增、追加或重建文件。80 次查询的 p95 为 26.92 ms，`daily-workspace-git-save` 返回多条 2026 年 4 月记录。库、WAL、SHM 共 40,236,016 字节，占会话与任务目录合计 91,196,918 字节的 44.1%。打开连接时删除副本的索引后，四个查询的前五条结果逐条一致。

`npm run check` 通过 1,060 例，`npm run test:e2e` 通过 73 例。架构基线未增加，静态检查确认源代码只有 `search-index-db.ts` 动态引用 SQLite，索引写入未使用替换语义。工具描述从 266 缩至 236 字节，参数 schema 一致。阶段 2 的 `memory-operations.md` 为 662 units / 2,655 字节，全部指南为 9,604 units。
