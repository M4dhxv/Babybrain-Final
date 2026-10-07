// Network helpers for the Supabase client.
//
// Ported from the parent app's lib/net.ts. The portal used a plain 15s abort
// with no second chance, so a vendor coming back after hours — handed a
// half-dead keep-alive socket — waited the full 15s on the token renewal that
// every other request queues behind, then again on the provider lookup, and the
// index.html watchdog's reload restarted the whole count. Reads are now hedged.

/** Access-token renewal. Replaying it is safe inside GoTrue's refresh-token
 *  reuse window (10s by default): a second use of the same token just returns the
 *  session the first one minted. Every authed request waits on a refresh in
 *  flight, so one stuck on a dead socket froze the whole portal. */
const TOKEN_REFRESH = /\/auth\/v1\/token\?grant_type=refresh_token/;

/** Safe to send twice: plain reads (PostgREST GET/HEAD) and token renewal.
 *  RPCs and every other write stay single-shot — a duplicate could change data. */
function isIdempotent(url: string, method: string): boolean {
  if (method === 'GET' || method === 'HEAD') return true;
  return method === 'POST' && TOKEN_REFRESH.test(url);
}

/** Hard ceiling for any single request — a wedged socket must not hang the UI forever. */
const CEILING_MS = 15_000;
/** How long a read may stay silent before a second copy is sent alongside it. */
const HEDGE_AFTER_MS = 3_000;

function send(input: RequestInfo | URL, init: RequestInit | undefined, ac: AbortController): Promise<Response> {
  const timer = setTimeout(() => ac.abort(), CEILING_MS);
  return fetch(input, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
}

/** Aborts `ac` when the caller's own signal aborts (the caller navigated away). */
function follow(caller: AbortSignal | null | undefined, ac: AbortController) {
  if (!caller) return;
  if (caller.aborted) ac.abort();
  else caller.addEventListener('abort', () => ac.abort(), { once: true });
}

/**
 * `fetch` that cannot hang the portal on a dead connection.
 *
 * Reads (and the token renewal) are *hedged*: if the first copy has been silent
 * for 3s, a second goes out on its own fresh connection and whichever answers
 * first wins; the loser is cancelled. A healthy request (well under 3s) never
 * sends a second copy. Writes and the other auth calls (sign-in, sign-up,
 * password changes) stay single-shot with the plain 15s ceiling.
 */
export const timeoutFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();

  const first = new AbortController();
  follow(init?.signal, first);

  if (!isIdempotent(url, method) || (url.includes('/auth/v1/') && !TOKEN_REFRESH.test(url))) return send(input, init, first);

  return new Promise<Response>((resolve, reject) => {
    const second = new AbortController();
    follow(init?.signal, second);
    let settled = false;
    let failures = 0;
    let sentSecond = false;

    const win = (res: Response, loser: AbortController) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedge);
      loser.abort();
      resolve(res);
    };
    const lose = (err: unknown) => {
      failures += 1;
      // Both copies failed (or the only one did and no hedge is coming).
      if (!settled && (failures >= 2 || (!sentSecond && init?.signal?.aborted))) {
        settled = true;
        clearTimeout(hedge);
        reject(err);
      } else if (!settled && !sentSecond) {
        // First copy failed outright (connection reset) — don't wait out the hedge timer.
        clearTimeout(hedge);
        fire();
      }
    };
    const fire = () => {
      if (settled || sentSecond) return;
      sentSecond = true;
      send(input, init, second).then((r) => win(r, first), lose);
    };
    const hedge = setTimeout(fire, HEDGE_AFTER_MS);
    send(input, init, first).then((r) => win(r, second), lose);
  });
};
