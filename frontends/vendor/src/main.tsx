import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initPostHog } from './lib/posthog'

// Signals the boot-splash watchdog in index.html. `__BB_BOOT_JS__` means the
// entry bundle executed (so a stale/failed asset is ruled out and it stops
// reloading); `__BB_BOOTED__` below means React actually rendered.
const bootWin = window as unknown as { __BB_BOOT_JS__?: boolean; __BB_BOOTED__?: boolean }
bootWin.__BB_BOOT_JS__ = true

// Analytics is off the critical path — load posthog-js once the browser is
// idle (or shortly after) rather than competing with first paint.
const startAnalytics = () => void initPostHog()
if ('requestIdleCallback' in window) {
  ;(window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(startAnalytics)
} else {
  setTimeout(startAnalytics, 2000)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

bootWin.__BB_BOOTED__ = true
