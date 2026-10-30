import type { ColorMode } from './types'

export type ThemeMode = 'light' | 'dark' | 'pro'

export interface ThemeValues {
  surface: string
  surfaceRaised: string
  surfaceOverlay: string
  borderSubtle: string
  borderMuted: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  accent: string
  accentDim: string
  accentWash: string
  accentGlow: string
  bubble: string
  bubbleText: string
  onAccent: string
  success: string
  warning: string
  error: string
  glitch: readonly [string, string, string]
}

// Reason: shape and finish live outside ThemeValues because they are mode-
// independent. Radius follows the role scale Tailwind already uses, so setting
// these variables retunes every rounded-sm/md/lg/xl/2xl utility at once.
export interface ThemeShape {
  radiusXs: string
  radiusSm: string
  radiusMd: string
  radiusLg: string
  radiusXl: string
  radius2xl: string
  borderWidth: string
  blur: string
}

export interface ThemeSurfaceMaterial {
  glassFill: string
  glassEdge: string
  shadowRaised: string
  shadowOverlay: string
}

export interface ThemePreset {
  id: string
  label: string
  hint: string
  shape: ThemeShape
  light: ThemeValues
  dark: ThemeValues
  material: {
    light: ThemeSurfaceMaterial
    dark: ThemeSurfaceMaterial
  }
}

export const DEFAULT_THEME_ID = 'swiss'

export const THEME_CHANGE_EVENT = 'sidekick:theme-change'

// Reason: Pro is an instrument mode, not a theme variant — it keeps one fixed
// graphite neutral base regardless of the chat theme. Only the accent-ish
// tokens (accent, bubble, glitch, on-accent) follow the selected theme's dark set.
const PRO_NEUTRALS: Pick<
  ThemeValues,
  'surface' | 'surfaceRaised' | 'surfaceOverlay' | 'borderSubtle' | 'borderMuted' | 'textPrimary' | 'textSecondary' | 'textMuted'
> = {
  surface: '#0e0f13',
  surfaceRaised: '#16171d',
  surfaceOverlay: '#1e1f27',
  borderSubtle: '#2a2b35',
  borderMuted: '#22232b',
  textPrimary: '#e8e9ed',
  textSecondary: '#9395a1',
  textMuted: '#5f6170',
}

