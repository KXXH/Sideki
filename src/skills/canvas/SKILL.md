---
name: canvas
description: 生成 HTML 可视化（图表、示意图、对比、模拟、UI 预览），画布与新标签页使用同一能力规则
---

# HTML 画布与新标签页预览

先写自包含 HTML 到 VFS，再调用 `visualize` 内嵌到对话；需要单独查看时，可链接返回的快照路径在新标签页打开。两个入口的脚本、主题、资源和联网能力完全相同；换标签页只改变展示空间，不会获得更多权限。

完整 HTML 文档和片段都可用。`head` 中的样式和脚本会保留，内容先挂载，再按顺序执行脚本；不要依赖完整浏览器导航生命周期、`document.write` 或重新创建文档。两个入口各自加载和重试，不依赖另一个界面保持打开。

## 工作流

1. 用 bash 把片段写入 `/viz/`：

```bash
mkdir -p /viz
cat > /viz/chart.html <<'SKVIZ_EOF'
<figure>
  <figcaption>各渠道转化率</figcaption>
  ...
</figure>
SKVIZ_EOF
```

- 必须使用**带引号**的定界符（如 `'SKVIZ_EOF'`），这样 `$`、反引号和引号不会被展开。
- 定界符要独占一行且位于行首；选一个内容中不会出现的定界符。
- `/viz/` 是持久成果目录；`/tmp/` 和 `/page/` 留作工作文件，页面导航会清理 `/page/`。

2. 调用工具：

```js
visualize({ path: '/viz/chart.html', title: '渠道转化率对比' })
```

工具会校验文件，在 `/viz/` 下生成包含内容与联网模式标识的快照并内嵌渲染。返回值 `previewPath` 是新标签页链接路径，已带 `?network=1/0`；需要分享时使用它，不要只取裸 `path`。

返回值里的 `render` 是渲染自检：`ok` 表示文档执行完成（`height: 0` 通常意味着什么都没画出来）；`error` / `timeout` 按给出的信息修片段后重新调用；`unavailable` 表示当时没有可用的渲染界面，不代表画布坏了。`ok` 只说明没有未捕获异常，不判断排版和数据是否正确。

## 直接在新标签页查看

用户只要单独页面时，可以直接写自包含 HTML 并提供 `[查看](/viz/report.html)`，无需先调用 `visualize` 或打开聊天画布。默认离线；需要联网时提供 `[查看](/viz/report.html?network=1)`，显式离线用 `?network=0`。

URL Query 是新标签页联网模式的唯一配置源：只有一个 `network=1` 时才联网；缺省、无效或重复参数都离线。不写、不读取 `.meta.json` 能力文件。画布仍使用 `visualize` 的 `network` 参数；从画布切到新标签页时，链接携带相同值。

## 联网画布

默认离线。只有画布必须在渲染时读取实时数据或加载 CDN 库时，才加 `network: true`：

```js
visualize({ path: '/viz/live.html', title: '实时指标', network: true })
```

- 联网内容的远程资源、fetch 只用 `https://`，WebSocket 用 `wss://`；`http://`、`ws://` 和 `//` 地址不可用。
- HTTPS 远程 script/style/image/font/media、fetch 与 WSS WebSocket 可用；仍不支持嵌套页面、外部导航或表单提交。相对路径、其他 VFS 文件和本地模块依赖两边都不可用。
- 两个入口均在 opaque origin 中执行，不继承浏览器登录态或扩展身份，仍受 CORS 限制；不要依赖已登录网页的 cookie 或受保护接口。
- 联网画布不是确定性快照：离线、接口变更或 CDN 不可用时会空白或变样。用户没要求实时数据时不要开。

## 何时用 / 不用

适合：

- 解释机制、流程或状态如何变化；
- 比较方案、参数或设计取舍；
- 模拟“如果……会怎样”；
- 预览 UI、组件或弹窗（mockup）；
- 简单的柱状图、折线图、占比图等。

不适合：

- 一两句话能说完的结论或步骤；
- 交付文件、网站、导出物（属于项目改动，不是内联可视化）；
- 静态映射关系 → 用 Markdown 表格；
- 静态节点 + 连线的结构图 → 用 Mermaid；
- 论文、出版物图表或其他需要导出的正式图。

## 两个入口共同的能力规则

