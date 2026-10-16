import { useEffect, useState } from 'react';
import '@/styles/look-boutique.css';

/* "Soft boutique" look for the portal — the default for every vendor.
 *
 * `?look=classic` switches this browser back to the previous look and
 * `?look=boutique` switches it back again (either before or after the
 * `#/route`); the choice is remembered in localStorage so it survives
 * navigation and reloads. Every rule lives under `html.look-boutique` in
 * styles/look-boutique.css, so the classic look renders exactly as the portal
 * did before. The class goes on <html> rather than the layout so Radix dialogs
 * and popovers, which portal to <body>, pick it up too. */
const KEY = 'bb:vendor-look';
const FONT_ID = 'bb-look-boutique-font';

type Look = 'boutique' | 'classic';

function readLook(): Look {
  try {
    const fromSearch = new URLSearchParams(window.location.search).get('look');
    const fromHash = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('look');
    const asked = fromSearch ?? fromHash;
    if (asked === 'boutique' || asked === 'classic') localStorage.setItem(KEY, asked);
    return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'boutique';
  } catch {
    return 'boutique';
  }
}

/** Read once at load: switching looks changes `location.search`,
    which is a full page load, so this can't go stale. Pages use it to swap in
    markup the CSS layer can't produce on its own (empty states, header). */
export const BOUTIQUE = readLook() === 'boutique';

export function useBoutiqueLook() {
  const [look] = useState<Look>(() => (BOUTIQUE ? 'boutique' : 'classic'));
  useEffect(() => {
    if (look !== 'boutique') return;
    const html = document.documentElement;
    html.classList.add('look-boutique');
    // index.html already links Manrope under this id so it's fetched before
    // first paint; this is only the fallback if that tag is ever removed.
    if (!document.getElementById(FONT_ID)) {
      const link = document.createElement('link');
      link.id = FONT_ID;
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap';
      document.head.appendChild(link);
    }
    return () => html.classList.remove('look-boutique');
  }, [look]);
  return look === 'boutique';
}
