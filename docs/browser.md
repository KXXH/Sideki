# 浏览器自动化内部机制

本文以 `src/background/tool-handlers.ts`、`element-resolver.ts` 和 `src/shared/input/` 为准。产品名为 Sideki；`__skIdx`、`data-sidekick-*` 等内部标识保持兼容，不随品牌改名。

## 工具入口与目标页面

`src/shared/tools/bridge.ts` 的 `sendToolMessage()` 先解析操作 tab，再发送 `tool:*` 消息给 Service Worker。操作 tab 来自当前 session 的 turn 栈，不能简单等同于用户当前激活的 tab；详见 [Tab 归属模型](background-task-tab-model.md)。

`handleToolMessage()` 负责识别工具、执行授权检查、调用对应 handler 并将异常转为错误结果。bash 页面命令也复用这些 handler，而不是另起一套 DOM 执行规则。

## 共享元素解析器

`element-resolver.ts` 的 `installResolver()` 将自包含解析函数安装到页面 ISOLATED world 的 `self.__skResolve`。`ensureResolver()` 检查并注入所有 frame，避免顶层找到解析器、iframe 中却无法解析。

解析顺序：

1. **`[N]` 索引**：读取当前 frame 的 `self.__skIdx`；索引缺失或元素已移除时不继续按 CSS/文本猜测。
2. **CSS selector**：尝试 `document.querySelector(target)`。
3. **文本/属性**：搜索交互元素的文字、`aria-label`、`placeholder`、`title`、`alt`、`name`，忽略大小写，精确匹配优先于包含匹配。

文本搜索过滤无尺寸、不可渲染的元素和 Sideki 自己的 overlay。**当前共享解析器在多个同级匹配中取第一个，不能依赖它自动返回歧义候选。** 需要消歧时先用 `find-element`；其 `pageFindElements()` 返回最多 20 个匹配及唯一 selector，再精确操作。

`pageResolveElement()` 为定位类命令补充 selector、矩形、属性等信息，并对过期索引提示重新运行 `dom`。selector 优先来自 `css-selector-generator`，失败时退回 id、唯一 tag/class 或 `nth-of-type` 路径。

## DOM 快照与 iframe

`handleDomSnapshot()` 在所有 frame 内运行，默认 `maxNodes=150`，`maxNodes=0` 表示不设该上限。它从 body 或指定 root 按层遍历，输出地标和交互节点；交互节点编号写入当前 frame 的 `__skIdx`，每次快照重建。`--all` 包含更多节点，`--flat` 去掉树形缩进。

隐藏节点会标记 `(hidden)`，而不是统一丢弃，便于模型先打开折叠菜单再操作。快照排除 Sideki 自身 overlay。索引保存在 isolated world 的 Map 中，无需给站点 DOM 添加用于编号的 `data-*` 属性。

索引是 **frame 局部的**，不同 frame 可以出现相同 `[N]`。不要把它当跨 frame 唯一 ID；需要精确指向时使用 selector，JS 读取也可显式指定 frame。

元素操作通常先尝试顶层 frame，只有错误包含 `No element found` 时才进入 all-frames 回退，并返回首个成功结果。已找到但不可达、不可渲染的目标不应通过跨 frame 重试绕过失败。

## 输入引擎

默认开启 `labInputEngine`。`src/shared/input/` 的纯函数计划器产出轨迹 `waypoints`、事件 `steps` 和指针动画 `cues`；页内 `input-interpreter.ts` 按计划执行，CDP 路径通过 `toCdpCommands` 翻译为真实输入。关闭开关回退到 `resolveAndExecInner` 的旧派发方式。

### 合成输入（默认）

- 页内解释器补齐鼠标、pointer、hover、focus 和输入事件顺序。
- hover 链按当前 `elementFromPoint` 重算，避免旧 DOM 状态污染后续操作。
- 受控输入使用原型上的原生 value setter，兼容 React 等框架的输入追踪。
- 可见页按计划时间派发；隐藏页保持事件顺序但跳过动画延迟，以免受隐藏页 rAF/定时器节流阻塞。

输入前的 `hiddenReason()` 检查未挂载、祖先隐藏、零尺寸和滚入视口后仍完全不可见等情况。`opacity:0` 不等于不可命中，不能据此统一拒绝原生输入控件。

`aiPointer` 是独立的视觉开关，关闭只隐藏指针，不改变输入引擎。