- HTML 片段与完整文档均可；支持 DOM、CSS、JavaScript、SVG 和本地交互控件。
- 默认离线：依赖全部内嵌，图片/字体/媒体可用 data:/blob:；不加载外部脚本/样式，不发网络请求。脚本放内联 `<script>`，不能通过 data:/blob: script src 绕过策略。
- 显式 `network: true` 后才可用 HTTPS 远程依赖和请求、WSS socket；不因此获得登录态或跨域豁免。
- 相对路径、VFS 资源引用、本地模块都不可用：CSS/JS/SVG 内联，图片等用 data URL，联网时可用 HTTPS。不要把新标签页当作 VFS 网站服务器。
- 不支持 iframe/object/embed、base、meta http-equiv、外部导航和表单提交；`#fragment` 页内锚点可用。
- 不提供 Chrome API、Node、本机文件、宿主页面 DOM、回连 agent 的通道。交互须在内容内部完成。
- 不支持 eval、Function 动态编译、document.write。脚本在内容挂载后执行，不依赖 DOMContentLoaded/load 来初始化。
- 新标签页默认离线；独立 HTML 用链接的 `?network=1` 显式声明联网。画布用 `visualize({path, network:true})`；分享工具返回的 `previewPath` 时保留同一模式，两个流程不互为前置。

## 主题与配色

只使用下列宿主变量，不要写死颜色：

- 文本与结构：`--seed-fg`、`--seed-muted`、`--border-standard`、`--border-subtle`
- 表面：`--card-bg`、`--inset-bg`、`--fill-1`、`--fill-2`、`--fill-3`
- 强调：`--seed-primary`
- 字体：`--font-sans`、`--font-code`
- 数据系列：`--viz-series-1`、`--viz-series-2`、`--viz-series-3`、`--viz-series-4`、`--viz-series-5`、`--viz-series-6`

系列规则：

- `1` 用于单一度量或当前状态；
- `2` 到 `6` 表示稳定的分类身份，同一分类在多处保持同一颜色；
- 不要给每个同类项默认配不同颜色；
- 系列色只用于线、柱、点等图形标记和图例色块；数字与坐标文字用 `--seed-fg`。

## 宿主工具类

以下类已由宿主提供，直接用，不要重新实现：

- `.card`：只用于必要的数值摘要、选中项摘要或有界交互区；不要包住图表、表格、控件或整个可视化，不要嵌套卡片。
- `.viz-grid`、`.viz-row`、`.viz-controls`、`.viz-field`：布局与控件行。
- `.viz-stat` + `.viz-stat-label` + `.viz-stat-value`：摘要数值。
- `.viz-badge`：只读状态/分类标签，不要当按钮。
- `.viz-legend` + `.viz-legend-swatch`：图例。
- `.viz-tile`：网格块按钮。
- `.text-small`（12px）、`.text-muted`、`.tabular-nums`。
- `.progress` + `.progress-bar`、`.table-responsive`、`.nav-pills` + `.nav-link`。

原生 `button`、`input`、`select`、`textarea` 直接用；不要重做控件、覆盖焦点样式或添加 `tabindex`。

## 构图与可访问性

- 选能满足需求的最小构图。侧面板从 320px 起可用，窄时内容上下堆叠。
- 无固定外层宽度、无内部滚动、无 `position: fixed`、无基于视口高度的布局。
- 正文 13px、次要文字 12px，最小 11px；字重只用 400 和 500。
- **SVG 里的 `font-size` 是用户单位，会随 SVG 宽度缩放**。侧栏实际宽度可能是 320–680px，不要假设 320 设计会 1:1 渲染：`viewBox="0 0 320"` + `width:100%` 在 600px 宽侧栏里会把 11px 放到约 20px。
- 按 320 设计时限制宽度：外层 `max-width:360px; margin-inline:auto`，或 SVG 用 `width="320" style="max-width:100%;height:auto"`；要铺满侧栏时按 560–640 的 viewBox 设计，字号直接用 13–15px。流程图/卡片优先把文字放在 HTML，SVG 只画连线。
- 语义化 HTML；键盘可操作；动态结果用 `aria-live="polite"`，错误用 `role="alert"`。
- 指针目标约 44×44；精细指针下至少 32×32。
- 尊重 `prefers-reduced-motion`：用交叉淡入代替滑动、弹跳。