// Reason: glass fill is a neutral surface, so Pro keeps the graphite tint even
// when the selected theme's dark glass is warm or green.
const PRO_GLASS_FILL = 'rgba(14, 15, 19, 0.62)'
const PRO_GLASS_EDGE = 'rgba(255, 255, 255, 0.08)'

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'swiss',
    label: '瑞士红',
    hint: '纸白 + 信号红 · 结构主义',
    shape: {
      radiusXs: '2px', radiusSm: '4px', radiusMd: '6px', radiusLg: '8px',
      radiusXl: '10px', radius2xl: '12px', borderWidth: '1px', blur: '20px',
    },
    light: {
      surface: '#f6f6f2', surfaceRaised: '#ffffff', surfaceOverlay: '#eaeae4',
      borderSubtle: '#d8d8d0', borderMuted: '#e6e6df',
      textPrimary: '#111110', textSecondary: '#5b5b56', textMuted: '#8e8e87',
      accent: '#d0261a', accentDim: '#a61a10',
      accentWash: 'rgba(208, 38, 26, 0.07)', accentGlow: 'rgba(208, 38, 26, 0.14)',
      bubble: '#ecece6', bubbleText: '#111110', onAccent: '#ffffff',
      success: '#197a4b', warning: '#9a5b00', error: '#b42318',
      glitch: ['#3a0d08', '#d0261a', '#ff6a5e'],
    },
    dark: {
      surface: '#0b0b0a', surfaceRaised: '#151514', surfaceOverlay: '#1f1f1d',
      borderSubtle: '#30302c', borderMuted: '#242421',
      textPrimary: '#f3f3ee', textSecondary: '#a8a8a1', textMuted: '#6e6e67',
      accent: '#ff4438', accentDim: '#d0261a',
      accentWash: 'rgba(255, 68, 56, 0.09)', accentGlow: 'rgba(255, 68, 56, 0.17)',
      bubble: '#232321', bubbleText: '#f3f3ee', onAccent: '#0b0b0a',
      success: '#4cc38a', warning: '#f0b429', error: '#ff7a6e',
      glitch: ['#3a0d08', '#d0261a', '#ff6a5e'],
    },
    material: {
      light: {
        glassFill: 'rgba(246, 246, 242, 0.72)',
        glassEdge: 'rgba(17, 17, 16, 0.10)',
        shadowRaised: '0 1px 2px rgba(17, 17, 16, 0.06), 0 2px 8px rgba(17, 17, 16, 0.06)',
        shadowOverlay: '0 16px 40px rgba(17, 17, 16, 0.16)',
      },
      dark: {
        glassFill: 'rgba(11, 11, 10, 0.64)',
        glassEdge: 'rgba(255, 255, 255, 0.08)',
        shadowRaised: '0 4px 14px rgba(0, 0, 0, 0.36)',
        shadowOverlay: '0 20px 48px rgba(0, 0, 0, 0.52)',
      },
    },
  },
  {
    id: 'indigo',
    label: '靛蓝',
    hint: '冷灰 + 饱和靛蓝 · 经典',
    shape: {
      radiusXs: '4px', radiusSm: '6px', radiusMd: '8px', radiusLg: '10px',
      radiusXl: '14px', radius2xl: '18px', borderWidth: '1px', blur: '24px',
    },
    light: {
      surface: '#ffffff', surfaceRaised: '#f3f4f6', surfaceOverlay: '#e8eaed',
      borderSubtle: '#d4d6dc', borderMuted: '#e5e7eb',
      textPrimary: '#18191c', textSecondary: '#5c5e66', textMuted: '#9a9da6',
      accent: '#6366f1', accentDim: '#4f46e5',
      accentWash: 'rgba(99, 102, 241, 0.07)', accentGlow: 'rgba(99, 102, 241, 0.13)',
      bubble: '#eef0ff', bubbleText: '#3730a3', onAccent: '#ffffff',
      success: '#0e7a52', warning: '#9a5c00', error: '#c22f2f',
      glitch: ['#2b2d5e', '#818cf8', '#6366f1'],
    },
    dark: {
      surface: '#0e0f13', surfaceRaised: '#16171d', surfaceOverlay: '#1e1f27',
      borderSubtle: '#2a2b35', borderMuted: '#22232b',
      textPrimary: '#e8e9ed', textSecondary: '#9395a1', textMuted: '#5f6170',
      accent: '#818cf8', accentDim: '#6366f1',
      accentWash: 'rgba(129, 140, 248, 0.08)', accentGlow: 'rgba(129, 140, 248, 0.15)',
      bubble: '#2d2e6b', bubbleText: '#c7c8ff', onAccent: '#0e0f13',
      success: '#4ade80', warning: '#fbbf24', error: '#ff8a80',
      glitch: ['#2b2d5e', '#818cf8', '#6366f1'],
    },
    material: {
      light: {
        glassFill: 'rgba(255, 255, 255, 0.70)',
        glassEdge: 'rgba(24, 25, 28, 0.08)',
        shadowRaised: '0 2px 10px rgba(52, 56, 120, 0.08)',
        shadowOverlay: '0 18px 44px rgba(52, 56, 120, 0.16)',
      },
      dark: {
        glassFill: 'rgba(14, 15, 19, 0.60)',
        glassEdge: 'rgba(255, 255, 255, 0.09)',
        shadowRaised: '0 4px 16px rgba(0, 0, 0, 0.38)',
        shadowOverlay: '0 22px 50px rgba(0, 0, 0, 0.55)',
      },
    },
  },
  {
    id: 'ink',
    label: '墨纸',
    hint: '暖纸底 + 朱砂 · 编辑部气质',
    shape: {
      radiusXs: '2px', radiusSm: '3px', radiusMd: '5px', radiusLg: '7px',
      radiusXl: '9px', radius2xl: '11px', borderWidth: '1px', blur: '10px',
    },
    light: {
      surface: '#faf8f3', surfaceRaised: '#f1eee5', surfaceOverlay: '#e8e3d7',
      borderSubtle: '#d9d2c2', borderMuted: '#e7e2d6',
      textPrimary: '#1c1a15', textSecondary: '#6a6355', textMuted: '#9b9383',
      accent: '#b5432c', accentDim: '#96351f',
      accentWash: 'rgba(181, 67, 44, 0.07)', accentGlow: 'rgba(181, 67, 44, 0.14)',
      bubble: '#f6e9e2', bubbleText: '#7a2e1d', onAccent: '#ffffff',
      success: '#48744a', warning: '#94620c', error: '#a8371f',
      glitch: ['#4f2f21', '#9b5744', '#d97a5a'],
    },
    dark: {
      surface: '#15130f', surfaceRaised: '#1d1a15', surfaceOverlay: '#262219',
      borderSubtle: '#373126', borderMuted: '#2a251c',
      textPrimary: '#ede7da', textSecondary: '#a89f8d', textMuted: '#6e6758',
      accent: '#d97a5a', accentDim: '#b5432c',
      accentWash: 'rgba(217, 122, 90, 0.09)', accentGlow: 'rgba(217, 122, 90, 0.16)',
      bubble: '#3a2119', bubbleText: '#f0c9b6', onAccent: '#15130f',
      success: '#9fc7a2', warning: '#e0b35a', error: '#e88b73',
      glitch: ['#4f2f21', '#9b5744', '#d97a5a'],
    },
    material: {
      light: {
        glassFill: 'rgba(250, 248, 243, 0.80)',
        glassEdge: 'rgba(60, 40, 25, 0.10)',
        shadowRaised: '0 1px 2px rgba(60, 40, 25, 0.08)',
        shadowOverlay: '0 16px 36px rgba(60, 40, 25, 0.18)',
      },
      dark: {
        glassFill: 'rgba(21, 19, 15, 0.70)',
        glassEdge: 'rgba(237, 231, 218, 0.08)',
        shadowRaised: '0 4px 14px rgba(0, 0, 0, 0.40)',
        shadowOverlay: '0 18px 44px rgba(0, 0, 0, 0.56)',
      },
    },
  },
  {
    id: 'graphite',
    label: '石墨',
    hint: '冷石墨 + 钢青 · 工具感',
    shape: {
      radiusXs: '1px', radiusSm: '2px', radiusMd: '4px', radiusLg: '6px',
      radiusXl: '8px', radius2xl: '10px', borderWidth: '1px', blur: '16px',
    },
    light: {
      surface: '#fafbfc', surfaceRaised: '#f2f4f6', surfaceOverlay: '#e9ecf0',
      borderSubtle: '#d6dbe1', borderMuted: '#e5e9ed',
      textPrimary: '#171a1f', textSecondary: '#5a626e', textMuted: '#949ca7',
      accent: '#4f6b8a', accentDim: '#3d5672',
      accentWash: 'rgba(79, 107, 138, 0.07)', accentGlow: 'rgba(79, 107, 138, 0.14)',
      bubble: '#eaeff5', bubbleText: '#2c4157', onAccent: '#ffffff',
      success: '#1c7a5c', warning: '#9a6208', error: '#b93a32',
      glitch: ['#35424f', '#657b94', '#8fa9c6'],
    },
    dark: {
      surface: '#0f1216', surfaceRaised: '#161a20', surfaceOverlay: '#1e232b',
      borderSubtle: '#2b333d', borderMuted: '#222932',
      textPrimary: '#e6eaf0', textSecondary: '#98a2af', textMuted: '#606b79',
      accent: '#8fa9c6', accentDim: '#6a87a8',
      accentWash: 'rgba(143, 169, 198, 0.08)', accentGlow: 'rgba(143, 169, 198, 0.15)',
      bubble: '#1e2c3b', bubbleText: '#c6d6e6', onAccent: '#0f1216',
      success: '#5fd0a6', warning: '#e6b45c', error: '#f18b83',
      glitch: ['#35424f', '#657b94', '#8fa9c6'],
    },
    material: {
      light: {
        glassFill: 'rgba(250, 251, 252, 0.58)',
        glassEdge: 'rgba(23, 26, 31, 0.10)',
        shadowRaised: '0 1px 0 rgba(15, 18, 22, 0.04), 0 2px 6px rgba(15, 18, 22, 0.08)',
        shadowOverlay: '0 12px 28px rgba(15, 18, 22, 0.18)',
      },
      dark: {
        glassFill: 'rgba(15, 18, 22, 0.58)',
        glassEdge: 'rgba(255, 255, 255, 0.07)',
        shadowRaised: '0 2px 8px rgba(0, 0, 0, 0.42)',
        shadowOverlay: '0 14px 34px rgba(0, 0, 0, 0.58)',
      },
    },
  },
  {
    id: 'tundra',
    label: '苔原',
    hint: '绿灰底 + 鼠尾草 · 安静克制',
    shape: {
      radiusXs: '5px', radiusSm: '7px', radiusMd: '10px', radiusLg: '14px',
      radiusXl: '18px', radius2xl: '22px', borderWidth: '1px', blur: '28px',
    },
    light: {
      surface: '#fafaf5', surfaceRaised: '#f2f3eb', surfaceOverlay: '#e8eae0',
      borderSubtle: '#d6d9cb', borderMuted: '#e6e8dc',
      textPrimary: '#1a1c17', textSecondary: '#5e655a', textMuted: '#959b8e',
      accent: '#5f7355', accentDim: '#4b5d43',
      accentWash: 'rgba(95, 115, 85, 0.07)', accentGlow: 'rgba(95, 115, 85, 0.14)',
      bubble: '#edf1e6', bubbleText: '#38462f', onAccent: '#ffffff',
      success: '#4c7438', warning: '#8a640f', error: '#a8462f',
      glitch: ['#303a2c', '#74806a', '#a9bc99'],
    },
    dark: {
      surface: '#111410', surfaceRaised: '#181c17', surfaceOverlay: '#20251e',
      borderSubtle: '#2e352b', borderMuted: '#252b23',
      textPrimary: '#e8ebe1', textSecondary: '#9ba394', textMuted: '#646c5f',
      accent: '#a9bc99', accentDim: '#869b77',
      accentWash: 'rgba(169, 188, 153, 0.08)', accentGlow: 'rgba(169, 188, 153, 0.15)',
      bubble: '#26301f', bubbleText: '#cfdcc0', onAccent: '#111410',
      success: '#a5cd8c', warning: '#e2bf66', error: '#e8987f',
      glitch: ['#303a2c', '#74806a', '#a9bc99'],
    },
    material: {
      light: {
        glassFill: 'rgba(250, 250, 245, 0.74)',
        glassEdge: 'rgba(48, 58, 44, 0.09)',
        shadowRaised: '0 2px 10px rgba(48, 58, 44, 0.10)',
        shadowOverlay: '0 18px 44px rgba(48, 58, 44, 0.18)',
      },
      dark: {
        glassFill: 'rgba(17, 20, 16, 0.64)',
        glassEdge: 'rgba(232, 235, 225, 0.08)',
        shadowRaised: '0 4px 16px rgba(0, 0, 0, 0.36)',
        shadowOverlay: '0 20px 48px rgba(0, 0, 0, 0.52)',
      },
    },
  },
  {
    id: 'dusk',
    label: '暮紫',
    hint: '藕灰底 + 干梅 · 柔和个性',
    shape: {
      radiusXs: '4px', radiusSm: '7px', radiusMd: '10px', radiusLg: '16px',
      radiusXl: '20px', radius2xl: '26px', borderWidth: '1px', blur: '36px',
    },
    light: {
      surface: '#faf8fa', surfaceRaised: '#f3f0f3', surfaceOverlay: '#eae6ea',
      borderSubtle: '#dad3d9', borderMuted: '#e8e3e8',
      textPrimary: '#1d191d', textSecondary: '#655d64', textMuted: '#9c939a',
      accent: '#7d5c78', accentDim: '#664761',
      accentWash: 'rgba(125, 92, 120, 0.07)', accentGlow: 'rgba(125, 92, 120, 0.14)',
      bubble: '#f2e9f0', bubbleText: '#53304d', onAccent: '#ffffff',
      success: '#2f775f', warning: '#93620f', error: '#a83a54',
      glitch: ['#47383f', '#87717f', '#c2a3be'],
    },
    dark: {
      surface: '#131013', surfaceRaised: '#1b171b', surfaceOverlay: '#241f24',
      borderSubtle: '#332b33', borderMuted: '#292229',
      textPrimary: '#ece6ec', textSecondary: '#a79da6', textMuted: '#6c626b',
      accent: '#c2a3be', accentDim: '#a3849f',
      accentWash: 'rgba(194, 163, 190, 0.08)', accentGlow: 'rgba(194, 163, 190, 0.15)',
      bubble: '#33212f', bubbleText: '#e2cde0', onAccent: '#131013',
      success: '#8fd6b6', warning: '#e3bc70', error: '#eb94a8',
      glitch: ['#47383f', '#87717f', '#c2a3be'],
    },
    material: {
      light: {
        glassFill: 'rgba(250, 248, 250, 0.66)',
        glassEdge: 'rgba(70, 50, 68, 0.09)',
        shadowRaised: '0 2px 14px rgba(70, 50, 68, 0.10)',
        shadowOverlay: '0 20px 52px rgba(70, 50, 68, 0.20)',
      },
      dark: {
        glassFill: 'rgba(19, 16, 19, 0.58)',
        glassEdge: 'rgba(255, 255, 255, 0.10)',
        shadowRaised: '0 4px 18px rgba(0, 0, 0, 0.34), 0 0 18px rgba(194, 163, 190, 0.06)',
        shadowOverlay: '0 24px 56px rgba(0, 0, 0, 0.50)',
      },
    },
  },
  {
    id: 'klein',
    label: '克莱因蓝',
    hint: '纸白 + 群青 · 编辑设计',
    shape: {
      radiusXs: '1px', radiusSm: '2px', radiusMd: '4px', radiusLg: '6px',
      radiusXl: '8px', radius2xl: '10px', borderWidth: '1px', blur: '14px',
    },
    light: {
      surface: '#f7f6f1', surfaceRaised: '#ffffff', surfaceOverlay: '#eceae2',
      borderSubtle: '#d8d5c9', borderMuted: '#e6e3d9',
      textPrimary: '#111110', textSecondary: '#4f4e48', textMuted: '#828077',
      accent: '#002fa7', accentDim: '#002277',
      accentWash: 'rgba(0, 47, 167, 0.07)', accentGlow: 'rgba(0, 47, 167, 0.14)',
      bubble: '#e8ecf9', bubbleText: '#0b2a7a', onAccent: '#ffffff',
      success: '#1f6f4a', warning: '#9a5b00', error: '#b42318',
      glitch: ['#0b1a4d', '#3f63d9', '#7c97ff'],
    },
    dark: {
      surface: '#0a0e1a', surfaceRaised: '#11172a', surfaceOverlay: '#19203a',
      borderSubtle: '#26304d', borderMuted: '#1b2338',
      textPrimary: '#f2f4fa', textSecondary: '#a9b1c7', textMuted: '#6f7994',
      accent: '#7c97ff', accentDim: '#4b68d6',
      accentWash: 'rgba(124, 151, 255, 0.10)', accentGlow: 'rgba(124, 151, 255, 0.18)',
      bubble: '#16244d', bubbleText: '#d6deff', onAccent: '#0a0e1a',
      success: '#7fd6a4', warning: '#e6c06a', error: '#ff8f86',
      glitch: ['#0b1a4d', '#3f63d9', '#7c97ff'],
    },
    material: {
      light: {
        glassFill: 'rgba(247, 246, 241, 0.70)',
        glassEdge: 'rgba(17, 17, 16, 0.10)',
        shadowRaised: '0 1px 0 rgba(17, 17, 16, 0.06), 0 2px 6px rgba(17, 17, 16, 0.08)',
        shadowOverlay: '0 12px 28px rgba(17, 17, 16, 0.18)',
      },
      dark: {
        glassFill: 'rgba(10, 14, 26, 0.62)',
        glassEdge: 'rgba(242, 244, 250, 0.08)',
        shadowRaised: '0 2px 8px rgba(0, 0, 0, 0.44)',
        shadowOverlay: '0 14px 34px rgba(0, 0, 0, 0.60)',
      },
    },
  },
  {
    id: 'mono',
    label: '黑白',
    hint: '纸白 + 墨黑 · 无彩色',
    shape: {
      radiusXs: '0px', radiusSm: '2px', radiusMd: '4px', radiusLg: '6px',
      radiusXl: '8px', radius2xl: '10px', borderWidth: '1px', blur: '12px',
    },
    light: {
      surface: '#f7f7f5', surfaceRaised: '#ffffff', surfaceOverlay: '#ededea',
      borderSubtle: '#d8d8d4', borderMuted: '#e6e6e2',
      textPrimary: '#0a0a0a', textSecondary: '#4a4a46', textMuted: '#85857f',
      accent: '#0a0a0a', accentDim: '#000000',
      accentWash: 'rgba(10, 10, 10, 0.06)', accentGlow: 'rgba(10, 10, 10, 0.12)',
      bubble: '#ededea', bubbleText: '#0a0a0a', onAccent: '#ffffff',
      success: '#2f6b3f', warning: '#7a5a00', error: '#a32020',
      glitch: ['#1e1e1e', '#666666', '#f5f5f0'],
    },
    dark: {
      surface: '#0a0a0a', surfaceRaised: '#141414', surfaceOverlay: '#1e1e1e',
      borderSubtle: '#303030', borderMuted: '#242424',
      textPrimary: '#f5f5f0', textSecondary: '#b0b0a8', textMuted: '#7a7a74',
      accent: '#f5f5f0', accentDim: '#d0d0c8',
      accentWash: 'rgba(245, 245, 240, 0.08)', accentGlow: 'rgba(245, 245, 240, 0.15)',
      bubble: '#232323', bubbleText: '#f5f5f0', onAccent: '#0a0a0a',
      success: '#a8d8a8', warning: '#e0c878', error: '#f08a8a',
      glitch: ['#1e1e1e', '#666666', '#f5f5f0'],
    },
    material: {
      light: {
        glassFill: 'rgba(247, 247, 245, 0.64)',
        glassEdge: 'rgba(10, 10, 10, 0.10)',
        shadowRaised: '0 1px 0 rgba(10, 10, 10, 0.06), 0 2px 6px rgba(10, 10, 10, 0.08)',
        shadowOverlay: '0 12px 28px rgba(10, 10, 10, 0.18)',
      },
      dark: {
        glassFill: 'rgba(10, 10, 10, 0.60)',
        glassEdge: 'rgba(245, 245, 240, 0.08)',
        shadowRaised: '0 2px 8px rgba(0, 0, 0, 0.44)',
        shadowOverlay: '0 14px 34px rgba(0, 0, 0, 0.60)',
      },
    },
  },
  {
    id: 'acid',
    label: '酸性',
    hint: '荧光黄绿 + 紫 · 数字反叛',
    shape: {
      radiusXs: '0px', radiusSm: '1px', radiusMd: '2px', radiusLg: '4px',
      radiusXl: '6px', radius2xl: '8px', borderWidth: '2px', blur: '12px',
    },
    light: {
      surface: '#f3f5e8', surfaceRaised: '#fafcef', surfaceOverlay: '#e7eacc',
      borderSubtle: '#cdd2b4', borderMuted: '#e0e4c8',
      textPrimary: '#12150b', textSecondary: '#4a5137', textMuted: '#7c8566',
      accent: '#3f6a12', accentDim: '#2f500c',
      accentWash: 'rgba(63, 106, 18, 0.08)', accentGlow: 'rgba(63, 106, 18, 0.15)',
      bubble: '#dfff7a', bubbleText: '#1a2400', onAccent: '#f8ffe8',
      success: '#4f7a1a', warning: '#8a5a00', error: '#b42318',
      glitch: ['#c6ff00', '#7c3aed', '#ff2d95'],
    },
    dark: {
      surface: '#0a0b06', surfaceRaised: '#12140c', surfaceOverlay: '#1a1d10',
      borderSubtle: '#2c331c', borderMuted: '#202514',
      textPrimary: '#eeffd8', textSecondary: '#b5c49c', textMuted: '#7b8a63',
      accent: '#c6ff00', accentDim: '#9bcb00',
      accentWash: 'rgba(198, 255, 0, 0.10)', accentGlow: 'rgba(198, 255, 0, 0.18)',
      bubble: '#2a0f3f', bubbleText: '#e9d8ff', onAccent: '#0a0b06',
      success: '#c6ff00', warning: '#e6c06a', error: '#ff7a70',
      glitch: ['#c6ff00', '#7c3aed', '#ff2d95'],
    },
    material: {
      light: {
        glassFill: 'rgba(243, 245, 232, 0.72)',
        glassEdge: 'rgba(18, 21, 11, 0.18)',
        shadowRaised: '3px 3px 0 rgba(18, 21, 11, 0.92)',
        shadowOverlay: '6px 6px 0 rgba(18, 21, 11, 0.92)',
      },
      dark: {
        glassFill: 'rgba(10, 11, 6, 0.62)',
        glassEdge: 'rgba(238, 255, 216, 0.08)',
        shadowRaised: '3px 3px 0 rgba(198, 255, 0, 0.92)',
        shadowOverlay: '6px 6px 0 rgba(198, 255, 0, 0.92)',
      },
    },
  },
  {
    id: 'memphis',
    label: '孟菲斯',
    hint: '奶油 + 洋红 + 钴蓝 · 80s 玩心',
    shape: {
      radiusXs: '6px', radiusSm: '10px', radiusMd: '14px', radiusLg: '18px',
      radiusXl: '24px', radius2xl: '30px', borderWidth: '2px', blur: '20px',
    },
    light: {
      surface: '#f5f0e4', surfaceRaised: '#fffcf5', surfaceOverlay: '#e9e2d2',
      borderSubtle: '#cfc4b0', borderMuted: '#e2d9c8',
      textPrimary: '#161513', textSecondary: '#4c4941', textMuted: '#877f72',
      accent: '#ca1b54', accentDim: '#a81446',
      accentWash: 'rgba(202, 27, 84, 0.08)', accentGlow: 'rgba(202, 27, 84, 0.15)',
      bubble: '#1d4ed8', bubbleText: '#fff9ef', onAccent: '#ffffff',
      success: '#1f6b5a', warning: '#8a5a00', error: '#ca1b54',
      glitch: ['#ca1b54', '#1d4ed8', '#f2c14e'],
    },
    dark: {
      surface: '#121110', surfaceRaised: '#1c1a18', surfaceOverlay: '#272420',
      borderSubtle: '#3c3832', borderMuted: '#2c2925',
      textPrimary: '#f6f0e4', textSecondary: '#c3bbad', textMuted: '#8b8275',
      accent: '#ff4d8d', accentDim: '#ca1b54',
      accentWash: 'rgba(255, 77, 141, 0.12)', accentGlow: 'rgba(255, 77, 141, 0.20)',
      bubble: '#1d4ed8', bubbleText: '#fff9ef', onAccent: '#121110',
      success: '#7fd6c0', warning: '#f2c14e', error: '#ff6b9f',
      glitch: ['#ca1b54', '#1d4ed8', '#f2c14e'],
    },
    material: {
      light: {
        glassFill: 'rgba(245, 240, 228, 0.76)',
        glassEdge: 'rgba(22, 21, 19, 0.16)',
        shadowRaised: '3px 3px 0 rgba(29, 78, 216, 0.92)',
        shadowOverlay: '6px 6px 0 rgba(29, 78, 216, 0.92)',
      },
      dark: {
        glassFill: 'rgba(18, 17, 16, 0.66)',
        glassEdge: 'rgba(246, 240, 228, 0.08)',
        shadowRaised: '3px 3px 0 rgba(255, 77, 141, 0.92)',
        shadowOverlay: '6px 6px 0 rgba(255, 77, 141, 0.92)',
      },
    },
  },
  {
    id: 'hermes',
    label: '爱马仕橙',
    hint: '牛皮纸 + 橙 · 马具与丝巾',
    shape: {
      radiusXs: '3px', radiusSm: '5px', radiusMd: '8px', radiusLg: '11px',
      radiusXl: '14px', radius2xl: '18px', borderWidth: '1px', blur: '16px',
    },
    light: {
      surface: '#f6f0e5', surfaceRaised: '#fffbf4', surfaceOverlay: '#ebe1d2',
      borderSubtle: '#d8c9b5', borderMuted: '#e7dbca',
      textPrimary: '#241a12', textSecondary: '#5e4b3a', textMuted: '#8c7a65',
      accent: '#b84208', accentDim: '#963505',
      accentWash: 'rgba(184, 66, 8, 0.08)', accentGlow: 'rgba(184, 66, 8, 0.15)',
      bubble: '#ebd3bd', bubbleText: '#3c2312', onAccent: '#fff8f0',
      success: '#3f6b3f', warning: '#9a5b00', error: '#b84208',
      glitch: ['#b84208', '#7a3a16', '#f5a623'],
    },
    dark: {
      surface: '#1a120c', surfaceRaised: '#261a12', surfaceOverlay: '#33241a',
      borderSubtle: '#4b3625', borderMuted: '#38281b',
      textPrimary: '#f8efe2', textSecondary: '#c9b59e', textMuted: '#947e67',
      accent: '#ff8a3d', accentDim: '#d9530f',
      accentWash: 'rgba(255, 138, 61, 0.12)', accentGlow: 'rgba(255, 138, 61, 0.20)',
      bubble: '#4a2a16', bubbleText: '#f6d9be', onAccent: '#1a120c',
      success: '#8fc98a', warning: '#d9b45f', error: '#ff8a3d',
      glitch: ['#b84208', '#7a3a16', '#f5a623'],
    },
    material: {
      light: {
        glassFill: 'rgba(246, 240, 229, 0.78)',
        glassEdge: 'rgba(36, 26, 18, 0.10)',
        shadowRaised: '0 2px 10px rgba(94, 75, 58, 0.10)',
        shadowOverlay: '0 18px 44px rgba(94, 75, 58, 0.18)',
      },
      dark: {
        glassFill: 'rgba(26, 18, 12, 0.68)',
        glassEdge: 'rgba(248, 239, 226, 0.08)',
        shadowRaised: '0 4px 16px rgba(0, 0, 0, 0.38)',
        shadowOverlay: '0 22px 50px rgba(0, 0, 0, 0.55)',
      },
    },
  },
  {
    id: 'muji',
    label: '无印',
    hint: '棉麻 + 柿红 · 朴素克制',
    shape: {
      radiusXs: '2px', radiusSm: '4px', radiusMd: '6px', radiusLg: '9px',
      radiusXl: '12px', radius2xl: '16px', borderWidth: '1px', blur: '10px',
    },
    light: {
      surface: '#f1ece3', surfaceRaised: '#faf7f0', surfaceOverlay: '#e5dfd3',
      borderSubtle: '#d0c8b9', borderMuted: '#e1dbd0',
      textPrimary: '#2a2823', textSecondary: '#585349', textMuted: '#898274',
      accent: '#8a1c1c', accentDim: '#6b1212',
      accentWash: 'rgba(138, 28, 28, 0.07)', accentGlow: 'rgba(138, 28, 28, 0.14)',
      bubble: '#dccdb4', bubbleText: '#3b2f1e', onAccent: '#faf7f0',
      success: '#4f6b3f', warning: '#8a5a0c', error: '#8a1c1c',
      glitch: ['#4a2a22', '#8a1c1c', '#c46a4e'],
    },
    dark: {
      surface: '#17140f', surfaceRaised: '#211d17', surfaceOverlay: '#2b261e',
      borderSubtle: '#3d372c', borderMuted: '#2e2920',
      textPrimary: '#eae3d5', textSecondary: '#b3a993', textMuted: '#807663',
      accent: '#d08a78', accentDim: '#a85a4a',
      accentWash: 'rgba(208, 138, 120, 0.12)', accentGlow: 'rgba(208, 138, 120, 0.20)',
      bubble: '#342a1d', bubbleText: '#e6d9c3', onAccent: '#17140f',
      success: '#a8c98a', warning: '#d9b45f', error: '#d08a78',
      glitch: ['#4a2a22', '#8a1c1c', '#c46a4e'],
    },
    material: {
      light: {
        glassFill: 'rgba(241, 236, 227, 0.82)',
        glassEdge: 'rgba(42, 40, 35, 0.10)',
        shadowRaised: '0 1px 2px rgba(88, 83, 73, 0.07)',
        shadowOverlay: '0 14px 34px rgba(88, 83, 73, 0.15)',
      },
      dark: {
        glassFill: 'rgba(23, 20, 15, 0.72)',
        glassEdge: 'rgba(234, 227, 213, 0.08)',
        shadowRaised: '0 3px 12px rgba(0, 0, 0, 0.36)',
        shadowOverlay: '0 18px 40px rgba(0, 0, 0, 0.52)',
      },
    },
  },
  {
    id: 'bauhaus',
    label: '包豪斯',
    hint: '纸白 + 三原色 · 几何宣言',
    shape: {
      radiusXs: '0px', radiusSm: '1px', radiusMd: '2px', radiusLg: '4px',
      radiusXl: '6px', radius2xl: '8px', borderWidth: '2px', blur: '8px',
    },
    light: {
      surface: '#f5f1e8', surfaceRaised: '#ffffff', surfaceOverlay: '#eae4d8',
      borderSubtle: '#c9c2b4', borderMuted: '#e0d9cc',
      textPrimary: '#111111', textSecondary: '#4c4a44', textMuted: '#858176',
      accent: '#d22b1f', accentDim: '#a81f15',
      accentWash: 'rgba(210, 43, 31, 0.08)', accentGlow: 'rgba(210, 43, 31, 0.15)',
      bubble: '#1d4ed8', bubbleText: '#f5f1e8', onAccent: '#ffffff',
      success: '#2f6b3f', warning: '#9a5b00', error: '#d22b1f',
      glitch: ['#1d4ed8', '#d22b1f', '#f2c14e'],
    },
    dark: {
      surface: '#121212', surfaceRaised: '#1c1c1c', surfaceOverlay: '#262626',
      borderSubtle: '#3a3a3a', borderMuted: '#2a2a2a',
      textPrimary: '#f5f1e8', textSecondary: '#c4c0b6', textMuted: '#89857b',
      accent: '#ff5545', accentDim: '#d22b1f',
      accentWash: 'rgba(255, 85, 69, 0.12)', accentGlow: 'rgba(255, 85, 69, 0.20)',
      bubble: '#1d4ed8', bubbleText: '#f5f1e8', onAccent: '#121212',
      success: '#8fd6a0', warning: '#f2c14e', error: '#ff6b5f',
      glitch: ['#1d4ed8', '#d22b1f', '#f2c14e'],
    },
    material: {
      light: {
        glassFill: 'rgba(245, 241, 232, 0.80)',
        glassEdge: 'rgba(17, 17, 17, 0.18)',
        shadowRaised: '3px 3px 0 rgba(17, 17, 17, 0.92)',
        shadowOverlay: '6px 6px 0 rgba(17, 17, 17, 0.92)',
      },
      dark: {
        glassFill: 'rgba(18, 18, 18, 0.70)',
        glassEdge: 'rgba(245, 241, 232, 0.14)',
        shadowRaised: '3px 3px 0 rgba(245, 241, 232, 0.92)',
        shadowOverlay: '6px 6px 0 rgba(245, 241, 232, 0.92)',
      },
    },
  },
  {
    id: 'luckin',
    label: '瑞幸蓝',
    hint: '奶咖 + 品牌蓝 · 日常活力',
    shape: {
      radiusXs: '4px', radiusSm: '6px', radiusMd: '9px', radiusLg: '12px',
      radiusXl: '16px', radius2xl: '20px', borderWidth: '1px', blur: '24px',
    },
    light: {
      surface: '#f5f0e6', surfaceRaised: '#fffdf8', surfaceOverlay: '#e9e2d5',
      borderSubtle: '#d2c9b9', borderMuted: '#e3dccf',
      textPrimary: '#0d1b33', textSecondary: '#46536a', textMuted: '#768294',
      accent: '#003da5', accentDim: '#002d7a',
      accentWash: 'rgba(0, 61, 165, 0.07)', accentGlow: 'rgba(0, 61, 165, 0.14)',
      bubble: '#dce7f8', bubbleText: '#08245a', onAccent: '#ffffff',
      success: '#1f6f5a', warning: '#9a5b00', error: '#b42318',
      glitch: ['#071121', '#003da5', '#4f8dff'],
    },
    dark: {
      surface: '#0b1424', surfaceRaised: '#111e32', surfaceOverlay: '#172740',
      borderSubtle: '#243a5c', borderMuted: '#192b45',
      textPrimary: '#f2eee5', textSecondary: '#b4becf', textMuted: '#7888a0',
      accent: '#4f8dff', accentDim: '#2f6fed',
      accentWash: 'rgba(79, 141, 255, 0.12)', accentGlow: 'rgba(79, 141, 255, 0.20)',
      bubble: '#162c50', bubbleText: '#d8e3ff', onAccent: '#071121',
      success: '#6fd6b0', warning: '#e6c06a', error: '#ff8f86',
      glitch: ['#071121', '#003da5', '#4f8dff'],
    },
    material: {
      light: {
        glassFill: 'rgba(245, 240, 230, 0.72)',
        glassEdge: 'rgba(13, 27, 51, 0.10)',
        shadowRaised: '0 2px 10px rgba(70, 83, 106, 0.10)',
        shadowOverlay: '0 18px 44px rgba(70, 83, 106, 0.18)',
      },
      dark: {
        glassFill: 'rgba(11, 20, 36, 0.62)',
        glassEdge: 'rgba(242, 238, 229, 0.08)',
        shadowRaised: '0 4px 16px rgba(0, 0, 0, 0.38)',
        shadowOverlay: '0 22px 50px rgba(0, 0, 0, 0.55)',
      },
    },
  },
]

