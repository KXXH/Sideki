# AI Agent 子系统

本文描述 Sideki 当前的 Agent、上下文和模型适配实现。主要入口是
[`agent.ts`](../src/shared/agent.ts)、
[`kernel-runtime.ts`](../src/shared/kernel/kernel-runtime.ts) 和
[`useSidekickChat.ts`](../src/sidepanel/hooks/useSidekickChat.ts)。
项目使用 Vercel AI SDK 7 的 `ToolLoopAgent`、`DirectChatTransport`；具体版本以
[`package.json`](../package.json) 为准，SDK 行为可直接查 `node_modules/ai/src/`。

## 身份、模式与工具

`buildAgentIdentity()` 在所有提示词路径中明确区分两类信息：

- 产品身份：`You are Sideki, an AI assistant built into the browser sidebar.`
- 底层模型：使用用户当前配置的 `config.model`，JSON 编码后单独说明；空值显示
  `not configured`。这是配置的模型标识，不保证网关实际路由到的模型身份。

有页面上下文时，Chat 使用 `buildSystemPrompt()`，预注入截断后的页面正文；Pro
使用 `buildProSystemPrompt()`，只提供页面标题、URL 和调试工作流，正文按需读取。
没有页面上下文时，两种模式都退化为身份说明、自定义指令、技能索引和记忆，
不会自动得到完整的 Chat / Pro 基础提示词。

[`tools/index.ts`](../src/shared/tools/index.ts) 当前注册 15 个基础工具：
`click`、`hover`、`type`、`select`、`keypress`、`scroll`、`screenshot`、`wait`、
`navigate`、`getPageContent`、`bash`、`visualize`、`useSkill`、`schedule`、`monitor`。
`createAgentTools(ctx)` 为并发会话绑定各自的 session / tab 上下文，随后合并 MCP
动态工具。工具存在于工具表不代表所有宿主均支持其操作，例如自动任务要求后台内核。
技能加载和过滤细节见 [skills.md](skills.md)。

## 三层上下文生命周期

模型服务通常按请求前缀复用 prompt cache。这里的策略是尽量保持前缀稳定，实际
命中和计费仍取决于服务端支持，不由客户端保证。

### 克拉通：冻结的系统提示词

`buildFrozenInstructions()` 在每次 `createAgent()` 时构建一次，拼接：

1. 包含 Sideki 身份、配置模型名称的模式提示词，或无页面时的 fallback。
2. `labSingleDollarMath` 关闭（含未配置）时加入避免行内公式、改用纯文本的提示；开启时不加入任何公式提示。
3. `getSkillIndex()` 生成的可用技能索引及触发规则。
4. `getGlobalMemory()` 的全局记忆，以及有 hostname 时 `getSiteMemory()` 的站点
   记忆正文；不是只注入“该站点存在记忆”的提示。

**当前构建是惰性的**：创建会话、切换会话和重开面板本身不做页面提取、MCP 工具
查询或 Agent 构建。第一次发送或重新生成进入准备阶段后，才尝试提取页面、获取
MCP 工具表并构建 Agent。页面提取失败不阻断发送，使用无页面 fallback。

- 默认 offscreen 宿主：`SessionRuntime.ensureAgentReady()` /
  `rebuildAgentIfNeeded()` 管理准备过程；每个 runtime 持有自己的 `craton` 快照。
- panel 回退宿主：`useSidekickChat` 的准备流程负责同样工作，Dev 检查器通过
  `cratonRef` 查看冻结内容。
- 首条消息后页面内容锁定；普通 Tab 切换不会直接改写已有系统提示词。缺少页面
  内容的 Agent 后续获得内容时可以重建。
- 配置漂移通过共享的
  [`agentFingerprint()`](../src/shared/agent-fingerprint.ts) 检测：endpoint、model、
  apiKey、reasoningEffort、supportsImages、apiProtocol、systemPrompt、contextWindow、
  maxToolRounds、modelParams、disabledSkills、后端兼容开关，以及启用的 MCP 服务
  的 id / url / name / auth.type。主题、字体等 UI 设置不在指纹中。
- `labSingleDollarMath` 仅在构建克拉通时采样，不纳入重建指纹；切换开关不会改写现有提示词，也不追加每轮提示。后续因其他原因重新构建时才采用当时的值，Chat、Pro 与无页面 fallback 一致。

MCP 工具表获取属于构建过程，避免先创建无 MCP 工具的 Agent 再异步补齐。全部
获取失败时不提交成功的构建指纹，让下次发送重试；部分服务失败则保留已获取的
工具，不因每次 socket 波动反复重建。记忆与技能索引是构建时快照，不会在每个
step 重新生成。

### 地体：历史消息与 LLM 压缩

压缩实现共用于 [`SidekickKernel.compactNow()`](../src/shared/kernel/chat-kernel.ts)。
自动触发分别由 offscreen 的
[`wireTurnAutomation()`](../src/shared/kernel/turn-automation.ts) 和 panel hook 的
对应 effect 负责；镜像面板不重复执行。

