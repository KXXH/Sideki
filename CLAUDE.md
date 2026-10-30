# Sideki 开发指引

## 产品与技术标识

Sideki 是 Manifest V3 Chrome 侧面板 AI 助手，提供页面理解、浏览器自动化、PDF 阅读批注、内嵌画布、定时唤醒与 CDP 调试。React + TypeScript + Vite + TailwindCSS v4，使用 Vercel AI SDK 7。

产品与 `manifest.name` 均为 **Sideki**。兼容性标识仍用 `sidekick`：npm 包名、内部 `SidekickKernel` / `useSidekickChat` 类型与函数、存储键、备份格式、服务目录和 MCP client name 不因品牌改名而替换。更新应在原加载目录重新加载现有扩展，不能把换目录或卸载重装当作普通升级。

详细技术文档从 [docs/README.md](docs/README.md) 开始，以源码为准；历史行为看 `CHANGELOG.md`。

## Build & test

```bash
npm run dev          # 端口 5174，HMR，开发扩展输出 dist-dev/
npm run build        # prebuild 生成画布 sandbox，再 tsc -b + vite build → dist/
npm test             # vitest run
npm run test:watch
npm run lint
```

Chrome 加载 `dist/` 可独立运行；加载 `dist-dev/` 需要保持 Vite dev server。Service Worker 由 `@crxjs/vite-plugin` 从 manifest 打包。不要把开发 server loader 覆盖到独立发布目录。

## 三个核心运行环境

1. **Service Worker (`src/background/`)**：无 DOM / `window`。消息路由、Chrome API 工具、Bash/VFS、CDP、Tab 栈锁、自动任务、WS Bridge、备份与 offscreen 环境代理。
2. **Offscreen (`src/offscreen/`)**：默认模型执行宿主；有 DOM 和 fetch，扩展 API 仅使用 runtime，storage/tabs/scripting 经 SW 的 `env:*` 消息代理。`KernelPool` 管理每会话 `SessionRuntime`，`KernelMux` 将面板 port 绑定到对应会话。
3. **Side Panel (`src/sidepanel/`)**：React UI。默认 `useKernelMirror` 订阅 offscreen 状态；`labKernelHost: 'panel'` 时由面板本地内核运行。`KernelChat` + `useSyncExternalStore` 已替换旧 `useChat`。

面板关闭不终止默认 offscreen 中的 turn。绑定/忙碌/准备/压缩/有队列的 runtime 不驱逐；默认未绑定宽限 30 秒，空闲保温上限 3 个。切宿主是排障回退，不是运行中任务热迁移。

额外文档上下文：`src/preview/`（VFS 新标签页预览）、`src/reader/`（PDF 阅读器）、`src/viz/`（内嵌画布 sandbox）。

## Chat / Pro 与默认开关

| 维度 | Chat | Pro |
|---|---|---|
| 定位 | 日常浏览助手 | 专业调试协作 |
| 页面正文 | 首次提取后冻结 | 按需读取 |
| debug 命令 | 不注册 | 注册 CDP 命令 |
| 常规工具确认 | securityLevel / yoloMode / 站点授权 | 同一判断，不因 Pro mode 自动全部跳过 |
| stdout / stderr 各自截断 | 8192 字符、200 行 | 65536 字符、2000 行 |
| Bash 超时 | 5 秒 | 30 秒 |
| 默认 VFS 单文件 / 会话 | 32 MiB / 64 MiB | 同左 |
| 关闭 largeFileUploads 后 | 500 KiB / 2 MiB | 5 MiB / 20 MiB |
| CC Bridge | 无 | WS 双向连接 |

`requireConsent` / debugger 授权以 permissive 或 yoloMode 放行，站点授权仅覆盖部分交互/导航。Pro 安装 monitor 有单独的免普通操作确认路径，CSP debugger 回退仍有独立授权，不推广为全局规则。

`DEFAULT_CONFIG`：瑞士红主题、system 色彩模式、strict、yolo 关闭、10 轮工具预算、200000 上下文窗口；后台内核、拟真输入、异步脚本、后端兼容、自动压缩、大文件上传、AI 指针、页面工作指示器和完成通知默认开启。`labFetch`、`labImageFs` 默认未开启。

四个技术开关在「开发者 → 兼容性与故障排查」。`labImageFs` 只控制图片副本，`largeFileUploads` 独立控制容量；`aiPointer` 只控制指针显示，关闭不改变输入引擎。Pro 固定深色石墨中性色，accent 跟随所选主题 dark 色组。

## Agent 与上下文

