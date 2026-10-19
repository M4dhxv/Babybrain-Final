/**
 * "Did you mean …@gmail.com?" for a mistyped email DOMAIN on the sign-in and
 * forgot-password pages. Runs entirely in the browser against a fixed list of
 * common mail providers, so it reveals nothing about which accounts exist —
 * the part before the @ is never touched.
 */
const DOMAINS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.com.sg', 'hotmail.com', 'hotmail.sg',
  'outlook.com', 'outlook.sg', 'live.com', 'icloud.com', 'me.com', 'singnet.com.sg', 'starhub.net.sg',
  // Real providers one letter away from the above — listed so they're never "corrected".
  'mail.com', 'ymail.com', 'msn.com', 'aol.com', 'gmx.com',
];

/** Edit distance where swapping two neighbouring letters ("gmial") counts as
 *  one edit, not two. Strings here are short domains, so a full table is fine. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** The corrected email, or null when the domain looks right (or is unfamiliar). */
export function suggestEmail(email: string): string | null {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!domain || DOMAINS.includes(domain)) return null;
  let best: string | null = null;
  let bestD = 3;
  for (const d of DOMAINS) {
    const dist = distance(domain, d);
    if (dist < bestD) { best = d; bestD = dist; }
  }
  // Two edits only on longer domains: "abc.com" is two edits from "aol.com"
  // and is somebody's real business.
  const allowed = domain.length >= 9 ? 2 : 1;
  return best && bestD <= allowed ? `${local}@${best}` : null;
}