自动压缩条件：`labAutoCompress !== false`、状态为 `ready`、上下文占比至少 80%，
且距上次成功压缩至少 30 秒。offscreen 用 `lastTurnTokens.input` 判断；panel
用本地 `tokenUsage`。`compactNow()` 本身也拒绝忙碌或重复压缩。

压缩流程：

1. [`findCompactionCutoff()`](../src/shared/format.ts) 通常保留最近 3 个 user turn；
   不足 3 个时退为保留最近 1 个。切点不大于 1 时不压缩。
2. 较早消息只提取 text part，其他内容用 `[non-text content]` 占位，再交给
   `compactContext()`。因此当前摘要不直接包含完整的工具结果或图片。
3. 原始消息和压缩标记追加到 `chrome.storage.local['history:{sessionId}']`。
   offscreen 无 `chrome.storage` 时经 `env:history-append` 交给 SW。
4. `kstate.messages` 替换为摘要 assistant 消息（固定 ID `__context_summary__`）和
   保留消息；摘要 prompt 要求以 `[Context Compacted]` 开头。UI 将摘要显示为分隔线，
   原始历史折叠供回看。

80% 阈值给压缩调用留余量；30 秒冷却防止摘要仍较大时连续调用模型。压缩期间
`compacting` 状态阻塞正常发送，避免历史被替换时与新 turn 交错。

### 造山带：请求副本中的新鲜元数据

`prepareCall` 每次 Agent 调用执行一次，通过 `buildOrogenLines()` 生成：

- `[page: title | url | timestamp]`：所有模式，优先使用当前 turn 的页面快照。
- `[debug-status: ...]`：仅 Pro，按当前 console / network / bridge 状态补充。

只在输入最后一条为 user 消息时追加；纯文本追加到字符串，多模态追加到最后一个
text part。消息数组及被修改部分都复制，不回写 kernel / UI 的消息状态。

`prepareStep` 在工具循环中只向尾部追加 `<system-reminder>` 包裹的独立 user 消息：

| 提醒 | 触发条件 |
|------|----------|
| TODO | 从尾部回扫累计至少 8 条 assistant 消息未见 TODO 活动，有 sessionId 且 `/todo.json` 中存在未完成项 |
| 步数预算 | `stepNumber` 等于 `ceil(maxSteps * .8)` 或 `ceil(maxSteps * .95)`；两阈值重合时只发第一档 |

预算上限为正数 `maxToolRounds`，非正值实际回退到 100；如果工具上下文给出更小
的 turn 上限则取最小值。monitor 唤醒由 runtime 额外限制为最多 20 步。

turn 中段不能再修改起点 user 消息：它已位于本轮工具消息之前，改写会破坏已经
累积的缓存前缀。独立提醒尾部追加可以避免这种回溯修改。

## Agent 调用链

```text
首次 send / regenerate
  → 宿主准备页面、MCP 工具、Agent
  → createAgent(config, refs, toolCtx, sessionMode)
      → createProvider(config, opts)
      → buildFrozenInstructions()
      → createAgentTools(ctx) + MCP tools
      → ToolLoopAgent
  → DirectChatTransport
      → prepareCall（注入冻结 instructions 和 turn 元数据、设定本轮步数）
      → prepareStep → 模型 → 工具执行 → 结果追加 → 下一步
      → 模型停止调用工具，或 stopWhen / abort / error 终止
  → ready 边界：保存、完成通知、工具归档、必要时压缩
```

Agent 的 `onEnd` 可报告整次调用的 usage；UI 上下文占用以最后一步输入 token 为准，
不能把工具循环所有步骤的 inputTokens 总和当作当前上下文大小。传输层按 SDK 7 的
`finish-step` 采集性能统计，详见 [frontend.md](frontend.md)。

## 工具归档：turn 边界回写

实际实现为 `SidekickKernel.archiveNow()`，panel hook 只是调用入口；offscreen
通过 `wireTurnAutomation()` 在 ready 边界先归档再判断是否压缩。它不调用 LLM。

- `findArchiveCutoff(roles, ARCHIVE_KEEP_TURNS)` 严格保留最近 2 个 user turn；
  不足 2 个或前面无消息则不归档，不采用压缩切点的回退规则。
- 切点前 assistant 中 `state === 'output-available'`、带 toolCallId、输出序列化
  后至少 500 字符且未归档的 tool part 才处理。
- 写入 `/context/tool-{清理后的toolCallId}.txt`；清理会删除非字母数字、下划线或
  连字符。通过 `vfs:write` 确认成功后才回写
  `[archived: path | head: 前200字符]`，头部空白折叠。
- 写入失败保留原文；回写前重新读取当前状态并按 toolCallId 匹配，避免异步写盘
  期间使用旧消息数组覆盖新状态。归档文件随 VFS 快照持久化。

每个 part 只改写一次，既保留需要时 `cat` 找回原文的能力，又避免旧版每个 step
回溯改写深层历史。当前 screenshot dataUrl 仍按通用文本归档，读取 base64 文本
不会恢复模型视觉，需要重新截图或使用合适的图片读取路径。

