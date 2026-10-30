---
name: skill-creator
description: 创建高质量自定义技能 — 引导需求、生成 SKILL.md、添加附加文件
---

你正在帮用户创建一个新技能。按以下流程执行：

## 1. 明确需求

向用户确认：
- 技能名称（英文 kebab-case，如 `form-check`）
- 一句话描述（中文，20 字以内）
- 技能要解决什么问题？
- 预期输出格式（表格、评分、清单、自由文本？）
- 是否需要附加文件（脚本、参考文档、模板等）？

## 2. 编写技能内容

技能内容（SKILL.md body）应包含：
- **开场语**：一句话说明激活后要做什么
- **检查项/步骤**：编号列表，每项说明用什么命令、检查什么、判断标准
- **输出格式**：明确输出结构（表格、评分等）
- **附加文件说明**（如有）：列出 `/skills/{name}/` 下的文件及用途

### 编写原则

- 每个步骤必须指明具体的 bash 命令（`dom`、`js`、`find-element` 等）
- 不要写模糊的指令如"检查页面"，要写"用 `js` 执行 `document.querySelectorAll('img:not([alt])')` 统计缺失 alt 的图片数量"
- 步骤数量控制在 3-7 个，太多会导致执行不可控
- 命令的输出应该可以直接用于判断（pass/fail/warn）

## 3. 创建技能

将内容写入临时文件，然后调用：
```bash
cat /tmp/skill-content.md | skill create "name" "description"
```

## 4. 添加附加文件（可选）

创建后可以直接在技能目录下添加文件，系统会自动持久化：

### 参考文档 — 给 AI 提供领域知识
```bash
cat > /skills/my-skill/reference.md << 'EOF'
# API 文档摘要
- POST /api/login — 参数: username, password
- GET /api/user/:id — 返回用户信息
EOF
```
在 SKILL.md 步骤中引用：`cat /skills/my-skill/reference.md` 加载参考。

### 页面注入脚本 — 在页面上下文中执行的 JS
```bash
cat > /skills/my-skill/check.js << 'EOF'
// 收集页面表单信息
const forms = document.querySelectorAll('form');
const result = Array.from(forms).map(f => ({
  action: f.action,
  method: f.method,
  fields: Array.from(f.elements).map(e => e.name).filter(Boolean)
}));
JSON.stringify(result, null, 2);
EOF
```
在 SKILL.md 步骤中使用：`` js "`cat /skills/my-skill/check.js`" ``

### Shell 脚本 — 组合多个命令的工作流
```bash
cat > /skills/my-skill/run.sh << 'EOF'
#!/bin/bash
echo "=== 开始检查 ==="
dom --flat > /tmp/dom.txt
echo "--- Headings ---"
grep -i "^h[1-6]" /tmp/dom.txt
echo "--- Links ---"
find-element --selector="a[href]" | head -20
echo "=== 完成 ==="
EOF
```
在 SKILL.md 步骤中使用：`bash /skills/my-skill/run.sh`

### 输出模板 — 统一输出格式
```bash
cat > /skills/my-skill/template.md << 'EOF'
## 检查报告
| 项目 | 状态 | 说明 |
|------|------|------|
| {{item}} | {{status}} | {{detail}} |
**总分**: {{score}}/100
EOF
```

## 5. 验证

创建后执行以下命令确认：
```bash
skill list                          # 确认技能已注册
ls /skills/my-skill/                # 确认附加文件存在
cat /skills/my-skill/SKILL.md       # 确认内容正确
```

告知用户可以通过 `/name` 或 `useSkill("name")` 使用。

## 限制

- 单个技能总大小 ≤ 200KB，单文件 ≤ 100KB，文件数 ≤ 20
- 附加文件仅在 `skill create` 后添加才会持久化
- 不要手动 `mkdir /skills/new/` 创建技能目录，必须通过 `skill create`
