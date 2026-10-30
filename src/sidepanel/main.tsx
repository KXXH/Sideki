import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/index.css'
import App from './App'
import StorageMigrationGate from './components/StorageMigrationGate'
import './viz-probe-host'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StorageMigrationGate>
      <App />
    </StorageMigrationGate>
  </StrictMode>,
)