// Reason: accentColor ids shipped before 1.5.0. Map them onto the closest full
// theme so an existing config keeps its intended tint instead of resetting.
const LEGACY_THEME_IDS: Record<string, string> = {
  blue: 'graphite',
  cyan: 'graphite',
  violet: 'dusk',
  rose: 'ink',
  amber: 'ink',
  emerald: 'tundra',
}

export function normalizeThemeId(id: string | undefined): string {
  if (!id) return DEFAULT_THEME_ID
  if (THEME_PRESETS.some(preset => preset.id === id)) return id
  return LEGACY_THEME_IDS[id] ?? DEFAULT_THEME_ID
}

export function resolveThemePreset(id: string | undefined): ThemePreset {
  const normalized = normalizeThemeId(id)
  return THEME_PRESETS.find(preset => preset.id === normalized) ?? THEME_PRESETS[0]
}

export function resolveThemeValues(id: string | undefined, mode: ThemeMode): ThemeValues {
  const preset = resolveThemePreset(id)
  if (mode === 'pro') return { ...preset.dark, ...PRO_NEUTRALS }
  return mode === 'dark' ? preset.dark : preset.light
}

export function resolveThemeShape(id: string | undefined): ThemeShape {
  return resolveThemePreset(id).shape
}

export function resolveThemeMaterial(id: string | undefined, mode: ThemeMode): ThemeSurfaceMaterial {
  const preset = resolveThemePreset(id)
  if (mode === 'pro') {
    return {
      ...preset.material.dark,
      glassFill: PRO_GLASS_FILL,
      glassEdge: PRO_GLASS_EDGE,
    }
  }
  return mode === 'light' ? preset.material.light : preset.material.dark
}

