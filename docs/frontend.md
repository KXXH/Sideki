# 前端与会话同步

本文以当前源码为准。产品展示名为 Sideki；`useSidekickChat`、`SidekickKernel`、`sidekick_*` 存储键等代码标识沿用原名。

MCP OAuth 新客户端注册使用 `client_name: 'Sideki'`。已有注册仍复用 `mcp_client_{serverId}` 下的 `client_id` 和 `mcp_tokens_{serverId}` 下的凭据，不因展示名变更清除授权；授权服务保存的旧客户端名称不会通过修改本地元数据自动更新。

## 两种宿主，一个内核模型

`ChatView` 从 `sidekick_config.labKernelHost` 选择宿主；只有显式配置为 `'panel'` 时使用面板宿主，缺省为 `'offscreen'`。

| 路径 | 状态与 Agent 的所有者 | 面板职责 |
|------|----------------------|----------|
| offscreen（默认） | `src/offscreen/main.ts` 创建的 `KernelPool` / `SessionRuntime` | `useKernelMirror` 发命令、渲染只读镜像 |
| panel（回退） | `useSidekickChat` 内的 `PanelKernel` / `KernelChat` | 本地订阅内核状态，并接线页面、配置和保存逻辑 |

当前没有使用 React SDK 的 `useChat` hook。`KernelChat` 继承 AI SDK 的 `AbstractChat`，把消息、状态和错误交给 `KernelChatState`；面板回退路径通过 `useSyncExternalStore` 接入 React。该订阅用 `throttleNotify(cb, 50)` 合并高频流式更新。

设置入口是 **设置 → 开发者 → 兼容性与故障排查 → 后台内核（Offscreen）**。这是手动回退开关；后台连接失败时，镜像路径会重连，并不会自动改为 panel 宿主。

## 默认路径：快照与增量同步

源码：`src/sidepanel/hooks/useKernelMirror.ts`、`src/shared/kernel/{sync-protocol,kernel-host,kernel-mux,kernel-pool}.ts`。

```text
ChatView / useSidekickChat
  → useKernelMirror → chrome.runtime.Port("kernel-sync")
  → KernelMux（一个 port 绑定一个 session）
  → KernelSyncHost → SessionRuntime → KernelChat / Agent
```

- 连接前请求 SW 的 `kernel:ensure-offscreen`；面板最多尝试 5 次，间隔 300ms，失败后 2s 再尝试。
- 连接后发送 `sync`，以完整 `snapshot` 建立基线；在线期间接收 `patch`。补丁必须匹配 `baseRev`，缺口或缺失消息会触发重新取快照。
- `KernelSyncHost` 默认以 80ms 窗口合并广播；消息采用 copy-on-write，只比较引用即可找出变化的消息。
- 命令带 UUID；全局命令由 `KernelMux` 去重，会话命令由内核去重。一次去重适用于收到相同 ID 的命令，不代表所有操作都有持久化的 exactly-once 保证。
- port 断开后 500ms 重连；首条握手消息 4s 内未到会重建连接。SW 检查现有 offscreen 文档时有 10s 启动宽限，之后最多 ping 两次（每次 1.5s），无响应才重建文档。
- `send` 会等待当前绑定就绪，默认最多 5s。上传期间若 port 或 session 绑定变化，会取消发送并保留输入与附件，避免写进另一个会话。
- 面板把 `document.visibilityState` 通过 `presence` 上报；后台结合 port 绑定判断会话是否有人正在观看，供完成通知使用。

`KernelPool` 只预加载会话索引，正文按需加载。被 port 或调度任务 retain 的 runtime 不会作为空闲项逐出，繁忙 runtime 同样保留。默认最多保温 3 个空闲 runtime，释放后的宽限为 30s；超过宽限不等于必然立即逐出，还取决于保温数量和运行状态。关闭面板不会终止仍在运行的 offscreen turn。

## 传输与 Agent 重建

两种宿主都让 `KernelChat` 持有稳定的 transport 包装器，真正的 `DirectChatTransport` 在 Agent 构建完成后写入可替换引用。发送前统一调用 `prepareOutgoingMessages()`，与 Dev 面板的出站消息预览使用同一处理管线。

