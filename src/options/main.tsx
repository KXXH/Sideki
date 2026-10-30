import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/index.css'
import './options.css'
import SettingsView from '../sidepanel/views/SettingsView'
import { t } from '../shared/i18n'

const NAV_ITEMS = [
  { id: 's-provider', label: t.provider },
  { id: 's-appearance', label: t.appearance },
  { id: 's-conversation', label: t.conversation },
  { id: 's-files', label: t.files },
  { id: 's-actions', label: t.quickActions },
  { id: 's-skills', label: t.skills },
  { id: 's-memory', label: t.memory },
  { id: 's-permissions', label: t.permissions },
  { id: 's-developer', label: t.developer },
  { id: 's-data', label: t.data },
]

function OptionsApp() {
  const [activeSection, setActiveSection] = useState(NAV_ITEMS[0].id)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) { setActiveSection(entry.target.id); break }
        }
      },
      { rootMargin: '-20% 0px -70% 0px' }
    )
    for (const item of NAV_ITEMS) {
      const el = document.getElementById(item.id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [])

  return (
    <div className="options-layout">
      <nav className="options-nav">
        <h1 className="mb-6 text-sm font-semibold text-text-primary">Sideki</h1>
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                onClick={(e) => {
                  e.preventDefault()
                  document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth' })
                }}
                className={`block rounded-md px-2.5 py-1.5 text-[11px] transition-colors ${
                  activeSection === item.id
                    ? 'bg-accent-wash text-accent font-medium'
                    : 'text-text-muted hover:text-text-secondary hover:bg-surface-overlay/50'
                }`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main className="options-main">
        <SettingsView />
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
)
