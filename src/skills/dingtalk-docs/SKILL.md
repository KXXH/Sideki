---
name: dingtalk-docs
description: 通过 MCP 操作钉钉文档 — 搜索、读取、创建、编辑、Block 级精确操作
---

## 前置检查（每次激活技能时必须执行）

在执行任何文档操作之前，先确认 MCP 工具可用：

1. 检查当前可用工具列表中是否存在名称包含 `dingtalk` 的 MCP 工具（如 `dingtalk_docs_search_documents`、`dingtalk-docs_search_documents` 等）
2. **如果找到** → 跳到「可用工具」章节直接使用
3. **如果未找到** → 停止执行，向用户显示以下引导信息后结束：

---

**需要先配置钉钉文档 MCP 服务器**

1. 打开 Sideki 设置 → MCP 服务器
2. 点击「添加」，填写：
   - **名称**：`dingtalk-docs`（或任意含 dingtalk 的名称）
   - **URL**：你的钉钉文档 MCP Server 地址
   - **认证**：无
3. 保存后等待连接成功，再重新使用本技能

**获取 MCP Server URL**：访问[钉钉 MCP 能力广场](https://mcp.dingtalk.com/#/detail?instanceId=107251&detailType=instanceMcpDetail&mcpId=9629)，登录后在「使用 MCP」区域复制 StreamableHttp URL。

每个用户的 URL 包含个人身份 API Key，不可共用。

---

显示完引导信息后，不要继续执行任何工具调用。

## 路由规则

当用户消息或上下文中出现 `alidocs.dingtalk.com` 链接，或涉及钉钉文档的读取、编辑、搜索意图时，应使用本技能的 MCP 工具操作，而非通过浏览器。链接中的 nodeId 可直接传完整 URL，MCP Server 会自动解析。

## 可用工具（15 个）

以下工具名称以 MCP 服务器名为前缀（如 `dingtalk-docs_search_documents`），实际前缀取决于用户配置的服务器名称。

### 搜索与查看

| 工具 | 说明 | 必填参数 |
|------|------|----------|
| `search_documents` | 按关键词搜索文档 | keyword?（不传返回最近访问） |
| `get_document_info` | 获取文档元信息（标题/类型/创建时间） | nodeId |
| `get_document_content` | 获取文档 Markdown 内容 | nodeId |
| `list_nodes` | 列出文件夹/知识库下的子节点 | folderId?, workspaceId?, pageSize?, pageToken? |

### 创建

| 工具 | 说明 | 必填参数 |
|------|------|----------|
| `create_document` | 创建在线文档（可带初始 Markdown） | name, folderId?, markdown?, workspaceId? |
| `create_folder` | 创建文件夹 | name, folderId?, workspaceId? |
| `create_file` | 创建多种类型文件 | name, type, folderId?, workspaceId? |

`create_file` 的 type 取值：adoc（文档）、axls（表格）、appt（演示）、adraw（白板）、amind（脑图）、able（多维表）、folder（文件夹）。

### 内容编辑

| 工具 | 说明 | 必填参数 |
|------|------|----------|
| `update_document` | 覆盖或追加 Markdown | nodeId, markdown, mode?(overwrite/append), index? |

**update_document 使用约束**：

- **仅限初始化空白文档**：`update_document` 只适用于刚创建的空白文档
- **禁止用于已有内容的编辑**：对已有内容的文档必须使用 Block 工具
- **overwrite 会清空全部原文档内容**：极高风险，仅限新建空白文档

| 场景 | 正确工具 |
|------|----------|
| 新建空白文档后填充初始内容 | `update_document` (mode=overwrite) |
| 在文档末尾追加内容 | `insert_document_block` (index=末尾) |
| 修改某段落/标题内容 | `update_document_block` |
| 在指定位置插入内容 | `insert_document_block` |
| 删除某个块 | `delete_document_block` |

### 推荐：使用 bash 管道传递长文本内容

当 markdown 内容较长（超过几行）时，**不要把 markdown 内联到 JSON 参数里**——容易出现转义错误、换行丢失。应先将内容写入 VFS 临时文件，再通过管道传递：

**创建带内容的文档**：
```bash
cat <<'EOF' > /tmp/weekly.md
# 本周工作总结

## 完成事项

- 项目 A 上线
- 项目 B 评审通过

## 下周计划

- 项目 C 开发
EOF
cat /tmp/weekly.md | mcp call create_document name="周报" markdown=@-
```

**初始化空白文档内容**：
```bash
cat <<'EOF' > /tmp/init.md
# 文档标题

这是初始内容。
EOF
cat /tmp/init.md | mcp call update_document nodeId="新创建的nodeId" mode="overwrite" markdown=@-
```

这种方式的优点：
- Markdown 保持原始格式，换行符不会丢失
- 内容可以先写入文件检查、修改后再提交
- 避免 JSON 字符串中手动转义 `\n`、`"`、`\` 等字符

### Block 级精确编辑

| 工具 | 说明 | 必填参数 |
|------|------|----------|
| `list_document_blocks` | 查询文档一级块列表 | nodeId, startIndex?, endIndex?, blockType? |
| `insert_document_block` | 插入块元素 | nodeId, element, index?, where?(before/after), referenceBlockId? |
| `update_document_block` | 更新指定块 | nodeId, blockId, element |
| `delete_document_block` | 删除指定块 | nodeId, blockId |

element 对象必须包含 `blockType` 字段，可选类型：paragraph、heading、blockquote、callout、columns、orderedList、unorderedList、table、tableRow、tableCell、sheet、attachment、slot。

#### 插入 table 的正确格式

`table` 对象包含三个字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `colSize` | number | 列数 |
| `rolSize` | number | 行数（注意是 `rolSize` 不是 `rowSize`） |
| `cells` | `string[][]` | **二维数组**，每个子数组代表一行 |

**`cells` 必须是二维数组，不是一维展平数组！**

正确示例（2 列 × 3 行）：
```json
{
  "blockType": "table",
  "table": {
    "colSize": 2,
    "rolSize": 3,
    "cells": [
      ["姓名", "角色"],
      ["张三", "开发"],
      ["李四", "设计"]
    ]
  }
}
```

错误示例（一维展平 / 嵌套 children）都会导致行列解析错误。

### 文件上传/下载

| 工具 | 说明 | 必填参数 |
|------|------|----------|
| `get_file_upload_info` | 获取 OSS 上传凭证 | folderId?, workspaceId? |
| `commit_uploaded_file` | 提交已上传文件 | uploadKey, name, fileSize?, folderId?, workspaceId?, convertToOnlineDoc? |
| `download_file` | 获取文件下载凭证 | nodeId |

## 参数说明

**nodeId**：支持两种格式：
- 文档链接 URL：`https://alidocs.dingtalk.com/i/nodes/{dentryUuid}`
- 文档 ID（dentryUuid）：32 位字母数字字符串

**folderId / workspaceId 定位规则**（按优先级）：
1. 传 folderId → 在该文件夹下操作
2. 仅传 workspaceId → 在该知识库根目录下操作
3. 都不传 → 在用户"我的文档"根目录下操作

**markdown 换行**：必须使用真实换行符（U+000A），不能用字面量 `\n`。

## Block 级编辑工作流

1. **查询**：`list_document_blocks` 获取文档结构和各 block 的 blockId/index
2. **定位**：根据返回结果确定目标 blockId 或 index
3. **操作**：insert / update / delete
4. **验证**：再次查询确认变更

## 注意事项

- 所有操作受当前用户权限控制，无权限时返回错误
- 搜索范围为当前组织内用户有权限的文档
- Block 级编辑仅支持一级块元素
- `update_document` 仅限初始化空白文档，编辑已有文档请用 Block 工具
- 下载凭证有过期时间（expirationSeconds），需在过期前完成下载