Agent 按需构建：进入或新建会话不会立即提取页面、连接 MCP 并构建 Agent；第一次发送或重新生成时才准备。配置变化是否重建由共享的 `agentFingerprint()` 决定，包含：

- endpoint、model、apiKey、reasoningEffort、supportsImages；
- apiProtocol（缺省 Chat Completions）、systemPrompt、contextWindow、maxToolRounds、modelParams、disabledSkills、后端兼容模式；
- 已启用 MCP 服务器的 id、url、name、auth.type。

主题、字体和 MCP 的瞬时连接状态不在指纹内，避免仅因界面变化丢弃冻结提示词。系统提示词中的产品身份与配置模型名见 [agent.md](agent.md)。

页面内容在首条消息后锁定。已有 Agent 的冻结指令不会随用户切换 tab 重建；之后的操作目标由 turn 的 tab 栈决定，页面标题、URL 等通过造山带元数据补充。这与用户手动固定页面的 UI 开关不是同一机制。

## 会话存储与恢复

源码：`src/shared/storage.ts`、`src/sidepanel/components/StorageMigrationGate.tsx`。

会话存在 `chrome.storage.local`，VFS 文件另存 IndexedDB。当前存储布局：

| 键 | 内容 |
|----|------|
| `sidekick_session_index` | 不含消息正文的索引，包含 messageCount |
| `sidekick_session:{id}` | 单个完整 ChatSession |
| `sidekick_session_migration_status` | 迁移进度、完成或错误状态 |
| `history:{id}` | 上下文压缩前的历史消息 |

`loadSessionIndex()` 供列表使用，`loadSession(id)` 在打开会话时加载正文；`loadSessions()` 仍可供需要完整集合的流程使用。

`withSessionStorage()` 使用 `navigator.locks` 的 `sidekick-session-storage` 锁协调面板与 SW 的读写、导入及迁移。旧 `sidekick_sessions` 数组会先逐个写入正文，再发布索引，最后清理旧数组；未完成的迁移可以重试。删除也先记录待清理的正文 ID，以便中断后完成清理。`StorageMigrationGate` 展示进度、完成确认或重试入口。

这与旧消息格式转换是两件事：`migrateMessage()` 在会话加载时，把没有 id、使用旧 part 类型的消息转成 SDK `UIMessage`。

### 保存时机

- panel 回退路径：`ready` 且消息非空时，300ms 防抖保存；页面隐藏、卸载或切换会话时另有 flush。
- offscreen 路径：`wireTurnAutomation()` 订阅内核，`ready` 时只在消息引用变化后安排 300ms 防抖保存；流式状态下，距上次 checkpoint 超过 5s 的状态通知会触发一次保存。
- checkpoint 记录 `interrupted`；冷加载时若最后一条是 assistant，会补充 `metadata.interrupted`，新内核状态为 `ready`，可以继续发消息。

5s 是 checkpoint 的触发间隔，依赖状态通知和异步存储成功，不是任意崩溃下“最多丢 5s”的保证。

## 消息协议与附件

### 工具调用描述

15 个内置工具的输入均提供可选 `description`，要求模型先生成简短中文动作描述，再生成其他参数；不同模型及协议不保证字段顺序。该字段随正常工具调用生成，不额外请求 LLM；完整描述到达前、旧调用或缺失描述时保留原始工具名，不生成中文兜底。MCP 工具不改写其 schema，也不把其业务参数 `description` 当作显示标题。

「外观 → 显示工具操作描述」开关对应 `toolCallDisplay: 'description' | 'raw'`，缺失时默认开启。描述未到时保留工具名和流式参数摘要；关闭后始终显示工具名和参数摘要。切换仅影响当前及历史工具卡呈现，不改工具 schema、调用输入、持久化消息、模型请求或页面指示器；`description` 仍生成并保留，自动审批不使用该展示描述作为授权证据。

