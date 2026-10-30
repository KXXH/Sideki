# Sideki 技术文档

以当前源码、`package.json` 和 `manifest.json` 为准。产品名为 Sideki；`sidekick_*` 存储键、内部类型、工具目录和备份名称保留历史命名，用于兼容既有数据与调用方。

## 运行链路

```text
Side Panel (React)
  ├─ 默认：useKernelMirror ── runtime port ── Offscreen document
  │                                     KernelMux → KernelPool
  │                                     → SessionRuntime → KernelChat
  └─ 回退：panel 本地 KernelChat                   │
                      DirectChatTransport / ToolLoopAgent
                                               │
                      chrome.runtime.sendMessage
                                               ▼
Service Worker：工具、Shell/VFS、CDP、Tab 锁、调度/监听、Bridge、备份
  ├─ scripting / debugger → 页面
  ├─ IndexedDB + chrome.storage.local
  └─ 本地 Node 服务：CC Bridge :9111 / 备份 daemon :9333
```

Offscreen 承担模型请求与工具循环，面板关闭后仍可继续；SW 承担 Chrome API 和持久化代理。预览、PDF 阅读器、画布 sandbox 是额外的文档上下文，不与 SW 混用 DOM 能力。

## 文档索引

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 运行环境、模式、安全与通信、持久化分工 |
| [agent.md](agent.md) | Sideki 身份、模型配置、提示词缓存、工具归档、压缩与 Provider |
| [html-artifacts.md](html-artifacts.md) | 画布与新标签页统一能力契约、独立宿主、联网模式继承 |
| [frontend.md](frontend.md) | Kernel 镜像、会话管理、消息协议、Streamdown、附件、画布与主题 |
| [browser.md](browser.md) | 元素解析、输入引擎、JS 执行、授权与截图 |
| [shell.md](shell.md) | Bash 实例、VFS、事务持久化、资源限制、网络与 PDF |
| [skills.md](skills.md) | 内置加载、用户多文件技能、同步与模式过滤的实际边界 |
| [bridge.md](bridge.md) | CC Bridge 服务与消息、CDP 会话 |
| [background-task-tab-model.md](background-task-tab-model.md) | 当前 Tab 栈/锁、调度任务绑定和未来方案边界 |
| [kernel-acceptance.md](kernel-acceptance.md) | Chrome 真机手动验收清单 |

开发命令和安装方式见 [项目 README](../README.md)，贡献代码的约束见 [CLAUDE.md](../CLAUDE.md)。`CHANGELOG.md` 记录历史版本行为，不作为当前实现说明。

## 文档维护

- 引用相对文件路径和函数/类型名，不写容易失效的源码行号。
- 区分当前实现、历史设计与待真机验证项；不把设计意图写成已实现保证。
- 修改配置默认值、协议、存储格式或运行时职责时，同时更新对应章节。
