# HTML 成果：统一能力，独立展示链路

画布与新标签页预览面对模型的是同一份能力契约。展示位置只改变视口和交互空间，不改变脚本、资源或权限规则。基础契约定义在 [`html-artifact.ts`](../src/shared/html-artifact.ts)，系统提示词和 `visualize` 描述共用 `HTML_ARTIFACT_CAPABILITIES`，两个入口使用同一预检函数。

## 能力表

| 能力 | 画布与新标签页共同规则 |
|---|---|
| 输入 | 自包含 HTML 片段、完整 HTML 文档或 SVG |
| 样式与交互 | 内联 CSS / JS / SVG、DOM、本地控件；相同主题变量和基础类 |
| 完整文档 | 保留 head 样式/脚本及 html/body 的显示属性；挂载后执行脚本，不模拟浏览器重新导航生命周期 |
| 初始化 | 脚本直接初始化，不等待 DOMContentLoaded/load，不使用 document.write |
| 默认离线 | 无网络请求；依赖内嵌，图片/字体/媒体可用 data:/blob: |
| 显式联网 | 画布使用 `network: true`，新标签页仅使用 URL `network=1`；均允许 HTTPS 远程脚本/样式/图片等与 fetch、WSS socket，受 CSP/CORS 限制 |
| 文件依赖 | 不提供相对路径、其他 VFS 文件或本地模块解析；内联或使用受支持的资源 URL |
| 宿主能力 | 不提供 Chrome API、Node、本机文件、宿主页面 DOM 或回连 agent 的通道；不依赖浏览器已有登录态 |
| 导航与嵌套 | 不支持外部导航、表单提交、iframe/object/embed/base/meta http-equiv；允许页内 `#fragment` 锚点 |
| 动态编译 | 不支持 eval / Function 动态编译 |

预检为 DOM-free authoring 检查，不是完备的 HTML/CSS 安全解析器。真正执行边界由 manifest sandbox 的 opaque origin、清理器和浏览器 CSP 共同提供；jsdom 测试不能验证 Chrome 的权限隔离。

## 基础能力复用

- `html-artifact.ts`：能力说明、HTML 预检、预览 URL 与联网 Query 规则。
- `html-artifact-theme.ts`：主题 token 协议；每个宿主读取自己的配置与当前主题，新标签页从来源会话索引恢复 Pro 模式。
- `src/viz/sandbox.src.html`：内容挂载、脚本执行、基础样式与消息协议。离线/联网页面由 `scripts/gen-viz-sandbox.mjs` 生成。
- 两宿主的 iframe 额外声明 `sandbox="allow-scripts"`，manifest 同时将这两个执行页面登记为 sandbox。

完整文档不会替换沙箱宿主本身：DOMParser 提取 head 的 style/script/link 和 body 内容，复制显示属性，清理后重新创建 script 执行。HTTPS 外部脚本加载完成后才执行后续脚本，避免库尚未加载就使用它。加载失败和运行异常发送 `viz:error`。

## 各自独立的宿主

### 聊天画布

`visualize` 从 `/viz/` 读取源文件，经校验保存内容快照，并返回渲染自检结果及 `previewPath`。`network` 参数仍控制画布的联网模式；`previewPath` 是可直接用于 Markdown href 的 VFS 路径，显式附带 `?network=1` 或 `?network=0`。`VizFrame` 独立加载快照，维护 iframe、主题更新、96–20000px 高度、错误详情和重试；probe 是可用 UI 内的短时检查，不是画布或预览的运行前提。

### 新标签页

`src/preview/main.ts` / `preview-host.ts` 从 URL 固定的 session 和路径读文件，自行管理配置、主题、文件读取、iframe、滚动、错误、重试与下载。新标签页 iframe 使用实际可用视口并在内部滚动，不复用聊天的内容自动增高规则。它不调用 `VizFrame`，不要求侧栏打开，不注册预览 Web Service Worker。旧 `/src/preview/` scope 的 worker registration 尽力注销。

图片和非 HTML 文件仍有独立查看方式；二进制 Latin-1 内容还原为 Uint8Array 后创建 Blob，避免 UTF-8 重编码损坏。下载是当前原文件，不宣称额外导出依赖包。

两宿主都按 iframe source 与 nonce 匹配 ready/render/error/resize 消息；新标签页文件读取 10 秒超时、沙箱渲染 12 秒超时。加载/运行错误不因后续 rendered 消息而抹去。

## 新标签页联网由 URL 唯一配置

新标签页只读取 URL Query 的 `network` 参数：

| Query | 新标签页模式 |
|---|---|
| `network=1` | 联网（true） |
| `network=0` | 离线（false） |
| 缺失、空值、重复参数或其他值（包括 `network=true`） | 离线（false） |

`visualize` 的 `network` 参数不变。工具返回的 `previewPath` 把同一模式写为
`/viz/快照.html?network=1` 或 `?network=0`，模型可直接把它用作 Markdown 链接；
`VizFrame` 的“新标签页打开”链接也会把当前画布模式写进预览 URL。新标签页不从
画布运行状态或其他存储再推导权限，打开后以它自己的 URL 为准。

独立 HTML 不要求先调用 `visualize`。作者写好自包含文件即可直接返回链接，例如：

```markdown
[查看](/viz/report.html?network=1)
[离线查看](/viz/report.html?network=0)
```

普通 `/viz/report.html` 链接默认离线。VFS 链接转换为扩展预览 URL 时保留 `network`
模式，文件路径本身不包含 Query。两条 authoring 路径不互为前置条件。

不再写入或读取 `{path}.meta.json` 能力 sidecar；已有文件即使存在、损坏或与 URL
冲突，也不影响新标签页的联网模式。不主动清理这些用户文件。内容能力仍经过相同
预检与 sandbox/CSP：URL 选择的是离线/联网档位，不开放宿主 DOM、Chrome/Node API、
登录态或相对/VFS 文件访问。

## 验证

- `tests/unit/html-artifact.test.ts`：统一预检、预览 URL 与 `network` Query 规则。
- `tests/unit/html-sandbox-runtime.test.ts`：实际 DOM/脚本执行、完整文档、样式与主题、外部脚本顺序、错误反馈；使用 jsdom，不验证 Chrome CSP。
- `tests/unit/html-preview.test.ts`：固定会话读取、URL 唯一网络配置、忽略旧 sidecar、字节还原、source/nonce、超时和宿主清理。
- `tests/unit/visualize.test.ts`：画布模式、`previewPath` 的显式 Query、从工具结果到新标签页的模式传递。
- Chrome 真机仍需验证：扩展 CSP、opaque origin、HTTPS CDN/CORS、主题跟随，以及关闭侧栏后独立预览。

聊天面板和新标签预览宿主均通过父页面的 `frame-src 'self'` CSP 阻止 sandbox 自身导航到外部地址；离线/联网模式都保留这层限制。opaque-origin iframe 不保证派发 Navigation API 事件，不能仅靠 sandbox 内的 JS 拦截 `location` 导航。