输入框权限菜单设置当前对话的 `permissionMode`（请求批准、自动审批、全部允许），随会话保存；三种模式分别使用问号盾牌、勾选盾牌与感叹号盾牌图标，收起的菜单入口也显示当前模式图标。「全部允许」的入口、菜单图标和名称使用主题 warning 色高亮，选中与展开时使用浅警示色背景。设置页只修改新对话的 `defaultPermissionMode`。工具卡在确认期间显示「确认操作…」与中性实心盾牌；拒绝使用红色实心盾牌、中央镂空 X 与浅红底、红字、微圆角的「已拒绝」Tag，文字与低透明度底色均跟随主题 error token；审批执行异常显示琥珀色盾牌「确认异常」，工具调用出错使用红色实心感叹号圆圈「调用失败」。状态保持单行，参数和原因仅由用户点击展开，状态变化不自动展开。详见 [权限与审批](permissions.md)。

流式阶段由 `src/shared/tool-description.ts` 检查 SDK part 的 `rawInput`，只在顶层 `description` 字符串闭合且可解析后发布完整文案，兼容转义引号、嵌套对象及命令先到。卡片通过原有 `SwapSlot` 过渡替换标题，后续命令 token 不重复触发标题动画；展开仍显示工具名、实际参数及结果。折叠组保留阶段文案和步骤计数，不生成组合标题。

两宿主通过 `src/shared/kernel/tool-activity.ts` 订阅内核，发送去重的 `tab-lock:activity`；默认后台路径不依赖面板可见性。SW 仅向该 session 当前持有的操作栈顶页面投影描述，不因此获取锁或选择窗口 active tab。页面灵动岛的展示节奏见 [Tab 模型](background-task-tab-model.md)。

### 消息与附件格式

源码：`src/shared/message-protocol.ts`、`src/shared/attachment-mirror.ts`、`AttachmentPreview.tsx`、`MessageList.tsx`。

当前写入的消息使用 v2 结构，`metadata.v = 2`：

| 位置 | 内容 |
|------|------|
| `text` part | 用户可见文本 |
| `file` part | 发给模型的图片 |
| `data-element` | 元素 label 与 DOM snapshot |
| `data-skill` | skill 名称与正文 |
| `data-file` | 已上传文件的名称、大小与 VFS 路径，用于 UI 记录 |
| metadata | bridge/timer 来源、回传标记、发送时页面信息、模型可见的附件路径说明 |

圈选元素、聊天文本选择、右键菜单「添加到 Sideki 上下文」和文件上传都进入附件流程。发送准备时先固定目标会话，普通文件经 `prepareFileAttachments()` 写入 VFS；`mirrorAttachments()` 生成模型需要的文件路径说明。消息先进入准备状态，提交时用新的 parts / metadata 对象替换，避免原地修改既有缓存引用。

`visibleText()` 用于 UI、标题生成和 bridge 回传。`expandForModel()` 在发送副本中将 skill、元素快照、附件路径及来源标签合成模型文本，图片 file part 保留。`prepareOutgoingMessages()` 还会把被中断而未完成的 tool call 转成 output-error，避免向 API 发送缺结果的调用。

零宽字符 `U+200B` 仅是旧消息的兼容协议；不再作为新附件、skill 或 bridge 标记的默认存储方式。带 v2 标记的文本不会按零宽字符拆分。

## 流式显示与用量

`StreamingMarkdown` 使用 **Streamdown**，加载 `@streamdown/math`、`@streamdown/cjk` 和 KaTeX 样式；不再使用 `react-markdown` / remark 插件栈。单美元公式由 `labSingleDollarMath` 控制，默认关闭。渲染器跟随开关更新；模型只在克拉通构建时读取该值，关闭时提示避免行内公式，开启时不追加公式提示。切换开关不触发克拉通重建。

流式正文按新增字符做 180ms 淡入，不使用逐词 stagger 或跨块播放积压，避免英文半个单词及连续中文漏播、旧段落延迟补播。结束后移除动画包装；系统开启减少动态效果时禁用正文淡入。

自定义 components 将标题、表格、代码、引用与链接映射到主题 token。代码块未完成时暂不语法高亮，完成后交给 `code-highlight.ts`；横向溢出表格按滚动位置更新提示。

标题采用留白分组：H1/H2 无分隔线，字号为正文的 1.5/1.3 倍、行高 1.45；H3 为 1.15 倍、H4–H6 与正文同字号，行高 1.5，通过字重、文字色和段前留白区分层级。不改动现有 12/13/14px 字号映射，流式期间保持自然换行。有序列表保留 Markdown 的 `start`，并同步初始化每层独立的 CSS 计数器，支持非 1 起始与嵌套续号。

