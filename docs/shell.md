# 虚拟 Shell 与 VFS

## 执行环境

[`shell.ts`](../src/background/shell.ts) 在 Service Worker 中托管纯 JS 的 `just-bash`，每个 session 一个独立 `Bash` / VFS。它不是宿主机终端，不能 spawn 本机进程；页面和浏览器能力来自 `defineCommand` 注册的扩展命令。

`makeBash` 组合页面、Chrome、MCP 命令，Pro 另注册 `debug`。`execBash` 经 `withSessionLock(sessionId, fn)` 串行执行；VFS 外部写入、上传、PDF 批注与清理也使用同一锁，避免读改写覆盖。

## 目录与生命周期

| 路径 | 来源和行为 |
|---|---|
| `/page/` | 页面数据；`clearPageDir` 清理并持久化 |
| `/tmp/`、`/notes/` | 会话工作文件，纳入 VFS 快照；`tmp` 命名不代表每次重开会话都会清空 |
| `/viz/` | 持久画布片段和快照，可供 `visualize` 及新标签页预览 |
| `/context/` | 工具结果归档，消息中的永久 stub 引用这里 |
| `/skills/` | 内置技能从打包字符串挂载；已注册用户技能可编辑并同步 |
| `/memory/` | IndexedDB 记忆的只读投影：`global.md`、`site.md`、`notes.jsonl` |
| `/debug/`、`/debug/reports/` | Pro 初始化时创建 |
| `/todo.json` | 会话任务清单，纳入快照 |

`isReadonlyPath` 控制快照排除与文件标记：`/memory/`、内置技能、未注册技能目录不进入普通持久快照；已注册用户技能进入快照，并同步到 `userSkills`。这里的 readonly 不是 `just-bash` 文件系统的全路径写权限沙箱，不应据此声称物理上绝对不可写。

`memory` 命令更新 IndexedDB 后，通过 `onMemoryUpdate` 刷新当前实例的 `/memory/` 投影。全局上限 1000 字符，站点 2000 字符；源码是 [`memory-storage.ts`](../src/shared/memory-storage.ts)。

## 实例重绑定

页面命令在创建时捕获 tabId。`execBashInner` 发现 tab、`largeFileUploads` 或 `labFetch` 变化时，使用**同一个 live FS 对象**重新创建 Bash，更新命令闭包与执行限制，不从旧持久快照覆盖当前内存。

tab 变化时额外重新挂载该站点的技能/记忆投影。session 的 Pro 模式保存在实例上；页面 target 的实际归属由 [Tab 栈/锁](background-task-tab-model.md) 决定，不再每次追随窗口活跃 tab。

## 命令与管道

命令参考以 [`shell-commands.ts`](../src/background/shell-commands.ts)、[`chrome-commands.ts`](../src/background/chrome-commands.ts)、[`debug-commands.ts`](../src/background/debug-commands.ts) 和 [`mcp-commands.ts`](../src/background/mcp-commands.ts) 为准。

```bash
find-element "Submit" | locate -q | click
```

无位置参数时，相关命令从 stdin 取第一行 target。`find-element` 的 selector 写 stdout、详情写 stderr；`locate -q` 只输出 selector，便于管道组合。`decodeStdin` 处理 just-bash ByteString 中的 UTF-8 字节。

其他命令包括 `skill`、`memory`、`todo`、`http-put`、`pdf`。自动唤醒使用独立的 `schedule` / `monitor` 原生工具，不是 Bash 后台进程。

## 快照与失败回滚

当前执行路径不是 fire-and-forget：

```text
withSessionLock
  → snapshotFs(before)
  → bash.exec
  → snapshotFs(after)
  → commitSnapshot 校验大小并 await saveShellFs
  → 验证用户技能，await persistSkillFiles
  → 截断 stdout/stderr 后返回
```

`mutateLiveFs` 在操作抛错、容量校验或落盘失败时恢复纳入 before 快照的文件内容；被排除的 memory、内置/未注册技能以及空目录不在该文件快照回滚范围内。非零命令 exit code 本身不等于异常：命令若已完成部分写入，仍会提交该结果。回滚仅覆盖 VFS，不能撤销已发生的点击、导航、HTTP 请求等外部副作用。技能存储同步在 VFS 提交之后；`skill create` 的注册本身也会提前写 storage，不能靠 VFS 回滚撤销。两个存储不是跨库原子事务。