const CSS_VARIABLES: Record<Exclude<keyof ThemeValues, 'glitch'>, string> = {
  surface: '--color-surface',
  surfaceRaised: '--color-surface-raised',
  surfaceOverlay: '--color-surface-overlay',
  borderSubtle: '--color-border-subtle',
  borderMuted: '--color-border-muted',
  textPrimary: '--color-text-primary',
  textSecondary: '--color-text-secondary',
  textMuted: '--color-text-muted',
  accent: '--color-accent',
  accentDim: '--color-accent-dim',
  accentWash: '--color-accent-wash',
  accentGlow: '--color-accent-glow',
  bubble: '--color-user-bubble',
  bubbleText: '--color-user-bubble-text',
  onAccent: '--color-on-accent',
  success: '--color-success',
  warning: '--color-warning',
  error: '--color-error',
}

const SHAPE_VARIABLES: Record<keyof ThemeShape, string> = {
  radiusXs: '--radius-xs',
  radiusSm: '--radius-sm',
  radiusMd: '--radius-md',
  radiusLg: '--radius-lg',
  radiusXl: '--radius-xl',
  radius2xl: '--radius-2xl',
  borderWidth: '--theme-border-width',
  blur: '--theme-blur',
}

const MATERIAL_VARIABLES: Record<keyof ThemeSurfaceMaterial, string> = {
  glassFill: '--theme-glass-fill',
  glassEdge: '--theme-glass-edge',
  shadowRaised: '--theme-shadow-raised',
  shadowOverlay: '--theme-shadow-overlay',
}

