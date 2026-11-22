# 071 验收记录

| 字段 | 内容 |
| --- | --- |
| 状态 | 离线实施完成，并已用本机 `openai-codex/gpt-5.6-luna`（thinking medium）跑过定向和核心探针。没有建立自动参照，核心 gate 未替换 |
| 日期 | 2026-11-22 |
| 范围 | P1 证据与评分、P2 计划与停止线、P3 用例。P4 的付费 `cycle` 没有执行 |

## 离线结果

- `npm run test:evals`：相对实施前的 98 项，净增机制测试在 `test/evals/spec071-reliability.test.ts`。覆盖双根路径归一、冻结日键、token 上限、过期执行清单，以及“有账本的中断试验仍按已知 token 计费”。`npm run test:e2e` 在执行器改接到 runner 之后为 74 项通过。
- `npm run eval -- selftest --all`：41/41 qualified，0 次模型请求。默认计划不含退役的 `M-quality-recall-03` 和隔离的 `S-net-02`。
- `npm run eval -- selftest --case S-net-02`：6/6 qualified。
- `npm run eval -- selftest --case M-quality-recall-03`：6/6 qualified。该用例仍可读，只是不再进入默认付费计划。
- 场景目录从 42 增至 43。核心 gate 仍是原来的 12 项。`C-existing-01` 与 `I-inbound-context-01` 记在 `coreGateRoster`，没有替换现有 gate。

## 负向检查

- 路径落在已知根之外，或要跳出根目录时，归一化结果为空，不能拿绝对路径或 `.verified` 充当工位证据。
- 日键改成没有日记的另一天时，`M-maint-01` 的日记评分失败。评分当时的日历日不参与判定。
- 执行清单的 case 身份被改掉后，`assertPlanIdentity` 直接拒绝，并写明模型请求为 0。
- token 上限达到后，已经占用的槽位可以收束；下一个槽位拿到并发名额后被标成未启动，不会再建临时目录。

## 真实模型

模型是本机 `openai-codex/gpt-5.6-luna`，thinking 为 medium。Judge 关闭。现场和封存重放一致的批次，重放模型请求都是 0。

| Run | 结果 | 说明 |
| --- | --- | --- |
| `2026-11-21T23-52-03-551Z-svrv0k` | 1/3，重放 3/3 | 分页和工位的行为是对的，但 runner 没有使用运行时注入的执行器，命令证据为空。已把该执行器传到 chat、request 和 task runner。 |
| `2026-11-21T23-55-47-494Z-mswj7c` | 3/3 通过，重放 3/3 | 定向 `C-fix-01`、`M-overflow-01`、`U-desk-cwd-01`。148827 token，已知费用 $0.0116，1.2 分钟。没有命中 token 或时间停止线。 |
| `2026-11-21T23-57-36-404Z-4pbelz` | 现场 0/2 | `M-abstain-01` 答了“40 分钟”但没复述 `WINDOW-40`。评分改为认可持续时长，封存重评通过。`T-ask-01` 在 240 秒墙钟处再次追问具体日期和时区，计划文件没有写出。 |
| `2026-11-22T00-04-21-131Z-id4lj1` | 7 通过，2 次 `T-ask-01` 超墙，27 个槽位未启动 | 超墙试验的账本里已有约 3.8 万 token，却被记成用量未知，后续槽位停止。已改为有账本就按已知 token 计，只有发生了模型调用却没有账本时才停止后续槽位。未启动槽位不参与重放。 |
| `2026-11-22T00-14-40-587Z-cwecwy` | 现场 23/27，重放 27/27 | 补跑被停掉的 9 个核心场景，各 3 次。1116098 token，已知费用 $0.0929，6.0 分钟。`M-extract-01` 为 2/3，一次没有写出持久事实。`T-horizon-01` 三次都把阶段说明写进了字段，现场因要求字段全文等于 token 而失败；改为字段包含对应 token 后，封存重评 3/3 通过。重评目录 `regrade-2026-11-22T00-14-40-587Z-cwecwy-1795306924294`。 |

`T-ask-01` 的 gate 是 3/3。这次核心里 1 次通过、2 次在第二次追问后碰到试验墙钟，不能记成核心通过。`C-existing-01` 和 `I-inbound-context-01` 没有按晋升后的身份各跑 3 次，所以没有替换 12 项 gate。没有满足“完整 required 集合、冻结 gate、无硬违规、证据全部重放”的单一运行，因此没有自动参照。

大型结果留在被忽略的 `evals/results/`。临时评测目录已清理。
