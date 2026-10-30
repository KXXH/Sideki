export interface EmptySuggestion {
  name: string
  say: string
  prompt: string
}

export interface EmptyStateDeck {
  heading: string
  sub: string
  fixed: EmptySuggestion[]
  pool: EmptySuggestion[]
}

// Reason: quick chips and empty-state examples share one prompt source — the
// visible wording differs, the action must not.
export const ACTION_PROMPTS = {
  summary: "请获取最新页面内容，用简洁的结构化格式总结当前页面内容",
  links: "提取当前页面所有链接，按类别分组整理",
  tabs:
    "/chrome\n请帮我整理标签页：\n1. 列出所有标签页（含分组和最近访问时间）\n2. 保留现有分组不动，对未分组的标签页按主题建议新分组\n3. 识别长期不活跃的标签页，建议关闭\n4. 列出你的整理方案，等我确认后再操作",
  bookmarks:
    "/chrome\n请帮我整理书签：\n1. 列出当前书签树结构\n2. 分析现有分组是否合理，对未分组书签建议归类\n3. 检查命名是否清晰，对含义模糊或过长的书签/文件夹给出重命名建议\n4. 列出你的整理方案（新建文件夹、移动、重命名），等我确认后再操作",
  plain: "请用大白话解释当前页面内容，把专业术语拆开讲清楚",
  history: "帮我回顾最近七天的浏览记录，按主题归纳我最近在关注什么",
  network: "用 debug network start 开始抓包，然后告诉我已就绪",
  performance: "/performance",
  seo: "/seo-audit",
  a11y: "/accessibility",
  pageErrors:
    "先开始捕获控制台，再刷新当前页面，然后把加载过程中的报错整理给我，并说明最可能的原因",
} as const

export const CHAT_EMPTY_STATE: EmptyStateDeck = {
  heading: "想从这一页开始？",
  sub: "可以直接问，也可以试试这样说。",
  fixed: [
    {
      name: "总结页面",
      say: "总结这一页的要点和结论",
      prompt: ACTION_PROMPTS.summary,
    },
    {
      name: "整理标签页",
      say: "把当前窗口的标签页按主题整理一下",
      prompt: ACTION_PROMPTS.tabs,
    },
  ],
  pool: [
    {
      name: "大白话",
      say: "用大白话讲讲这页，把术语拆开",
      prompt: ACTION_PROMPTS.plain,
    },
    {
      name: "整理书签",
      say: "帮我整理一下书签，按主题归类",
      prompt: ACTION_PROMPTS.bookmarks,
    },
    {
      name: "七日回看",
      say: "回顾我最近七天看了什么",
      prompt: ACTION_PROMPTS.history,
    },
    {
      name: "提取链接",
      say: "把这一页的链接都提取出来，按类别分组",
      prompt: ACTION_PROMPTS.links,
    },
  ],
}

export const PRO_EMPTY_STATE: EmptyStateDeck = {
  heading: "要查这个页面？",
  sub: "可以直接说问题，也可以试试这样说。",
  fixed: [
    {
      name: "查看页面报错",
      say: "刷新一下，把页面报错抓给我",
      prompt: ACTION_PROMPTS.pageErrors,
    },
    {
      name: "开启网络抓包",
      say: "开始抓包，我复现一次提交",
      prompt: ACTION_PROMPTS.network,
    },
    {
      name: "检查页面性能",
      say: "看看这个页面卡在哪里",
      prompt: ACTION_PROMPTS.performance,
    },
  ],
  pool: [
    {
      name: "SEO 检查",
      say: "顺手做个 SEO 检查",
      prompt: ACTION_PROMPTS.seo,
    },
    {
      name: "无障碍检查",
      say: "看看无障碍有没有明显问题",
      prompt: ACTION_PROMPTS.a11y,
    },
  ],
}
