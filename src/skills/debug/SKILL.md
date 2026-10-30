---
name: debug
description: Chrome DevTools 调试全流程 — 网络抓包、控制台监听、元素检查、脚本分析、性能指标
mode: pro
---

你已进入调试模式。以下是完整的 debug 命令集和使用策略。

## Debug Commands

### 元素检查
- `debug elements "selector"` — 计算样式、盒模型、事件监听器

### 网络抓包
- `debug network start [--filter=pattern]` — 开始抓包（可选 URL 过滤）
- `debug network stop` — 停止并输出 JSONL（含 headers）
- `debug network list [--filter=pattern]` — 查看已捕获请求（表格，含 requestId）
- `debug network headers <requestId>` — 查看完整 request/response headers + POST body
- `debug network body <requestId>` — 按需获取响应体（CDP Network.getResponseBody）
- `debug network clear` — 清空缓冲区

### 控制台监听
- `debug console start` — 开始捕获 console 输出
- `debug console stop` — 停止并输出 JSONL
- `debug console list [--filter=pattern]` — 查看已捕获条目
- `debug console clear` — 清空缓冲区

### 脚本分析
- `debug scripts [--filter=pattern]` — 列出已加载的 JavaScript 文件（完整 URL，可直接 grep）
- `debug source <scriptId> [--line=N] [--col=N] [--search=pattern] [--beautify]` — 读取脚本源码
  - 无 flag 时输出完整原始源码（stdout 纯内容，字节数等元信息在 stderr）；大文件用 `> /tmp/x.js` 重定向拿全量，直接输出会在 64KB 处截断
  - `--search` 支持中文直接搜：自动同时匹配 UTF-8 字面量和 `\uXXXX` 转义形式（含大写 hex），无需手动搜 code point

### 持久注入
- `debug inject "code"` — 注入 JS，跨导航持久生效（返回 id）
- `debug inject --remove=<id>` — 移除已注入脚本

### 性能指标
- `debug perf` — FCP、LCP、CLS、内存、布局计数

## 工作流策略

### 定位 Console 错误
1. `debug console start` → 复现问题 → `debug console list`
2. 从 stack trace 获取 scriptId + col
3. `debug source <id> --col=N` 定位到具体代码位置

### 网络问题排查
1. `debug network start --filter=api` → 复现 → `debug network list`
2. `debug network headers <id>` 检查认证 headers、CORS、缓存策略
3. `debug network body <id>` 查看响应内容

### 处理压缩代码（单行 bundle）
- 有 stack trace 的 col → `debug source <id> --col=N`
- 知道关键字（含中文） → `debug source <id> --search=pattern`，命中行带 `[col:N]` 可接 `--col` 看上下文
- 需要完整文件 → `debug source <id> > /tmp/file.js`（原始全量）或 `--beautify > /debug/file.js`（多行化后 grep）

### 持久监控
`debug inject` 注入的代码跨导航生效，适合：
- console.error 拦截器
- MutationObserver 监听 DOM 变化
- 性能标记注入

**先注入监控代码，再触发 bug** — 顺序很重要。

### 元素深度检查
`debug elements "selector"` 一次返回：
- 计算样式（display、position、z-index 等）
- 盒模型尺寸（content/padding/border/margin）
- 事件监听器列表（类型、handler 预览、scriptId + 行号）

## 安全分类

**只读（安全）：** debug scripts/source/perf/elements, debug network list/headers, debug console list
**写操作（修改状态）：** debug inject, debug network start/stop, debug console start/stop

## 注意事项

- `navigate` 会导致完整页面重载 — JS 状态、hooks、内存数据全部丢失
- debugger 断开后自动重连 — 命令失败时直接重试即可
- `debug source` 返回数据太多时用 `--search` 或 `--col` 缩小范围
- `debug scripts` 只列 V8 中仍存活的脚本 — 执行完无引用的小脚本会被 GC 后消失。目标脚本不在列表时，用 `js "performance.getEntriesByType('resource').map(e=>e.name).join('\n')"` 拿完整资源 URL，再硬刷新页面后重新 `debug scripts`
