# Skills 系统

## 发现、激活与支持文件

[`skills.ts`](../src/shared/skills.ts) 维护 `skillRegistry`。`buildFrozenInstructions` 将 `getSkillIndex(disabledSkills, sessionMode)` 的索引写入冻结提示词，不把所有技能全文提前塞入上下文。Bash 工具描述还带一份固定的常用技能提示，完整清单以索引和 `skill list` 为准。

激活有两条入口：

- 用户 `/name`：`ChatView` 匹配技能，将正文写入结构化 `data-skill` part；发送到模型前由消息协议展开，UI 保留简洁显示。
- 模型 `useSkill({name})`：返回 `getSkillContent` 的正文，不含 frontmatter。

支持文件挂载到 `/skills/<dir>/`，模型用 `cat /skills/<dir>/<file>` 按需读取，而不是 `cat` 目录。消息 v2 的格式见 [前端文档](frontend.md)。

## 当前内置加载方式

唯一源码目录是 `src/skills/`，不是 `public/skills/`。当前注册表使用：

```ts
import.meta.glob('/src/skills/**/SKILL.md', { query: '?raw', eager: true })
import.meta.glob('/src/skills/**/*', { query: '?raw', eager: true })
```

构建时展开成静态字符串依赖，同步填充 registry，不依赖运行时 `fetch`、`loadSkills()` 或动态 `import()`。Background 禁止动态 import 的约束仍有效；这里的 eager 内联与懒加载 chunk 不是一回事。新增支持文件后需要重新构建扩展。

| 技能 | 用途 | 模式 |
|---|---|---|
| `debug` | CDP 调试流程 | pro |
| `seo-audit` | SEO 检查 | all |
| `accessibility` | 无障碍检查 | all |
| `performance` | 性能分析 | all |
| `chrome` | 标签页、书签、历史、下载等参考 | all |
| `skill-creator` | 自定义技能创建 | all |
| `dingtalk-docs` | 通过 MCP 操作钉钉文档 | all |
| `canvas` | 内嵌可视化与交互演示 | all |

## 用户技能存储

存于 `chrome.storage.local['userSkills']`：

```ts
Record<string, {
  description: string
  content: string
  files?: Record<string, string>
  createdAt: number
}>
```

`loadUserSkills` 先清理 registry 里的旧用户条目，再从 storage 加载；offscreen 通过 `env:get-user-skills` 代理读取，SW 转发 `env:user-skills-changed` 让后台更新注册表。已冻结 agent 的索引不等于每次 storage 变化立刻重建，见 [Agent 生命周期](agent.md)。

创建命令需要从 stdin 提供正文：

```bash
cat /tmp/skill.md | skill create "name" "description"
# 创建成功后可以继续写支持文件
cat > /skills/name/checklist.md <<'DOC'
检查清单
DOC
```

`skill create` 调用 `saveUserSkill` 注册；直接 `mkdir /skills/new/` 不注册，该目录内容不持久化。`saveUserSkill` 限正文 50000 字符，禁止覆盖内置技能；`skill remove` 只能删除用户技能。

## 多文件同步与容量

`execBashInner` 提交 VFS 后：

1. `syncUserSkillChanges` 读取已注册用户目录，调用 `validateUserSkillsFromVfs` 生成验证警告；警告拼入 stderr，Bash 工具在成功退出时也展示。
2. `persistSkillFiles` 从快照提取技能文件，验证后调用 `persistUserSkillChanges`，更新 storage 和 registry。当前是 **await 同步**，不是 fire-and-forget。

限制常量位于 `skills.ts`：总大小 200 × 1024、支持文件单个 100 × 1024、支持文件数 20。实现主要按字符串长度计量，不是精确 UTF-8 字节大小；`SKILL.md` 计入总量，支持文件计数不包括它。

当前校验行为需按源码理解：超大支持文件跳过，超过文件数量停止收集；总量超限会发警告，但 `validateUserSkillsFromVfs` 仍可能返回 changed，不能声称所有超限变更都会被原子拒绝。导入包另走 `importSkillFromEntries`，总量超限会直接拒绝；两条入口并非同一套事务。

Dev 面板标记：内置技能 / memory 为 readonly；未注册 `/skills/` 目录为 ephemeral；已注册用户技能为普通可编辑文件。该标记和快照排除规则不等同于 Bash FS 的硬写保护。

Settings 支持用户技能 `.tar.gz` 导入/导出，导出包含完整支持文件。`getExportableSkills` 不导出内置技能。

## 模式与禁用的实际边界

`SkillMode = 'chat' | 'pro' | 'all'`。frontmatter 解析 `name`、`description`、`mode`，缺失或未知 mode 默认 all。

| 入口 | 当前传入的过滤信息 |
|---|---|
| Agent 冻结索引 | disabledSkills + sessionMode |
| `/name` 激活 | sessionMode（disabledSkills 传空数组） |
| Bash `skill list` | currentMode（disabledSkills 传空数组） |
| VFS `getSkillFiles` | currentMode；无 disabledSkills 参数 |
| 原生 `useSkill` | 只传 name，未传当前 mode / disabledSkills |

因此模式和禁用当前主要控制发现与部分加载入口，**不是所有路径一致强制的权限边界**。`getSkillContent` API 支持过滤，但调用方没有传参时不自动推断当前会话。用户导入的 mode 也未单独持久化，重新加载用户技能按 all 注册。

修改这些行为时应先修改实现与测试，再同步本文，不通过文档宣称尚未存在的安全保证。