`saveShellFs` 通过 `idb-keyval` 写入 `shellfs:{sessionId}`。SW 重启后实例 Map 为空，下一次创建从快照恢复，再挂载只读投影。`/context/` 必须持久化，避免归档 stub 指向不存在的文件。

二进制扩展名 `.jpg/.jpeg/.png/.gif/.webp/.pdf` 使用字节读写接口，快照中编码为 Latin-1 字符串；恢复时转 `Uint8Array`，避免按 UTF-8 文本重编码。其他后缀不自动获得该二进制语义。

## 容量与执行预算

| 维度 | Chat | Pro |
|---|---|---|
| stdout、stderr 各自截断 | 8192 字符 / 200 行 | 65536 字符 / 2000 行 |
| Bash abort 预算 | 5000 ms | 30000 ms |
| 命令计数 | 500 | 5000 |
| 循环迭代数 | 1000 | 10000 |
| 大文件上传开启（默认）：单文件 / 会话 | 32 MiB / 64 MiB | 32 MiB / 64 MiB |
| 大文件上传关闭：单文件 / 会话 | 500 KiB / 2 MiB | 5 MiB / 20 MiB |

超时使用 AbortController，返回 exit code 124 和预算说明；这不是能跨 SW 挂起持续计时的持久定时器。just-bash 的 `maxOutputSize` 使用当前文件限制，返回给模型的 stdout/stderr 再单独截断。

容量校验以快照字符串 `.length` 求和，二进制 Latin-1 一字符对应源文件一字节；不能据此推导 IndexedDB 实际物理占用。关闭大文件后保留原有超限文件，但不允许修改它来转移旧额度。提交时会话总量上限为 `retainedOversized + max(currentMaxSession, previousOrdinarySize)`：未改动的超大文件额外保留，原有普通文件总量若已超过当前会话档位，可在该旧总量内改写/替换，但新增或改动文件仍受当前单文件上限约束。违反实际提交额度时不会静默跳过文件，而会报错并回滚纳入快照的文件变更。

`labImageFs` 只控制图片副本，和 `largeFileUploads` 独立。截图副本在 `/tmp/screenshots/` 保留最近 5 张，单张仍受该写入路径的限制。

## 外部读写和上传

- `writeToShellFile` 允许 `/context/`、`/tmp/`、`/viz/`，在 session 锁内立即落盘；没有 live 实例时直接合并持久快照。
- `readShellFile` 优先 live FS，再快照；内置技能和记忆还能从源头重建投影。
- `readAllShellFiles` 仅返回 `/tmp/`、`/page/`、`/viz/`，用于预览资源边界。
- 附件上传使用 `vfs:upload-start/chunk/abort`，每片 1 MiB、单文件最多 32 MiB，仅接受 `/tmp/attachments/` 下的受限文件名。接口见 [`vfs-upload.ts`](../src/shared/vfs-upload.ts)。
- PDF 阅读器分片读取上限为每次 8 MiB（`PDF_CHUNK`），减少 runtime 消息体超限。

## 网络

`labFetch` 默认未开启。启用后，just-bash 网络配置为：

- `dangerouslyAllowFullInternetAccess: true`；`denyPrivateRanges: false`，**允许访问内网**。
- 内建网络方法限制为 GET / HEAD，响应最多 512 KiB，超时 10 秒。
- `http-put` 是独立实现的二进制上传命令，支持 PUT / POST，并检查网络开关和 `requireConsent`；不能将 GET/HEAD 限制套到它上面。
- 页面中的 `js` 运行与上述 Shell 网络配置是不同路径。

## PDF 与预览

`pdf <path>` 用文本层提取 Markdown，默认最多前 200 页，支持 `--pages`。扫描件无 OCR，提取失败不能当成可读全文。

`pdf note add` 要求 quote 在指定页唯一、逐字匹配，可用 prefix/suffix 消歧；批注在同路径 `.notes.jsonl` sidecar 中，和用户阅读器共享。修改批注用 remove 后重加。

VFS 新标签页由 `src/preview/` 固定 session/path 读取内容，再放入 manifest sandbox；内嵌 `visualize` 用另一套宿主接线。两者复用相同 HTML 能力和渲染基础，不解析其他 VFS 文件依赖；详见 [HTML 成果](html-artifacts.md)。
