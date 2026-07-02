import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ExportWorker from './components/ExportWorker'
import { applyTheme, getStoredThemeId } from './config/themes'
import './index.css'

const isExportWorker = typeof window !== 'undefined' && window.location.search.includes('export=worker')

applyTheme(getStoredThemeId())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isExportWorker ? <ExportWorker /> : <App />}
  </React.StrictMode>,
)
