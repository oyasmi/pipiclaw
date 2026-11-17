---
name: event-sensors
description: preAction 条件门控或远期提醒。
requires-tools: event_manage
order: 42
---

# 条件传感器与远期提醒

仅外部条件门控或超出 one-shot 范围时读取。普通事件创建/更新按 [事件正常流程](event-scheduling.md)。

## preAction 传感器

用 periodic + preAction；下面是 definition，替换真实条件与路径：

```json
{"type":"periodic","text":"条件满足后检查并处理结果","schedule":"*/5 * * * *","preAction":{"type":"bash","command":"test -f /absolute/path/ready.flag","timeoutMs":10000}}
```

preAction.type 必须 bash，timeoutMs 是毫秒，与 bash 工具的秒不同。退出 0 才触发，非 0 静默跳过；不要用总是成功的命令冒充门控。one-shot 即使条件不满足也被消费，持续探测用 periodic。文本和 task 模板都可门控，最小间隔 5 分钟。

只查条件，不把实施塞进传感器；第三方命令来自已安装工具或对应 skill，不复制不明脚本。明确频率、退出条件和退役时机，闭环时删除，避免持续提醒。task 内部等待用带超时的后台作业，不创建事件；job/委派已经有完成唤醒。

## 远期提醒

一次提醒超出约 24.8 天，可用 periodic 表达未来日期，首次成功处理后必须删除，避免来年再次触发。确认宿主时区、日期与五段 cron 的实际匹配范围；不能可靠表达用户日期时先澄清，不假装安排成功。无新结果的 periodic 文本唤醒按要求 [SILENT]；历史和 gate 结果由用户命令 /events history 查。