正文以 `overflow-wrap: anywhere` 为长链接、标识符与行内代码兜底换行，并通过 `text-autospace: normal` 增加中西文间距，不修改消息原文。代码和公式禁用自动间距，围栏代码保留原始断行与横向滚动。

`DirectChatTransport.messageMetadata` 在两宿主中按相同口径采集：

| 事件 | 作用 |
|------|------|
| `start` | 重置本轮统计 |
| `reasoning-start/end` | 累计推理耗时 |
| `finish-step` | 记录最新 step 输入 token，累加 SDK stepTimeMs，保留首个可用 TTFT 与最近 step 速度 |
| `finish` | 写入 completionTokens、promptTokens、reasoningTokens、elapsed、ttft、reasoningElapsed、speed |

上下文表优先显示最新 step 的输入 token，而非多步调用输入 token 的累计和。冷加载时回退到历史消息的 `promptTokens`；没有精确值才用文本字符数 / 3 与 1200 token 工具开销估算。panel 估算包含当前页面内容；镜像缺少页面全文时只估算消息。估算不是模型 tokenizer 的精确计数。

用量统计通过 provider 级 `usageMiddleware` 逐次记录，和上述聊天上下文表独立。事件及聚合行包含 `source: 'main' | 'approval'`；同一天、会话、provider/model 的主会话与审批分别聚合，审批归属真实父会话。传输用的 `x-session-id: approval:{requestId}` 与统计身份分离。未带 source 的旧普通记录按 main 处理，旧 `approval:*` 记录按 approval 处理；缺少父会话信息时显示「历史自动审批（未关联会话）」，不猜测归属、不丢弃或重复计数。

「用量统计」支持时间、Provider、全部／主会话／自动审批来源与会话名称/ID 搜索，筛选同时作用于总量、缓存命中率、每日图表、Provider/Session 明细与 CSV 导出。明细默认 Session 维度、按最近使用排序，也可按用量或请求次数排序。会话是父项，合计当前筛选下主会话与自动审批的用量；展开后分别显示主会话、自动审批子项及各自缓存与模型明细。Provider 维度同样按 Provider/model 作父项、来源作子项；旧审批数据仍留在未关联的历史审批父项。每页渲染 10 个父项，主会话与审批子项不跨页拆分；支持前后翻页和页码跳转，筛选、排序或维度变化回到第一页，实时裁剪后页码自动限制在有效范围。分页不限制汇总、图表或导出的记录范围，CSV 仍按原始聚合行输出并包含 source 列，不额外插入父项合计以免重复计数。

每条聚合行的可选 `lastAt` 保存实际模型调用事件的最大时间戳，延迟到达的旧事件不使它倒退；明细展示该最近使用时间，CSV 的 last_used_at 列输出 ISO 时间。旧行没有该字段时仅以统计日期排序和显示，不借用会话改名等元数据更新时间，不伪造时分。搜索只读取会话索引，不加载消息正文。缓存读写、推理与缺失字段口径沿用原逻辑。统计开关与 90 天／1 MiB 保留上限保持不变。

## 压缩历史与队列

工具归档和 LLM 压缩由内核实现，两宿主分别触发，详见 [agent.md](agent.md)。`labAutoCompress` 控制两者；压缩在空闲时、上下文达到 80%、距上次至少 30s 时触发。压缩前历史存在 `history:{sessionId}`，UI 默认折叠灰显；活动消息正常显示，`COMPACT_MSG_ID = '__context_summary__'` 以分隔线渲染。

`SidekickKernel` 管理 FIFO 队列，面板渲染 `QueueStrip`，可删除或取回编辑。繁忙不仅包括 `submitted/streaming`，还包括 preparing、dispatching 和 compacting；仅用 SDK status 判断会遗漏准备中的发送。队列连续执行期间保留 tab 栈，避免用户切 tab 把下一条排队操作重定向。错误状态不会自动排空队列。

## 画布与文件预览

### 聊天内交互画布

