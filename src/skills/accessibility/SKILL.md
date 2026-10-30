---
name: accessibility
description: 无障碍检查 — ARIA 属性、键盘导航、对比度、alt 文本
---

对当前页面进行无障碍（a11y）审查。

## 检查项

1. **图片 Alt 文本**: 用 `js` 检查所有 img 和 role="img" 元素是否有替代文本
2. **表单标签**: 检查 input/select/textarea 是否有关联的 label 或 aria-label
3. **ARIA 属性**: 检查交互元素是否有正确的 role、aria-label、aria-describedby
4. **键盘可访问性**: 检查所有可交互元素是否可通过 Tab 键聚焦（tabindex 检查）
5. **Heading 层级**: 确认 heading 层级连续，无跳级（如 h1 直接到 h3）
6. **颜色对比度**: 检查文本与背景的对比度是否满足 WCAG AA 标准（4.5:1）
7. **语言声明**: 检查 html 标签是否有 lang 属性

## 输出格式

按严重程度分组（Critical / Warning / Info），每项附具体元素和修复建议。
