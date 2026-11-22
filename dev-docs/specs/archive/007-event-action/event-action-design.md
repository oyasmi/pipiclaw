# Event Action Gate 设计方案

| 字段 | 值 |
|------|------|
| 分支 | `feat/event-action` |
| 状态 | APPROVED |
| 日期 | 2026-04-09 |

---

## 问题陈述

Pipiclaw的事件系统（`src/runtime/events.ts`）只支持将事件文本直接发给LLM处理。没有在LLM之前执行确定性逻辑的能力。这导致周期性事件（如周报提醒）即使在不满足条件时也会触发LLM会话，浪费token并产生不必要的消息。

具体场景：`weekly-report-reminder.json`配置了`preAction`字段，但Pipiclaw完全忽略该字段。每天16:00都触发LLM，LLM每天都回复"今天不是最后工作日"。

---

## 需求证据

- 用户已有完整的判断脚本`check-last-workday.js`（含中国法定节假日+调休逻辑），退出码0/1设计，但因为events系统不支持`preAction`字段而无法使用
- 每天触发一次不必要的LLM会话，消耗token和延迟
- LLM判断"今天是否最后工作日"涉及调休等特殊逻辑，确定性脚本比LLM更可靠

---

## 现状

当前workaround是在`text`字段中写提示词让LLM自行判断并输出`[SILENT]`。缺点：每次触发都消耗完整agent会话；LLM可能误判涉及调休的场景；token浪费。

---

## 约束

- 向后完全兼容：没有`preAction`字段的事件行为不变
- 只支持bash command执行，不需要其他执行器
- 脚本执行必须有超时保护，不能阻塞事件调度
- `preAction.command`执行前需经过`guardCommand`安全检查，因为事件文件可由LLM通过文件工具动态创建，存在间接注入路径
- 需要覆盖测试

---

## 前提

1. 事件触发时需要在LLM之前执行确定性脚本，根据脚本退出码决定是否入队
2. 脚本执行是可选能力，没有`preAction`字段的事件行为不变
3. 脚本只支持bash command，不需要支持其他执行器

---

## 备选方案

### 方案A: Gate模式（选定）

退出码0 = 入队给LLM，非0 = 静默跳过。约30行改动。

- **优点**：最小改动；完全向后兼容；现有脚本直接能用
- **缺点**：不支持动态消息内容（可演进到Transform模式）

### 方案B: Transform模式

退出码过滤 + stdout替换text。约55行改动。

- **优点**：脚本能动态生成消息内容
- **缺点**：stdout边界情况处理；text语义变化；调试更复杂

### 方案C: 两阶段事件

零代码改动，脚本外部运行后自己创建immediate事件文件。

- **优点**：零改动
- **缺点**：需要外部cron；运维复杂度增加；与Pipiclaw事件系统解耦

---

## 推荐方案: Gate模式（A）

最小改动解决核心问题，现有脚本直接能用。

---

## 实现细节

### 一、类型扩展（`src/runtime/events.ts`）

新增接口：

```typescript
interface EventAction {
  type: "bash";
  command: string;
  timeout?: number; // ms, 默认10000
}
```

在三个独立interface（`ImmediateEvent`、`OneShotEvent`、`PeriodicEvent`）中各添加`preAction?: EventAction`字段。当前类型定义没有公共基类，需要在三处都加。

### 二、parseEvent扩展

提取通用的`parsePreAction(data)`辅助函数，在switch之前调用，返回`EventAction | undefined`。验证逻辑：如果`data.preAction`存在，检查`preAction.type === "bash"`且`preAction.command.trim().length > 0`（空字符串视为无效，抛出解析错误），并校验`preAction.timeout`若存在则必须是正数毫秒值。然后在三个case分支的返回对象中都附加`preAction`字段。

### 三、execute方法改造

将`execute`改为async方法，使用`child_process.exec`（异步）代替`execSync`以避免阻塞Node.js事件循环。同步方案（`execSync`）会在脚本执行期间阻塞整个进程（包括文件watcher、消息处理、其他cron触发），风险不可接受。

伪代码：

```typescript
private async execute(filename, event, deleteAfter = true): Promise<void> {
  // Gate check: run preAction before enqueue
  if (event.preAction) {
    try {
      await this.runPreAction(event.preAction, filename);
    } catch {
      log.logInfo(`Pre-action gate blocked event: ${filename}`);
      return;
    }
  }
  // ...existing enqueue logic
}

private runPreAction(preAction, filename): Promise<void> {
  // Security gate
  const guardResult = guardCommand(preAction.command, this.securityConfig.commandGuard);
  if (!guardResult.allowed) {
    log.logWarning(`Pre-action command blocked by guard: ${guardResult.reason}`);
    return Promise.reject(new Error(`guard: ${guardResult.reason}`));
  }

  return new Promise((resolve, reject) => {
    const child = exec(preAction.command, {
      timeout: preAction.timeout ?? 10_000,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}`));
    });
    child.on("error", reject);
  });
}
```

所有调用点需要适配async：

- **handlePeriodic**：cron回调改为`async () => { await this.execute(...) }`
- **handleImmediate**：改为async方法，await execute调用
- **handleOneShot**：setTimeout回调改为async lambda

不await会产生unhandled promise rejection。对于periodic事件，gate拦截仅跳过当次执行，cron调度继续运行，下次触发时重新评估gate条件。

### 四、测试覆盖

- preAction退出码0 → 事件正常入队
- preAction退出码1 → 事件被跳过
- preAction超时 → 事件被跳过
- preAction命令不存在/路径错误 → 事件被跳过
- `preAction.command`为空字符串 → parseEvent抛出解析错误
- `preAction.command`被guardCommand拦截 → 事件被跳过，记录warning日志
- `preAction.timeout <= 0` → parseEvent抛出解析错误
- 无`preAction`字段 → 行为不变（回归测试）

### 五、文档更新

更新`docs/events-and-sub-agents.md`中的事件配置说明，增加`preAction`字段文档。

---

## 待决事项

1. preAction执行的默认超时设为10秒（gate检查应该快速完成），可通过timeout字段覆盖
2. preAction执行失败（非0退出码）不写error marker——这是正常的"gate closed"行为

---

## 成功标准

- `weekly-report-reminder.json`配置`preAction`后，非最后工作日不再触发LLM会话
- 所有现有无`preAction`字段的事件行为不变
- 测试覆盖gate通过和被阻断两条路径

---

## 依赖

- `exec`来自Node.js `child_process`内置模块
- `guardCommand`来自`src/security/command-guard.ts`（已有模块）
- `SecurityConfig`需要传入`EventsWatcher`构造函数（从bootstrap层注入）