基础工具由 `createAgentTools` 注册，共 15 个：click、hover、type、select、keypress、scroll、screenshot、wait、navigate、getPageContent、bash、visualize、useSkill、schedule、monitor；MCP 额外动态加入。

`buildAgentIdentity` 明确身份为 **Sideki**，并单独注明 `config.model` 的用户配置模型标识。不要将配置模型名当作产品身份或已验证的真实底层模型身份。

三级上下文：

- **克拉通**：`buildFrozenInstructions` 在 agent 创建时冻结，包含模式提示词、技能索引、global/site 记忆；无页面时使用简化 fallback。首次 send/regenerate 惰性准备；配置指纹变化或冷加载可能重建，单纯 tab 切换不重建。`agentFingerprint` 共用于两宿主，包含协议、endpoint/model/key、推理/视觉、系统提示词、窗口、步数、采样参数、禁用技能、后端兼容与启用 MCP 配置。
- **地体**：`SidekickKernel.compactNow` 压缩历史。宿主在 ready、用量至少 80%、冷却至少 30 秒且开关开启时触发。通常保留最近 3 个 user turn，不足时退为保留最近 1 个；原历史写 `history:{sessionId}` 供 UI 回看。摘要消息标识 `__context_summary__`。
- **造山带**：`prepareCall` 在发给模型的最后一条用户消息副本追加 page/debug 元数据。`prepareStep` 只在尾部追加 todo（从请求尾部累计至少 8 条 assistant 消息未见 TODO 活动）和 step-budget（80%/95%）提醒，不能回溯改写早期请求前缀。monitor 唤醒有独立 20 步预算。

工具归档由共享 `SidekickKernel.archiveNow` 执行，offscreen 边界触发在 `turn-automation.ts`，panel 有自己的 effect 接线。最近 2 个 user turn 保护窗口之前、序列化至少 500 字符的可归档 output 写 `/context/tool-{清理后的toolCallId}.txt`；确认持久写成功后回写含前 200 字符的 stub。每个 part 只归档一次；不得恢复成每步回扫改写。归档不调用 LLM，和压缩共用 `labAutoCompress`。

`prepareCall` 只修改请求副本；归档/压缩则有意回写内核消息。UI 的 HistoryMessages 与 CurrentMessages 分区显示历史和活跃消息。

Provider 支持 Chat Completions / Open Responses，两条协议的截图、推理、usage 与重试适配不同，以 `ai-provider.ts` / `responses-middleware.ts` 为准，不按旧 Chat-only 文档扩展新逻辑。

## VFS 与技能

`just-bash` 是虚拟 shell，不是宿主 OS。每会话独立 FS，快照存 IndexedDB `shellfs:{sessionId}`。`withSessionLock` 串行化 exec、外部写入、上传和 PDF 批注。

- `/page/` 导航清理；`/tmp/`、`/notes/`、`/viz/`、`/context/` 和 todo 纳入快照。
- `/memory/` 与内置技能从源头投影；已注册用户技能可写。未注册技能目录不持久化。
- tab 或容量/网络配置变化时重建 Bash 命令闭包，复用 live FS，不从旧快照覆盖内存。
- VFS 变更当前校验容量并 **await 落盘**，失败恢复纳入 before 快照的文件；不再是 fire-and-forget，不回滚浏览器外部副作用。外部 `vfs:write` 允许 `/context/`、`/tmp/`、`/viz/`。
- 大文件开关关闭后保留旧文件；新增/改动文件受当前单文件限制，会话总量保留既有普通文件总量基线，公式见 Shell 文档。容量主要以字符串 length 计量。
- `labFetch` 开启后内建网络允许 GET/HEAD，512 KiB/10 秒，当前允许内网（`denyPrivateRanges:false`）。`http-put` 是独立受网络开关和 consent 控制的 PUT/POST 上传路径。

内置技能唯一源码 `src/skills/`，`skills.ts` 用 eager `import.meta.glob(... ?raw)` 构建时内联并同步注册，不存在 `loadSkills` / 运行时 fetch 加载流程。当前八个技能：debug、seo-audit、accessibility、performance、chrome、skill-creator、dingtalk-docs、canvas。

用户技能在 `chrome.storage.local['userSkills']`，含 description/content/files?/createdAt。通过 `skill create` 注册后，AI 可以编辑 `/skills/{name}/` 支持文件。exec 后验证、警告写 stderr，再 await 同步 storage；正文创建上限 50000 字符，支持文件 100 KiB、20 个、总量 200 KiB 的具体入口行为见 [docs/skills.md](docs/skills.md)。模式和 disabledSkills 没有在所有入口强制传入，不可视为完整安全边界。

## 消息、存储与功能边界

