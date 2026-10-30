import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME_ID,
  THEME_PRESETS,
  normalizeThemeId,
  resolveThemeMaterial,
  resolveThemeMode,
  resolveThemePreset,
  resolveThemeShape,
  resolveThemeValues,
} from '../../src/shared/themes'

function channel(pair: string): number {
  const v = parseInt(pair, 16) / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(hex.slice(i, i + 2)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('theme presets', () => {
  it('ships fourteen full combos with Swiss as the default', () => {
    expect(THEME_PRESETS.map(theme => theme.id)).toEqual([
      'swiss',
      'indigo',
      'ink',
      'graphite',
      'tundra',
      'dusk',
      'klein',
      'mono',
      'acid',
      'memphis',
      'hermes',
      'muji',
      'bauhaus',
      'luckin',
    ])
    expect(DEFAULT_THEME_ID).toBe('swiss')
  })

  it('maps pre-1.5 accent ids onto the closest theme', () => {
    expect(normalizeThemeId('blue')).toBe('graphite')
    expect(normalizeThemeId('cyan')).toBe('graphite')
    expect(normalizeThemeId('violet')).toBe('dusk')
    expect(normalizeThemeId('rose')).toBe('ink')
    expect(normalizeThemeId('amber')).toBe('ink')
    expect(normalizeThemeId('emerald')).toBe('tundra')
  })

  it('falls back to the default for missing or unknown ids', () => {
    expect(normalizeThemeId(undefined)).toBe('swiss')
    expect(normalizeThemeId('nope')).toBe('swiss')
    expect(resolveThemePreset('nope').id).toBe('swiss')
  })
})

describe('theme resolution', () => {
  it('returns the theme-specific light and dark surfaces', () => {
    expect(resolveThemeValues('swiss', 'light').surface).toBe('#f6f6f2')
    expect(resolveThemeValues('swiss', 'dark').surface).toBe('#0b0b0a')
    expect(resolveThemeValues('ink', 'light').surface).toBe('#faf8f3')
    expect(resolveThemeValues('ink', 'dark').surface).toBe('#15130f')
    expect(resolveThemeValues('graphite', 'light').surface).toBe('#fafbfc')
    expect(resolveThemeValues('graphite', 'dark').surface).toBe('#0f1216')
  })

  it('keeps Pro on graphite neutrals while taking the theme accent', () => {
    const pro = resolveThemeValues('ink', 'pro')
    expect(pro.surface).toBe('#0e0f13')
    expect(pro.surfaceRaised).toBe('#16171d')
    expect(pro.textPrimary).toBe('#e8e9ed')
    expect(pro.accent).toBe('#d97a5a')
    expect(pro.bubble).toBe('#3a2119')
    expect(pro.onAccent).toBe('#15130f')
  })

  it('uses the Swiss signal red in Pro while keeping graphite neutrals', () => {
    const pro = resolveThemeValues('swiss', 'pro')
    expect(pro.surface).toBe('#0e0f13')
    expect(pro.accent).toBe('#ff4438')
    expect(pro.onAccent).toBe('#0b0b0a')
  })

  it('resolves legacy ids before selecting values', () => {
    expect(resolveThemeValues('emerald', 'light').accent).toBe('#5f7355')
    expect(resolveThemeValues('violet', 'dark').accent).toBe('#c2a3be')
  })
})

describe('theme material', () => {
  it('gives every preset a complete, varied radius scale', () => {
    const radii = THEME_PRESETS.map((preset) => preset.shape.radiusLg)
    expect(new Set(radii).size).toBeGreaterThanOrEqual(6)
    for (const preset of THEME_PRESETS) {
      expect(preset.shape.radiusMd).toMatch(/^\d+px$/)
      expect(Number.parseFloat(preset.shape.radiusLg)).toBeLessThanOrEqual(
        Number.parseFloat(preset.shape.radius2xl),
      )
    }
  })

  it('ships a full light and dark finish for every preset', () => {
    for (const preset of THEME_PRESETS) {
      for (const mode of ['light', 'dark'] as const) {
        const material = preset.material[mode]
        expect(material.glassFill).toBeTruthy()
        expect(material.glassEdge).toBeTruthy()
        expect(material.shadowRaised).toBeTruthy()
        expect(material.shadowOverlay).toBeTruthy()
      }
    }
  })

  it('resolves legacy ids and keeps Pro glass on graphite neutrals', () => {
    expect(resolveThemeShape('emerald')).toEqual(resolveThemeShape('tundra'))
    expect(resolveThemeMaterial('violet', 'dark')).toEqual(
      resolveThemeMaterial('dusk', 'dark'),
    )
    const pro = resolveThemeMaterial('tundra', 'pro')
    expect(pro.glassFill).toBe('rgba(14, 15, 19, 0.62)')
    expect(pro.glassEdge).toBe('rgba(255, 255, 255, 0.08)')
    expect(pro.shadowOverlay).toBe(
      resolveThemeMaterial('tundra', 'dark').shadowOverlay,
    )
  })

  it('keeps semantic colors readable on the resolved surface', () => {
    for (const preset of THEME_PRESETS) {
      for (const mode of ['light', 'dark', 'pro'] as const) {
        const values = resolveThemeValues(preset.id, mode)
        for (const color of [values.success, values.warning, values.error]) {
          expect(contrast(color, values.surface)).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})

describe('color mode resolution', () => {
  it('follows the system only when no explicit mode is chosen', () => {
    expect(resolveThemeMode('system', true, false)).toBe('dark')
    expect(resolveThemeMode('system', false, false)).toBe('light')
    expect(resolveThemeMode(undefined, true, false)).toBe('dark')
  })

  it('lets an explicit light/dark mode override the system', () => {
    expect(resolveThemeMode('light', true, false)).toBe('light')
    expect(resolveThemeMode('dark', false, false)).toBe('dark')
  })

  it('keeps Pro dark regardless of the stored mode', () => {
    expect(resolveThemeMode('light', false, true)).toBe('pro')
    expect(resolveThemeMode('system', false, true)).toBe('pro')
  })
})
