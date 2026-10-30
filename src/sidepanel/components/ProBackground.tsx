import { useEffect, useState } from 'react'
import LetterGlitch from './LetterGlitch'
import { THEME_CHANGE_EVENT } from '../../shared/themes'

// Reason: LetterGlitch draws to canvas from props, so read the accent-derived
// colors from the same CSS variables applyTheme writes and re-read on change.
function readGlitchColors(): string[] {
  if (typeof document === 'undefined') return []
  const style = getComputedStyle(document.documentElement)
  return ['--glitch-1', '--glitch-2', '--glitch-3']
    .map(name => style.getPropertyValue(name).trim())
    .filter(Boolean)
}

export default function ProBackground({ active }: { active: boolean }) {
  const [glitchColors, setGlitchColors] = useState(readGlitchColors)

  useEffect(() => {
    const sync = () => setGlitchColors(readGlitchColors())
    window.addEventListener(THEME_CHANGE_EVENT, sync)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync)
  }, [])

  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden transition-opacity duration-500"
      style={{ opacity: active ? 0.15 : 0 }}
    >
      {active && (
        <LetterGlitch
          glitchColors={glitchColors.length ? glitchColors : undefined}
          glitchSpeed={80}
          centerVignette={true}
          outerVignette={true}
          smooth={true}
        />
      )}
    </div>
  )
}
