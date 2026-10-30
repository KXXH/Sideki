// Reason: microlighter ships no types (upstream PR #17 still open). Only the one
// export we use is declared, matching dist/highlight.js.
declare module 'microlighter' {
  export interface HighlightAllOptions {
    /** Defaults to `document`. */
    root?: ParentNode
    /** Defaults to `"pre > code"`. */
    selector?: string
    /** Extra aliases mapped onto bundled grammar names. */
    languageAliases?: Record<string, string>
  }

  /**
   * Scans for code blocks, loads their TextMate grammars, and registers ranges on
   * `CSS.highlights`. Clears every previously registered category first, so each
   * call must cover every block that should stay colored.
   */
  export function highlightAll(options?: HighlightAllOptions): Promise<HTMLElement[]>
}
