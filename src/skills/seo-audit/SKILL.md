---
name: seo-audit
description: 检查页面 SEO 健康度（meta tags、heading 结构、图片 alt、链接状态）
---

检查当前页面的 SEO 健康状况，逐项分析并给出评分。

## 检查项

1. **Meta Tags**: 用 `js` 执行 `document.querySelector('title')?.textContent` 和 `document.querySelector('meta[name="description"]')?.content` 等获取 title、description、canonical、og tags
2. **Heading 结构**: 用 `dom --flat | grep -i "^h[1-6]"` 检查 heading 层级是否合理（应有且仅有一个 h1，h2-h6 层级递进）
3. **图片 Alt**: 用 `js` 执行脚本检查所有 img 是否有 alt 属性，统计缺失数量
4. **链接状态**: 用 `find-element --selector="a[href]"` 检查链接数量，识别空链接和 javascript: 链接
5. **移动端适配**: 检查 viewport meta tag 是否存在

## 输出格式

输出一个评分表格，每项 Pass/Warn/Fail，附改进建议。最后给一个总分（0-100）。