const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

let currentId = DEFAULT_THEME_ID
let currentPro = false
let currentColorMode: ColorMode = 'system'

export function resolveThemeMode(
  colorMode: ColorMode | undefined,
  systemDark: boolean,
  pro: boolean,
): ThemeMode {
  if (pro) return 'pro'
  if (colorMode === 'light' || colorMode === 'dark') return colorMode
  return systemDark ? 'dark' : 'light'
}

function resolvedMode(): ThemeMode {
  return resolveThemeMode(currentColorMode, mq?.matches ?? false, currentPro)
}

export function getResolvedThemeMode(): ThemeMode {
  return resolvedMode()
}

export function resolveThemeProperties(id: string | undefined, mode: ThemeMode): Record<string, string> {
  const values = resolveThemeValues(id, mode)
  const shape = resolveThemeShape(id)
  const material = resolveThemeMaterial(id, mode)
  const properties: Record<string, string> = {}
  for (const key of Object.keys(CSS_VARIABLES) as Array<keyof typeof CSS_VARIABLES>) properties[CSS_VARIABLES[key]] = values[key]
  for (const key of Object.keys(SHAPE_VARIABLES) as Array<keyof ThemeShape>) properties[SHAPE_VARIABLES[key]] = shape[key]
  for (const key of Object.keys(MATERIAL_VARIABLES) as Array<keyof ThemeSurfaceMaterial>) properties[MATERIAL_VARIABLES[key]] = material[key]
  values.glitch.forEach((color, index) => { properties[`--glitch-${index + 1}`] = color })
  return properties
}

