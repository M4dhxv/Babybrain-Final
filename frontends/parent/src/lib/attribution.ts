/**
 * Remembers where a visitor first came from, so Admin -> Parents can show a
 * "Signup source" for each parent.
 *
 * On each page load (until a real source is known) it reads the campaign link
 * parameters (utm_source, utm_medium, utm_campaign, or ref) and, failing that,
 * the referring site. The first non-direct touch is kept; a visit with no
 * campaign and no referrer is recorded as "direct" only until something better
 * turns up. It is sent with the sign-up (see AuthProvider.signUp) and never
 * affects the page. Everything is best effort: blocked storage just means no
 * source is recorded.
 */
const KEY = "bb:first-touch";

export interface Attribution {
  source: string;
  medium?: string;
  campaign?: string;
  referrer?: string;
}

const clean = (v: string | null | undefined, max = 80) => (v ?? "").trim().slice(0, max);

function read(): Attribution | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Attribution) : null;
  } catch {
    return null;
  }
}

export function captureAttribution(): void {
  try {
    const existing = read();
    if (existing && existing.source !== "direct") return;

    const q = new URLSearchParams(window.location.search);
    let refHost = "";
    try {
      const r = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, "") : "";
      if (r && r !== window.location.hostname.replace(/^www\./, "")) refHost = r;
    } catch { /* malformed referrer */ }

    const source = clean(q.get("utm_source") || q.get("ref") || q.get("source") || refHost).toLowerCase();
    if (!source) {
      if (!existing) localStorage.setItem(KEY, JSON.stringify({ source: "direct" } satisfies Attribution));
      return;
    }
    const a: Attribution = {
      source,
      medium: clean(q.get("utm_medium")).toLowerCase() || undefined,
      campaign: clean(q.get("utm_campaign"), 120) || undefined,
      referrer: refHost || undefined,
    };
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* storage blocked */
  }
}

/** What to send with a sign-up, or undefined when nothing is known. */
export function getAttribution(): Attribution | undefined {
  return read() ?? undefined;
}