### 真实点击（`real=true`）

通过 CDP `Input.dispatchMouseEvent` 派发，适合需要可信用户手势或浏览器真实 hover 状态的页面。它不是自动升级路径：结果中的 `observed` 信号供模型判断后续动作，合成路径没有变化不代表应自动 attach debugger。

需要 debugger 时使用独立授权流程。若当前 `debugSession` 已 attach 同一 tab，就复用；否则临时 attach，并只在自己临时持有时 detach，避免破坏 Pro 的持续捕获。

## JS 执行与 CSP 回退

`handleExecuteJS()` 根据 `labAsyncScript` 选择初始路径，默认开启：

| 路径 | 实现 | 特性 |
|------|------|------|
| 默认异步路径 | `executeViaEval()` | `executeScript` 的 MAIN world 异步函数执行 REPL 包装器，等待 Promise，支持 async/await |
| 兼容路径（开关关闭） | `executeViaScriptTag()` | MAIN world 创建内联 script，使用同步 REPL 包装器 |
| CSP 回退 | `executeViaDebugger()` | 经授权用 `Runtime.evaluate`；异步路径带 `awaitPromise` |

REPL 包装器捕获 console 输出、返回值和错误。CSP 标记表示初始路径未能执行；此时请求 debugger 授权。已授权 hostname 放入 SW 内存中的 `approvedDebuggerHosts`，后续该 hostname 直接走 debugger；SW 重启后缓存重置。

`--frame` 支持 iframe selector，也支持数值 frameId（`7` / `#7`）。当前 debugger 回退只支持顶层 frame：指定 frame 又遇到 CSP 时明确返回错误，不能静默把代码执行到顶层。

## 授权模型

写操作集合为：

```text
click, hover, type, select, keypress, scroll, navigate, executeJS
```

`wait` 是只读等待，不在集合内；`screenshot`、`domSnapshot`、`getPageContent` 也不走这组写操作确认。

`requireConsent()` 的实际规则：

1. `securityLevel === 'permissive'` 或 `yoloMode` 为真，自动通过。
2. 对 http/https 站点，已保存的站点权限可豁免 `click`、`hover`、`type`、`select`、`keypress`、`scroll`、`navigate`。
3. 其余情况向对应窗口的面板发送确认请求。元素操作在请求期间高亮目标，结束后清除。

**不能把 Pro session 等同于自动跳过所有授权。** 通用工具与 debugger 授权函数不检查 session mode；是否直接放行取决于上述配置。`executeJS` 和跨 tab 管理不属于站点级豁免范围。

面板缺席或消息发送失败时，`sendConsentRequest()` 每 3 秒重试，最长 5 分钟；明确拒绝不会重试。授权面板打开后，10 秒未操作会发送 Chrome 通知提醒。SW 若在等待期间被终止，不能保证该 Promise 继续存活。

## 导航检测

`detectNavigation()` 记录操作前 URL，成功操作后等待 300ms 再读取 URL，变化时返回 `navigatedTo` 并重置旧页面指针坐标。它是轻量提示，不等价于页面完成加载；有必要时应再执行 `page-wait` 或重新读取 DOM。

## 截图

`handleScreenshot()` 使用 `captureVisibleTab`，该 API 只能拍摄指定窗口的前台 tab。因此操作目标已经在后台时明确报错，不会把另一个前台页面的像素误当成目标页面。

截图前可将 target 滚入视口，隐藏自身 overlay 与指针，再等待 200ms；捕获前重新检查 tab 是否仍 active，防止等待期间用户切页。捕获后恢复 overlay。

原始 JPEG 经 `OffscreenCanvas` / `createImageBitmap` 缩至最大宽 1280、quality 0.7。`labImageFs` 开启且带 sessionId 时，另将图片副本写入 VFS；该开关不控制模型是否能接收截图。

## 滚动容器

无 target 的滚动从视口中心命中元素向上查找可滚动祖先，找不到才回退 window。很多网页由 overflow 容器承载正文，只滚动 window 会无效。

## 验证边界

纯输入计划和 Chrome API mock 可由单元/集成测试覆盖；真实站点的 CSP、跨源/懒加载 iframe、浏览器 debugger 提示栏、可信输入及后台 tab 限制仍需 Chrome 真机验收。本文没有将源码注释中的浏览器行为假设当成已实测结论。
