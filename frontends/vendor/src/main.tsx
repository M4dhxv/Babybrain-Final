import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initPostHog } from './lib/posthog'
import {
  RouteErrorBoundary,
  isChunkLoadError,
  reloadForChunkError,
  clearChunkReloadBudget,
  hadRouteError,
} from './components/RouteErrorBoundary'

// A stale chunk can also blow up OUTSIDE React's render path — a deferred
// prefetch, a dynamic import() in an event handler, Vite's own preloader. The
// route boundary never sees those, so catch them here: a matching failure gets
// the same one-reload-then-stop treatment (the fresh index.html fixes it),
// anything else is left for the app's own handlers / the index.html watchdog.
window.addEventListener('error', (e) => {
  if (isChunkLoadError(e.error) || isChunkLoadError({ message: e.message })) reloadForChunkError()
})
window.addEventListener('unhandledrejection', (e) => {
  if (isChunkLoadError(e.reason)) reloadForChunkError()
})

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
    {/* Outermost net: above AuthProvider (which lives inside App), so a fault
        in auth boot or the router itself still shows the recovery panel rather
        than a blank #root. */}
    <RouteErrorBoundary>
      <App />
    </RouteErrorBoundary>
  </StrictMode>,
)

bootWin.__BB_BOOTED__ = true

// If the app has been up a few seconds without a boundary catching anything,
// this build is fine — hand the stale-chunk reload budget back so a genuinely
// new failure later gets its own reloads. A reload loop trips well before this
// fires, so it can never reset its own rate limit.
setTimeout(() => {
  if (!hadRouteError()) clearChunkReloadBudget()
}, 6000)
