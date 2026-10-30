---
name: chrome
description: Chrome 浏览器管理 — 标签页、书签、历史记录、下载、热门站点
---

管理 Chrome 浏览器资源。所有命令在 bash 中执行。

## 标签页管理

```
chrome tabs                                       # 列出所有标签页（含 #id）
chrome tabs --switch "#1234"                      # 切换到指定标签页
chrome tabs --new "url"                           # 新建标签页并导航
chrome tabs --close "#1234"                       # 关闭指定标签页
chrome tabs --group "name" "#1234" "#5678"        # 将标签页分组
chrome tabs --group "name" --color blue "#1234" "#5678"
chrome tabs --ungroup "#1234,#5678"               # 取消分组
chrome tabs --collapse "name"                     # 折叠分组
chrome tabs --expand "name"                       # 展开分组
```

标签页操作使用 `#id`（如 `"#1234"`），这是 Chrome 分配的稳定标识符，不会因标签页增减而变化。先 `chrome tabs` 获取列表及 ID，再用 `"#id"` 操作。**注意：`#` 在 shell 中是注释符，必须用引号包裹，如 `"#1234"`，否则会被忽略。**

`--switch` 与 `--new` 会把后续页面操作的目标切到该标签页：`dom` / `click` / `js` 等页面命令都作用于它，直到你再次切换或本轮结束。切换到别的任务正在操作的标签页会被拒绝。

## 书签

```
chrome bookmarks                              # 列出书签树（含文件夹 id）
chrome bookmarks --search "keyword"           # 搜索书签
chrome bookmarks --add "url" "title"          # 添加书签到根目录
chrome bookmarks --add "url" "title" --parent "folderId"  # 添加到指定文件夹
chrome bookmarks --mkdir "folder name"        # 创建文件夹
chrome bookmarks --mkdir "name" --parent "id" # 在指定位置创建子文件夹
chrome bookmarks --move "bookmarkId" --to "folderId"      # 移动书签到文件夹
chrome bookmarks --rename "id" "new title"    # 重命名书签或文件夹
chrome bookmarks --rm "id"                    # 删除单个书签
chrome bookmarks --rm-tree "folderId"         # 删除文件夹及所有内容
```

## 历史记录

```
chrome history "keyword"             # 搜索历史记录
chrome history "keyword" --recent 20 # 最近 N 条匹配记录
chrome history --full "keyword"      # 完整 URL（默认截断 60 字符）
```

## 下载与热门站点

```
chrome downloads                     # 列出最近下载
chrome downloads --search "keyword"  # 搜索下载记录
chrome top-sites                     # 最常访问的站点
```

## 命名原则

标签页分组和书签文件夹的命名遵循**极简实用主义**：

- **标签页分组**：2-4 字，空间极其有限，能短则短。如"开发"、"文档"、"设计"、"邮件"
- **书签文件夹**：可稍长，但仍以简明为主。如"前端参考"、"API 文档"、"工作周报"
- **Emoji 使用**：仅在能替代文字、压缩长度时使用，不可与文字语义重复。好的用法：🐛bug（替代"问题修复"）、🎨UI（替代"界面设计"）；坏的用法：📄文档（emoji 与文字重复，不如直接写"文档"）
- **判断标准**：emoji 让名称更短了 → 用；emoji 只是装饰、去掉后一样清晰 → 不用

## 常见用法

- 批量关闭标签页：`chrome tabs` 查看 ID → 逐个 `chrome tabs --close "#id"`
- 整理工作区：将相关标签页分组 `chrome tabs --group "项目A" "#1234" "#5678" "#9012"`
- 查找之前访问的页面：`chrome history "关键词" --recent 10` → `chrome tabs --new "url"`（新页随即成为操作目标，可直接 `dom` / `click`）
- 在多个已打开的标签页之间轮转处理：`chrome tabs` 取 ID → `chrome tabs --switch "#id"` → `dom` / `click` 作用于该页
- 整理书签：`chrome bookmarks` 查看结构 → `--mkdir` 建文件夹 → `--move` 归类
- 书签归档：把标签页存为书签 `chrome bookmarks --add "url" "title" --parent "folderId"`
