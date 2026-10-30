# Sideki 架构

## 运行环境与职责

核心是三个运行环境，默认模型执行宿主为 offscreen，另有 panel 回退路径。

| 环境 | 能力与职责 | 代码入口 |
|---|---|---|
| Service Worker | 无 DOM / `window`；Chrome API、消息路由、工具执行、Bash/VFS、CDP、Tab 锁、自动任务、Bridge 和备份 | [`service-worker.ts`](../src/background/service-worker.ts) |
| Offscreen document | 有 DOM、可直接 `fetch` 模型服务；扩展 API 仅使用 `chrome.runtime`，存储和页面操作经 SW 的 `env:*` / `tool:*` 代理 | [`offscreen/main.ts`](../src/offscreen/main.ts) |
| Side Panel | React UI、配置、附件、会话选择；默认镜像后台内核，回退模式在面板本地执行内核 | [`useSidekickChat.ts`](../src/sidepanel/hooks/useSidekickChat.ts) |

[`DEFAULT_CONFIG`](../src/sidepanel/default-config.ts) 的 `labKernelHost` 为 `offscreen`。排障时可在「开发者 → 兼容性与故障排查」切回 `panel`；关闭后台内核会关闭 offscreen 文档，不能再依赖关面板后持续执行。

Offscreen 的 `KernelPool` 按会话创建 `SessionRuntime`，`KernelMux` 按 port 绑定路由到该会话的 `KernelSyncHost`。绑定中、执行中、准备中、压缩中或仍有队列的 runtime 不驱逐。未绑定 runtime 默认宽限 30 秒，超出默认 3 个空闲保温名额后按释放时间驱逐；不是每 30 秒无条件销毁所有空闲会话。

另有三个 UI 文档上下文：`src/preview/` 提供 VFS 新标签页预览，`src/reader/` 提供 PDF 阅读和批注，`src/viz/` 提供内嵌画布 sandbox。

## 消息与工具链路

```text
ChatView.handleSend
  → 默认：useKernelMirror 命令 → KernelMux → SessionRuntime
    回退：panel 本地 SidekickKernel
  → KernelChat → DirectChatTransport → ToolLoopAgent
  → createAgentTools(ctx) → tool:* 消息
  → Service Worker → handleToolMessage / execBash
  → scripting.executeScript / chrome.debugger / Chrome API
```

基础工具由 [`tools/index.ts`](../src/shared/tools/index.ts) 注册，共 15 个：`click`、`hover`、`type`、`select`、`keypress`、`scroll`、`screenshot`、`wait`、`navigate`、`getPageContent`、`bash`、`visualize`、`useSkill`、`schedule`、`monitor`。启用的 MCP 服务可额外增加工具，不计入这 15 个。

普通请求/响应使用 `runtime.sendMessage`；后台内核与面板状态同步使用 `runtime.connect` port、rev 快照和增量 patch。不要将旧的「全项目不使用长连接」说明用于内核同步。

每个后台 agent 通过 `ToolCallCtx` 绑定会话和页面，避免并发会话共用模块级 session/tab。SW 的 Tab 栈与锁负责 turn 内页面归属，详见 [Tab 模型](background-task-tab-model.md)。

## Chat 与 Pro

| 维度 | Chat | Pro |
|---|---|---|
| 用途 | 页面理解、日常操作 | CDP 调试和开发协作 |
| 页面正文 | 首次准备上下文时提取并冻结 | 不预注入正文，按需读取 |
| `debug` 命令与技能 | 无 debug 命令；技能索引按模式筛选 | 注册 debug 命令，提供调试技能 |
| 操作确认 | 对话级请求批准 / 自动审批 / 全部允许；保留站点授权 | 同一授权判断；session mode 本身不自动放行 |
| stdout / stderr 截断 | 各 8192 字符 / 200 行 | 各 65536 字符 / 2000 行 |
| Bash 执行预算 | 5 秒 | 30 秒 |
| 默认 VFS 容量 | 单文件 32 MiB、会话 64 MiB | 同左 |
| 关闭大文件上传后 | 单文件 500 KiB、会话 2 MiB | 单文件 5 MiB、会话 20 MiB |
| CC Bridge | 无 | 本地 WS 双向连接 |