## 图表

默认优先写内联 SVG（`rect`、`polyline`、`path`、`line`、`text`）。确需 CDN 图表库时，显式启用联网模式并使用 HTTPS，两个入口都遵循同一规则。

- 给一个简短、可见的标题；坐标轴标注量和单位；多系列时加图例。
- 不加装饰性边框和阴影。
- 加 `role="img"` 和概括数据的 `aria-label`；数据较多时可在 `<details>` 中附数据表。
- 数值标签和坐标文字用 `--seed-fg`，系列色只给图形元素。
- SVG 字号会随渲染宽度缩放。下面的示例固定 320px 宽；不要改成 `width:100%` 后继续沿用 11px 字号。

柱状图示例（固定 320px 宽，窄侧栏可收缩）：

```html
<figure style="margin:0;font-family:var(--font-sans)">
  <figcaption style="font-size:13px;font-weight:500;color:var(--seed-fg);margin-bottom:8px">各渠道转化率</figcaption>
  <svg viewBox="0 0 320 168" role="img" aria-label="柱状图：自然搜索 4.8%，推荐 3.2%，直接访问 2.1%" style="display:block;width:320px;max-width:100%;height:auto">
    <text x="4" y="14" font-size="11" fill="var(--seed-fg)">转化率（%）</text>
    <g stroke="var(--border-subtle)">
      <line x1="44" y1="24" x2="312" y2="24"/>
      <line x1="44" y1="80" x2="312" y2="80"/>
    </g>
    <line x1="44" y1="136" x2="312" y2="136" stroke="var(--border-standard)"/>
    <line x1="44" y1="24" x2="44" y2="136" stroke="var(--border-standard)"/>
    <g font-size="11" fill="var(--seed-fg)" text-anchor="end">
      <text x="38" y="28">6</text>
      <text x="38" y="84">3</text>
      <text x="38" y="140">0</text>
    </g>
    <g fill="var(--viz-series-1)">
      <rect x="76" y="46" width="40" height="90" rx="2"/>
      <rect x="152" y="76" width="40" height="60" rx="2"/>
      <rect x="228" y="97" width="40" height="39" rx="2"/>
    </g>
    <g font-size="11" fill="var(--seed-fg)" text-anchor="middle">
      <text x="96" y="40">4.8%</text>
      <text x="172" y="70">3.2%</text>
      <text x="248" y="91">2.1%</text>
      <text x="96" y="154">自然搜索</text>
      <text x="172" y="154">推荐</text>
      <text x="248" y="154">直接访问</text>
    </g>
  </svg>
</figure>
```

## 数据

- 普通成果将数据内嵌；只有确需渲染时实时数据才用显式联网模式请求接口。
- 大数组先聚合、抽样或降低精度，不要把原始数据整段塞进片段。
- 需要当前页面或外部的最新数据时，先用现有工具取回，再把结果内嵌。

## 快照语义

每次 `visualize` 都会为当前内容与联网模式生成快照。要改可视化，重新写文件（或覆盖原文件）后再次调用；不要依赖之后编辑文件去改变已经渲染的画面。

## 正文写法

- 内嵌场景的正文只用一两句话说明帮用户看到或判断什么，不描述实现。用户要求单独查看时，可提供工具返回快照的 VFS 链接，不要改链路来绕过能力限制。
- `title` 是可访问名称，不是可见标题；需要可见标题就写进 HTML 内部。

## 交付前自查

1. 文件是自包含片段或完整文档，没有相对/VFS 资源依赖？
2. 离线画布没有外部资源或网络请求；联网画布只有 `https://` 外部资源；两种模式都没有 `iframe`、表单提交或 VFS 链接？
3. 颜色和字体全部来自宿主变量，明暗主题下都清晰可读？
4. 320px 和常规宽度下不重叠、不裁切，不依赖内部滚动或固定定位？
5. SVG 的实际渲染宽度是否被限制在设计宽度（或按实际宽度设计）？按实际宽度 ÷ viewBox 换算后，字号仍落在 11–15px，没有被放大成“大标题”？
6. 控件使用原生元素、键盘可达；动态结果和错误有正确的 aria？
7. `visualize` 已返回当前内容与联网模式的快照，单独查看链接使用同一快照的 previewPath，并携带同一联网模式？