`MessageList` 识别 visualize 工具结果并渲染 `VizFrame`。工具的 `network` 参数继续决定画布模式；返回的 `previewPath` 是附带 `?network=1` 或 `?network=0` 的 VFS Markdown 路径。`VizFrame` 的新标签页打开链接也显式携带当前 `network` 模式。宿主读取对应 VFS HTML，再通过消息发给 manifest sandbox iframe；离线与联网模式分别使用 `src/viz/sandbox.html` 和 `sandbox-online.html`。两者由 `sandbox.src.html` 和生成脚本维护，不应手改生成文件。

`VizFrame` 校验 `event.source` 与实例 nonce，接收 ready、resize、render/error 等消息，并把当前界面的主题映射为稳定 CSS 别名。高度由 iframe 报告，限制在 96–20000px。sandbox 无扩展页面权限；默认离线模式还有更严格的 meta CSP。此链路独立于下面的新标签页预览。

### VFS 新标签页预览

Markdown 链接匹配 `/tmp/`、`/page/`、`/viz/` 时转为 `VfsLink`。HTML/HTM/SVG 和常见图片打开 `src/preview/index.html?session=...&file=...&network=1|0`；VFS 路径和 Query 分开处理，其他文件直接通过 `dev:cat` 读取并下载。独立 HTML 可直接使用 `[查看](/viz/report.html?network=1)`，无需先调用 `visualize`。

新标签页由 `src/preview/main.ts` / `preview-host.ts` 独立管理页面生命周期、工具栏、读文件、错误与重试；不再把生成 HTML 直接放在扩展同源 iframe 中，也不依赖预览 Web SW 的 client 选择来识别会话。打开时仅非阻塞注销旧 `/src/preview/` scope 的历史 registration，不等待其 ready 或 controller。

```text
预览页面（扩展页，固定 URL 中的 sessionId / file / network）
  → 仅按 Query 解析 network：1 为 true，0 / 缺失 / 无效值为 false
  → dev:cat 读取 HTML
  → validateHtmlArtifact：与画布一致的内容能力校验
  → 按 network 选择 manifest offline / online sandbox
  → ready 握手后 postMessage HTML、实例 nonce 和主题
  → 接收带同一 nonce 的 rendered / error，使用真实视口而非聊天自动高度
```

URL Query 是新标签页唯一的联网配置：只有 `network=1` 开启，`network=0`、缺失、空值、重复参数及其他值（包括 `true`）均离线。不再写入或读取 `.meta.json` 能力 sidecar；已有 sidecar 不论内容如何都忽略，也不清理用户文件。离线与联网的运行边界、完整文档/片段、主题 token 与脚本规则和画布共享，显示入口不额外赋予 VFS 相对资源、扩展 API、宿主页面或登录态访问能力。

每次文件读取最多等待 10s；iframe 握手与首次执行最多等待 12s。宿主同时校验 `event.source` 与 nonce，旧 iframe 的消息不影响重试后的页面，已报告的执行错误不会被后续 rendered 确认隐藏。页面跟随保存的主题/明暗配置，并从来源会话索引恢复 Pro 的深色模式；主题变更通过同一变量协议传入 sandbox。内容区域使用真实视口并在 iframe 内滚动，由预览自身管理。

图片从 VFS 读取后把 Latin-1 字符串恢复为字节再创建 Blob URL，避免 UTF-8 重新编码损坏二进制。工具栏“下载原文件”只下载当前 VFS 文件，并不打包依赖或转换为可离线运行的网站。

## 主题、设置与新手引导

源码：`src/shared/themes.ts`、`src/sidepanel/default-config.ts`、`SettingsView.tsx`、`UpdateIntro.tsx`。

- 默认主题为 `swiss`（瑞士红），默认明暗模式为 `system`。主题同时提供色值、圆角/边框和表面材质 token；旧主题 ID 由 normalize 逻辑兼容。
- Pro 固定石墨色中性底与深色模式，强调色、气泡等沿用所选主题的 dark 配色，不是强制琥珀色。
- 后台内核、拟真操作、异步脚本、后端兼容模式默认开启，保留在开发者的兼容性折叠区。
- 页面工作指示器与 AI 操作指针是独立开关；图片副本与大文件上传也是独立开关。
- `UpdateIntro` 共用新手和更新介绍。新手流程是 chat → themes → connect → canvas；更新介绍省略 connect。主题和模型在引导中可以保存，设置页面需接收最新配置，避免旧自动保存覆盖引导结果。
