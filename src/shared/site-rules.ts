// Reason: separate file so service worker can import without pulling in
// Turndown/Readability which require DOM globals unavailable in SW context
export interface SiteRule {
  match: (url: string) => boolean
  selector: string
}

export const SITE_RULES: SiteRule[] = [
  {
    match: (url) =>
      url.includes('alidocs.dingtalk.com/i/nodes') ||
      url.includes('docs.dingtalk.com/i/nodes'),
    selector: '[data-role="docEditorContent"]',
  },
]