## Provider 适配与用量统计

[`createProvider()`](../src/shared/ai-provider.ts) 是聊天、标题和压缩共用的入口。
[`apiBaseUrl()`](../src/shared/api-endpoint.ts) 同时接受 API base URL 和粘贴的
`/chat/completions` / `/responses` URL，去掉末尾协议路径后交给对应适配器。

### Chat Completions

默认协议（未设置 `apiProtocol` 时也走此分支）使用 `@ai-sdk/openai-compatible`。
请求转换负责：

1. 注入有限数字的 temperature / topP / topK / minP / presencePenalty /
   repetitionPenalty / maxTokens；空值保留服务端默认。
2. 适配推理字段：SDK 不接受的 `max` 先映射为 `high`，请求转换再恢复。MiMo、
   智谱等部分官方域名使用 `thinking`，其他兼容网关可使用 `enable_thinking`；
   不向 OpenAI、DeepSeek、Moonshot 官方域名无差别发送该私有字段。
3. 仅当 `body.stream === true` 时加入 `stream_options.include_usage`。
4. screenshot 工具 JSON 中的 dataUrl 移出 tool 文本，在**连续 tool 消息组之后**
   插入 user 图片消息，保持 assistant tool_call 与所有 tool response 的配对。
5. 页面提取图片加在第一条 user 消息前，并提供与正文图片占位符的对应说明。
6. `supportsImages === false` 时过滤 image_url，空内容替为 `[image removed]`。

### Responses

`apiProtocol === 'responses'` 使用通用 `@ai-sdk/open-responses`，不是按厂商域名
选择另一套协议。启用 `strictResponseInput`，通过
[`responsesMiddleware()`](../src/shared/responses-middleware.ts) 处理多模态和推理元数据：

- screenshot 转为真正的多模态 tool output，页面图片注入首条 user 消息；关闭
  视觉时过滤图片。
- 保留推理内容、摘要及加密项，兼容历史会话中 `providerOptions.openai` 的元数据。
- 未指定 strict 的 function tool 显式设为 `false`，避免可选参数被规范化为必填 null。
- 采样参数支持 temperature、topP 和 maxOutputTokens；不能套用 Chat 分支全部私有参数。
- fetch 层固定 `store: false`，移除 `previous_response_id` / `conversation`，由完整
  本地会话历史承担上下文；请求加密推理内容，启用推理时默认请求摘要。
- 仅在 400 / 422 明确拒绝 `include` 或 `reasoning.summary` 时移除该可选增强参数
  后重试并记住结果；不删除用户指定的推理强度，也不重放已开始的生成流。

### 重试与统计

两种协议共用 `createRetryFetch()`。默认开启后端兼容时最多重试 5 次，关闭时
最多 3 次；HTTP 429 / 5xx 和网络错误使用退避，用户 abort 立即抛出。
兼容模式还检查被普通 4xx 包装的上游错误与 SSE 首帧中的限流错误，消费过的
正常首帧会重新送回流，避免丢文本。

[`usageMiddleware()`](../src/shared/usage-middleware.ts) 包裹流式和非流式调用，
把标准化的 input / output / cache read / cache write / reasoning 用量连同会话、
模型和服务标识发给 SW 的 `usage:record`。统计失败只警告，不把成功回复变成失败。
这也覆盖标题和压缩调用，不能只按主聊天请求估算全部费用。

## 标题与摘要调用

`generateTitle()` 是独立 `generateText()` 调用，不走 Agent 工具循环。它使用相同
配置协议和 sessionId，专用 `TITLE_SYSTEM` 将用户话题作为主依据，将回复摘要和
页面标题 / URL 作为辅助信息。`buildTitlePrompt()` 对各输入截取最多 200 字符，
转义 XML 特殊字符并放进标记区域，明确视为不可信数据。结果去引号、去尾标点，
截取 30 字符；空结果回退到用户消息前 30 字符。

发送管线通过 `visibleText()` 等消息协议辅助函数排除旧式零宽字符元数据及附件
内容，避免把 DOM 快照当标题。新消息协议细节见 [frontend.md](frontend.md)。

`compactContext()` 同样使用配置协议和 sessionId，专用摘要 prompt 保留 Active
Task / Progress / Key Findings / Page Context / Remaining Work，各输入消息最多
2000 字符。标题和压缩都以 SDK 7 的 `reasoning: 'none'` 请求最低推理开销；实际
支持情况由后端决定。

## 修改时的约束

- 所有宿主共享身份构建、Agent 指纹、压缩和归档实现，避免 panel / offscreen 漂移。
- `prepareCall` / `prepareStep` 只改请求副本；归档和压缩是有意回写持久消息状态，
  两者不能混为一谈。
- 配置、技能和记忆变更的即时生效范围取决于重建时机；不要声称每个 turn 都重新
  拼装全部上下文。
- 新增协议能力应放在对应 Provider / middleware 层，并同时检查聊天、标题、压缩
  三条调用链，而不是只修主聊天请求。
