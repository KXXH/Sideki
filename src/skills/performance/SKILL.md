---
name: performance
description: 页面性能分析 — 资源体积、请求数量、渲染指标
---

分析当前页面的性能状况。

## 检查项

1. **渲染指标**: 用 `js` 执行 `performance.getEntriesByType('navigation')[0]` 和 `performance.getEntriesByType('paint')` 获取 FCP、DOMContentLoaded、Load 时间
2. **资源统计**: 用 `js` 执行 `performance.getEntriesByType('resource')` 统计各类资源（script、stylesheet、image、font）的数量和总体积
3. **大资源检测**: 找出超过 100KB 的资源，按体积排序
4. **DOM 复杂度**: 用 `js` 统计 DOM 节点总数、最大嵌套深度、含子节点最多的元素
5. **第三方脚本**: 识别非同域的 script 资源及其体积

## 输出格式

指标表格 + 优化建议（按影响程度排序）。
