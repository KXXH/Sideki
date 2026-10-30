export interface HtmlArtifactTheme {
  mode: 'light' | 'dark'
  tokens: Record<string, string>
}

const THEME_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['--seed-fg', '--color-text-primary'],
  ['--seed-muted', '--color-text-muted'],
  ['--seed-primary', '--color-accent'],
  ['--border-standard', '--color-border-subtle'],
  ['--border-subtle', '--color-border-muted'],
  ['--card-bg', '--color-surface-raised'],
  ['--inset-bg', '--color-surface-overlay'],
  ['--fill-1', '--color-accent-wash'],
  ['--fill-2', '--color-surface-overlay'],
  ['--fill-3', '--color-border-muted'],
  ['--font-sans', '--font-sans'],
  ['--font-code', '--font-mono'],
  ['--viz-series-1', '--color-accent'],
  ['--viz-series-2', '--color-text-secondary'],
  ['--viz-series-3', '--color-success'],
  ['--viz-series-4', '--color-warning'],
  ['--viz-series-5', '--color-error'],
  ['--viz-series-6', '--color-accent-dim'],
]

// Reason: hosts own their configuration and lifecycle; only the renderer's token protocol is shared.
export function readHtmlArtifactTheme(): HtmlArtifactTheme {
  const style = getComputedStyle(document.documentElement)
  return {
    mode: document.documentElement.dataset.colorMode === 'dark' ? 'dark' : 'light',
    tokens: Object.fromEntries(THEME_ALIASES.map(([alias, source]) => [alias, style.getPropertyValue(source).trim()])),
  }
}
