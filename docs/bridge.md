# CC Bridge（Claude Code 双向连接）

Sideki 的 Pro 模式通过本地 Node.js bridge 与 Claude Code 双向通信。目录和协议标识仍沿用 `sidekick-*`，不随产品展示名变化。

## 连接模型

```text
Claude Code -- HTTP /cmd --> Node.js bridge -- WebSocket /ws --> 扩展 Service Worker
                                                                    |
                                                          bridge:message
                                                                    v
                                                          Pro ChatView 发起消息
```

服务端是 `tools/sidekick-bridge/scripts/bridge.js`，绑定 `127.0.0.1`。默认端口 9111，服务端可用 `BRIDGE_PORT` 覆盖；扩展 `bridge-client.ts` 当前固定连接 `ws://127.0.0.1:9111/ws`，修改服务端端口不会自动修改客户端。

| 接口 | 方法 | 用途 |
|------|------|------|
| `/ws` | WebSocket | 扩展连接端点 |
| `/cmd` | POST | 将请求 body 转发给扩展，通常为 `{"text":"..."}` |
| `/events` | GET | 拉取回复事件，支持 `?since=` 时间戳过滤 |
| `/status` | GET | 查询 connected、events、uptime |

服务端只有一个 `client`；新连接替换并关闭旧连接，因此不是多扩展/多 session 路由服务器。回复打印到 stdout，另缓存最多 200 条，并附 `_ts` 供增量拉取。扩展不能监听本地 TCP，故需要该 HTTP/WebSocket 中转。

## 客户端生命周期

`pro:attach` 在 debugger attach 成功后调用 `startBridge()`；`pro:detach` 停止 bridge 并 detach。`startBridge()` 首次连接并创建 `bridge-reconnect` alarm，配置周期为 `0.1` 分钟；这是请求的重连检查周期，不应把浏览器实际调度视为精确每 6 秒。

alarm 在 active 时检查连接，缺失或 CLOSED 才重连；`connect()` 对 OPEN / CONNECTING 幂等。`stopBridge()` 清除 alarm、关闭连接并广播 disconnected。使用 alarm 的原因是 SW 可能挂起，不能依赖内存中的长时定时器。

## 收发链路

### Claude Code → Sideki

1. CC 向 `/cmd` 发请求。
2. 服务端原样转发 body；扩展 `ws.onmessage` 尝试解析 JSON 中的 `text`，否则保留原字符串。
3. 扩展广播 `bridge:message`。
4. Pro `ChatView` 监听并调用 `handleSend(text, { fromBridge: true })`。
5. 消息以 v2 metadata 标记 `source: 'claude-code'`，模型请求副本中才展开 `[from:claude-code]`。

**当前主动注入仍依赖 Pro 面板在场。** 后台内核可以在关面板后完成已有 turn，但 Service Worker 没有直接把入站 bridge 消息派发到指定 SessionRuntime 的路由；也没有多 session 的目标参数。

### Sideki → Claude Code

panel 宿主的 hook 和 offscreen 宿主的 `SessionRuntime.onTurnFinish()` 均实现回传：

1. Pro turn 完成后提取 assistant 的 text parts，trim 后长度大于 10 才发 `bridge:send`。
2. SW `sendToCC()` 在 WebSocket OPEN 时发送 `{"type":"response","text":"..."}`，返回是否已发送。
3. 返回 `sent: true` 后，将该消息 metadata 写成 `{ v: 2, relayed: true, ... }`，并用 message ID 集合避免重复标记。
4. 下次模型请求由 `expandForModel()` 在副本中追加 `[relayed:claude-code]`；UI 读 metadata 显示回传状态。

回传规则按 Pro 模式和文本长度判断，**不只回传来自 CC 的 turn**。`sent: true` 表示扩展成功发到当前 WebSocket，不是 CC 已处理完毕的应用层确认。

## 消息协议：v2 为当前格式，零宽字符为兼容格式

`src/shared/message-protocol.ts` 统一构建、显示和发送消息。当前消息把用户可见 text、附件 data parts 与 metadata 分开保存：

- 来源：`metadata.source = 'claude-code'`。
- 回传：`metadata.relayed = true`。
- skill：`data-skill` part 保存名称与内容。
- 元素引用：`data-element` part 保存 label、snapshot 等数据。

`prepareOutgoingMessages()` / `expandForModel()` 只在发送副本中把这些信息展开成模型可读文本。UI 的 `visibleText()` 在 v2 中直接取 text parts，不再用不可见字符切分新消息。

旧会话仍可包含 U+200B（零宽空格）：

| 旧格式 | 兼容意义 |
|--------|----------|
| `[from:claude-code]​text` | bridge 来源 |
| `/skill​content` | skill 内容注入 |
| `[Selected element:...]\nsnapshot​userText` | 元素上下文与用户文字 |
| `text​[relayed:claude-code]` | 已回传标记 |

这些格式由 legacy 分支兼容读取，不是新增消息必须使用的协议。

## Pro debugger 会话

`src/background/debug-session.ts` 的单例 `DebugSession` 维护当前 attach tab、console 与 network 缓冲。持续 attach 才能监听后续 CDP 事件；普通真实点击/JS 若借用同一 tab 的 debugger，不得在 finally 中 detach 这个长期会话。

CDP 事件路由包括：

- `Runtime.consoleAPICalled` → console buffer。
- `Network.requestWillBeSent` → pending Map。
- `Network.responseReceived` → 请求响应信息。
- `Network.loadingFinished` / `Network.loadingFailed` → network buffer。

console、network 和 pending 请求分别限制最多 500 项。`Runtime.enable` 在 attach 时启用；console/network capture 有各自 listening 状态。

`onDetach` 清除 attached/listening 和 pending 状态。仅当 reason 为 `target_closed` 时，代码安排 1 秒后查询原 tab，未 complete 则每 500ms 再查，complete 后尝试 attach；tab 已不存在则退出。其他 detach reason 不自动恢复。**不能保证导航总产生该 reason，也不能把用户关闭调试栏描述成必然自动重连；需以 Chrome 真机事件为准。**

JS/真实输入使用的 `approvedDebuggerHosts` 在 `tool-handlers.ts`，是 SW 内存授权缓存；Pro attach 生命周期与该缓存不是同一状态。通用 debugger 授权只由 permissive / yoloMode 自动放行，不因 session 是 Pro 就统一豁免。详见 [浏览器授权规则](browser.md#授权模型)。

## 代码与验证入口

| 位置 | 职责 |
|------|------|
| `src/background/bridge-client.ts` | WebSocket 客户端、alarm、`sendToCC` |
| `tools/sidekick-bridge/scripts/bridge.js` | 本地 HTTP/WS 服务 |
| `src/sidepanel/views/ChatView.tsx` | 接收入站消息并带来源发送 |
| `src/sidepanel/hooks/useSidekickChat.ts` | panel 宿主回传 |
| `src/shared/kernel/kernel-runtime.ts` | offscreen 宿主回传 |
| `src/shared/message-protocol.ts` | v2 与 legacy 兼容、模型副本展开 |
| `src/background/debug-session.ts` | CDP 会话、事件、缓冲 |

真实 Chrome 验收需覆盖：关面板时已有 turn 的回传、缺席面板时入站消息、两个扩展争用连接、debugger detach 原因、浏览器实际 alarm 调度。仅凭 mock 测试不能确认这些生命周期行为。