function renderTheme() {
  const mode = resolvedMode()
  const style = document.documentElement.style
  for (const [key, value] of Object.entries(resolveThemeProperties(currentId, mode))) style.setProperty(key, value)
  // Reason: force native controls, scrollbars and light-dark() to match the
  // resolved mode instead of the OS, so an explicit light/dark choice is total.
  const scheme = mode === 'light' ? 'light' : 'dark'
  document.documentElement.style.colorScheme = scheme
  document.documentElement.dataset.colorMode = scheme
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT))
}

export function applyTheme(id: string | undefined) {
  currentId = resolveThemePreset(id).id
  renderTheme()
}

export function applyColorMode(mode: string | undefined) {
  currentColorMode = mode === 'light' || mode === 'dark' ? mode : 'system'
  renderTheme()
}

// Reason: Pro mode forces a dark instrument surface but must still resolve the
// selected theme's dark accent. Keeping the flag here (rather than only in CSS)
// prevents a light-OS session from pairing light accent tokens with a dark panel.
export function applyProMode(enabled: boolean) {
  currentPro = enabled
  document.documentElement.classList.toggle('pro-mode', enabled)
  renderTheme()
}

mq?.addEventListener('change', () => {
  if (!currentPro && currentColorMode === 'system') renderTheme()
})

const FONT_FAMILIES: Record<string, string> = {
  sans: "'DM Sans', system-ui, sans-serif",
  serif: "'Georgia', 'Noto Serif SC', serif",
}

const FONT_SIZES: Record<string, string> = {
  compact: '12px',
  default: '13px',
  relaxed: '14px',
}

export function applyFont(family: string, size: string) {
  const s = document.documentElement.style
  s.setProperty('--font-content', FONT_FAMILIES[family] || FONT_FAMILIES.sans)
  s.setProperty('--font-content-size', FONT_SIZES[size] || FONT_SIZES.default)
}