- 会话采用 chrome.storage 索引 `sidekick_session_index` + 每会话 `sidekick_session:{id}`；旧数组在 `navigator.locks` 下迁移，正文持久后才发布索引。
- 消息协议 v2 使用结构化 `data-skill` / `data-element` 等 parts 和 metadata；零宽字符协议只为旧消息兼容。发给模型时展开请求副本。
- Markdown 使用 `streamdown` 及 CJK/math 支持，不是 react-markdown 插件栈。
- 画布与新标签页 HTML 预览共用 `html-artifact.ts` 能力契约：自包含完整 HTML/片段、内联脚本、同一主题、默认离线、显式 HTTPS/WSS 联网；不提供相对/VFS 文件依赖、宿主DOM、Chrome/Node API、登录态继承、外部导航或表单提交。
- `visualize` 接受 `/viz/` 下 HTML/HTM/SVG，`network` 参数仍控制画布执行模式；工具返回的 `previewPath` 是带 `?network=1|0` 的 VFS Markdown 路径，`VizFrame` 的新标签页链接也携带模式。新标签页仅按 URL Query 配置网络：`network=1` 为 true，`network=0`、缺失或无效值为 false，不再读取 `.meta.json`，也不清理用户旧文件。直接独立 HTML 可用 `[查看](/viz/report.html?network=1)` 开启联网，不要求先调用 `visualize`。
- 两条宿主链路独立：`VizFrame` 管聊天渲染，`preview/main.ts` / `preview-host.ts` 管新标签页。复用 manifest offline/online sandbox、校验与主题协议；预览不再注册 Web SW，不能恢复成直接在扩展同源 iframe 执行生成HTML。详见 [docs/html-artifacts.md](docs/html-artifacts.md)。
- `schedule` / `monitor` 依赖 offscreen，任务绑定现有 tab，不自动新建 inactive 空白页。浏览器重启后需重新确认绑定/恢复；具体栈和触发行为见 Tab 文档。
- CC Bridge 为 `tools/sidekick-bridge/` 的 Node WS+HTTP :9111；备份 daemon :9333，目录 `~/.sidekick-backup/`。两个服务不能混同。Bridge 主动输入仍依赖面板。

## 核心约束与代码规范

- Background 禁止动态 `import()`，依赖用顶层静态 import，防 shared chunk 带入 DOM 依赖。eager 字符串 glob 与运行时 chunk 加载不同；修改后须验证 SW bundle。
- `executeScript` 注入函数不能引用外部闭包。`element-resolver.ts` 通过安装页内 `__skResolve` 共享解析逻辑。
- SW 持久唤醒用 `chrome.alarms`；短执行超时/重试中的 setTimeout 不提供跨挂起保证。
- JS 默认异步 MAIN world 执行，配置关闭时走兼容路径；CSP debugger 回退与输入 CDP 的授权独立核实，不假设 Pro 自动授权。
- 工具 target 由 turn 的 Tab 栈固定；不要通过每步窗口 active tab 改写目标。队列续跑可保留同一操作栈。
- 注释用 `// Reason: ...` 解释 why；代码注释英文，UI 中文。
- `.ts` 文件 kebab-case，React 组件 PascalCase；消息类型沿用 `tool:*` / `env:*` / `bridge:*` 等既有协议。
- 样式使用 TailwindCSS v4 与 `--color-*` tokens，避免写死 Chat/Pro 的主题色。
- 测试在 `tests/unit/` / `tests/integration/`，`tests/setup.ts` mock Chrome。只为必要行为写有效测试，不为静态文案堆镜像测试。

## 源码导航与 SDK

| 目录/文件 | 职责 |
|---|---|
| `src/shared/kernel/` | KernelChatState、队列/压缩归档、runtime、pool、mux、同步协议、turn automation |
| `src/shared/agent.ts` | 系统提示词、ToolLoopAgent、请求元数据 |
| `src/shared/message-protocol.ts` | 消息 v2、旧消息兼容、请求展开 |
| `src/shared/ai-provider.ts`、`responses-middleware.ts` | 模型协议和后端适配 |
| `src/background/` | Chrome 工具、Shell、CDP、锁、调度、备份、Bridge |
| `src/sidepanel/hooks/useSidekickChat.ts`、`useKernelMirror.ts` | panel 回退与后台镜像接线 |
| `src/skills/` | 内置技能与支持文件 |

当前依赖版本以 `package.json` / lockfile 为准。AI SDK 的 `DirectChatTransport`、`ToolLoopAgent`、`AbstractChat` 可在 `node_modules/ai/src/` 查实现；当前 UI 不使用 useChat。just-bash API 直接查 `node_modules/just-bash/src/`。
