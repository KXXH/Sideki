# Sideki Bridge

Bidirectional bridge between Claude Code and Sideki Chrome extension (Pro mode). Sideki is an AI-powered browser agent — you can delegate browser-side tasks to it in natural language.

## Setup (first time)

```bash
cd <sidekick-project>/tools/sidekick-bridge && npm install
```

## Start

Launch the bridge with Monitor:

```bash
node <sidekick-project>/tools/sidekick-bridge/scripts/bridge.js
```

Sideki (in Pro mode) auto-connects to ws://127.0.0.1:9111/ws. Keep the Pro side panel mounted to receive incoming messages; an offscreen kernel alone does not consume bridge input. Verify:
```bash
curl -s http://localhost:9111/status
```

## Sending Messages to Sideki

Send natural language instructions via HTTP POST. The endpoint accepts raw text; JSON `{ "text": "..." }` is also decoded by the extension. Sideki's AI processes them using its browser tools (DOM inspection, network capture, JS execution, element interaction, etc.) and responds.

```bash
curl -s -X POST http://localhost:9111/cmd -d '检查一下 #submit-btn 的计算样式和事件监听器'
curl -s -X POST http://localhost:9111/cmd -d '开启网络抓包，过滤 /api 请求'
curl -s -X POST http://localhost:9111/cmd -d '页面上有没有报错？看一下控制台'
curl -s -X POST http://localhost:9111/cmd -d '点击"登录"按钮，然后截图看看结果'
curl -s -X POST http://localhost:9111/cmd -d '这个页面的 LCP 和 CLS 指标是多少？'
```

Think of Sideki as a sub-agent that has eyes and hands in the browser. Give it tasks the same way you would instruct a colleague.

## Receiving Responses

Sideki's AI response arrives as a JSON line on stdout (Monitor captures it):

```json
{"type":"response","text":"#submit-btn 的计算样式：display: flex, position: relative...\n\n事件监听器：\n- click → src/Button.tsx:42"}
```

The `text` field is the AI's natural language response — read it directly.

## Workflow

```
1. User asks you: "The submit button doesn't work, debug it"
2. You send to Sideki: curl POST /cmd -d '检查 #submit-btn 的事件监听器，有没有 preventDefault？'
3. Monitor receives: {"type":"response","text":"找到 click handler 在 Button.tsx:42，调用了 e.preventDefault()"}
4. You read local file src/Button.tsx:42, fix the issue
5. You send to Sideki: curl POST /cmd -d '点击一下 #submit-btn 验证修复'
6. Monitor receives: {"type":"response","text":"点击成功，表单已提交"}
7. Done — report to user
```

## Key Points

- Sideki shares the Pro session context — all messages (from you and from the human user) are visible to its AI
- You don't need structured commands — just describe what you want in natural language
- Sideki exposes DOM, CSS, event listeners, network/console capture, JS execution, screenshots, performance metrics, and the browser-management commands implemented by the extension. Tool and debugger consent still follow permission settings; Pro mode alone does not bypass them. Screenshots require the operating tab to be foreground.
- Responses may take time while the AI executes tools. Pro replies longer than 10 characters are relayed, including replies to human messages; do not assume every event is a response to your last command.
- New messages use structured v2 metadata for source/relay state; zero-width markers remain for legacy compatibility. A successful `sent` flag means WebSocket send succeeded, not that Claude Code acknowledged the response.
- Detailed implementation: [bridge documentation](../../docs/bridge.md).

## Environment Variables

- `BRIDGE_PORT` — Server port (default: 9111). The extension client URL is fixed at 9111; changing this variable alone will break its connection.