截断代码以 JS 字符串 `.length` / `.slice` 计量，尽管返回提示写 bytes，不能将其当作 UTF-8 字节精确上限。文件容量计量和保留旧大文件的规则见 [Shell](shell.md)。

主 agent 在 SDK 工具执行前应用对话权限；自动审批通过后由后台签发绑定一次完整调用的授权，Bash 内部普通确认不重复审批。请求批准沿用普通操作确认和站点授权；独立 debugger/CSP 能力授权仍保留。旧 `securityLevel` / `yoloMode` 用于迁移与非主 agent 入口兼容，不作为新对话权限 UI。详见 [权限与审批](permissions.md)。

Pro 固定深色石墨中性色，强调色跟随所选主题的 dark 色组，并非固定琥珀色。

## 状态与持久化

| 数据 | 位置 |
|---|---|
| 配置、会话索引和每会话正文、压缩历史、用户技能、自动任务等 | `chrome.storage.local` |
| VFS 快照 `shellfs:{sessionId}`、全局/站点/笔记记忆 | IndexedDB（`idb-keyval`） |
| 活跃消息、队列和运行状态 | `KernelChatState` / `SidekickKernel`，按宿主同步到 UI |
| CDP 缓冲、Bash 实例、Tab 锁 | SW 内存；不要假设 SW 永久存活 |

会话存储采用 `sidekick_session_index` + `sidekick_session:{id}`。旧 `sidekick_sessions` 数组在 `withSessionStorage` 的 Web Lock 内迁移；全部正文写入成功后才发布索引，再清理旧键。VFS 与会话正文不是同一个数据库。

Offscreen 在流式状态通知时节流写 checkpoint（5 秒间隔），turn 结束保存，并按开关和阈值条件运行归档/压缩。恢复只到最后成功落盘的状态，不承诺 Chrome 崩溃时零数据损失。

产品展示名和 manifest 名称为 Sideki，技术标识继续用 `sidekick`。更新时保持原加载目录并重新加载现有扩展；改名不会自动迁移到另一个扩展 ID，卸载也不是正常升级步骤。

## 关键约束

1. **SW 无 DOM**：页面注入函数中的 `window` / `document` 属于目标网页，不能在 SW 顶层使用。Offscreen/reader/sidepanel 则有 DOM。
2. **禁止 background 动态 `import()`**：使用顶层静态依赖，防止构建把含 DOM 依赖的共享 chunk 带入 SW。当前技能使用构建时 eager glob 内联字符串，见 [skills.md](skills.md)。
3. **注入函数自包含**：`executeScript` 序列化后无法引用模块闭包。共享 resolver 通过 `installResolver` 注入页内 `__skResolve`，执行函数再读取该已安装对象。
4. **区分持久调度与短延迟**：SW 跨挂起任务用 `chrome.alarms`；源码也有短时执行预算/重试的 `setTimeout`，不能将其解释成跨挂起保证。后台内核有自己的文档生命周期。
5. **上下文冻结**：`buildFrozenInstructions` 在 agent 创建时构建；首次发送、配置指纹变化、冷加载等由宿主管理，不因每次 tab 激活重建。动态页面/调试元数据在请求副本末尾注入。
6. **HTML 能力契约一致，宿主独立**：画布和新标签页都运行在 manifest sandbox，复用预检、主题协议与基础渲染器。新标签页不注册预览 Web SW，不直接运行 VFS HTML；两者保留独立加载与错误处理，详见 [HTML 成果](html-artifacts.md)。

## 代码导航

- 内核：`src/shared/kernel/`、`src/sidepanel/hooks/useKernelMirror.ts`。
- 模型协议：`src/shared/ai-provider.ts`、`responses-middleware.ts`、`api-endpoint.ts`。
- 消息协议：`src/shared/message-protocol.ts`。
- 页面能力：`src/background/tool-handlers.ts`、`element-resolver.ts`、`src/shared/input/`。
- 文件和技能：`src/background/shell.ts`、`shell-commands.ts`、`src/shared/skills.ts`。
- 自动任务：`src/background/scheduled-tasks.ts`、`monitor-page.ts`、`src/shared/scheduled-task.ts`。
