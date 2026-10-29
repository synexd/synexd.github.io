import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/space-mono/400.css'
import '@fontsource/space-mono/700.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(<App />)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void (async () => {
      try {
        const base = import.meta.env.BASE_URL
        await navigator.serviceWorker.register(new URL(`${base}sw.js`, window.location.href), { scope: base })
        await navigator.serviceWorker.ready
        if (!navigator.serviceWorker.controller) {
          const key = 'local-system-isolation-reload'
          if (!window.sessionStorage.getItem(key)) {
            window.sessionStorage.setItem(key, '1')
            window.location.reload()
          }
        }
      } catch {
        // IndexedDB still caches images; v86 uses ordinary worker messages without isolation.
      }
    })()
  })
}
