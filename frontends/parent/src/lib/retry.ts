/** Supabase calls resolve with `{ data, error }` instead of throwing, so a
 *  timeout or 5xx used to read as "no rows". This retries those with a short
 *  backoff and hands back the final result, error included, for the caller to
 *  surface — never cache a result whose `error` is set.
 *
 *  Every attempt gets its own AbortSignal and a hard deadline, so a request
 *  that hangs (rather than fails) is cut off and retried instead of leaving a
 *  spinner running forever. `signal` cancels everything at once (the caller
 *  moved on to a different query). */
export interface RetryOptions {
  attempts?: number;
  /** Per-attempt deadline. */
  timeoutMs?: number;
  /** Stop starting new attempts once this much time has passed overall, so a
   *  hung backend ends in an error within ~budget + timeoutMs, not attempts x timeout. */
  budgetMs?: number;
  signal?: AbortSignal;
}

export async function withRetry<T extends { error: unknown }>(
  run: (signal: AbortSignal) => PromiseLike<T>,
  { attempts = 3, timeoutMs = 5000, budgetMs = 10_000, signal }: RetryOptions = {},
): Promise<T> {
  const start = Date.now();
  let last = { error: new Error("not run") } as T;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return { error: new DOMException("Aborted", "AbortError") } as T;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      last = await run(ctl.signal);
      if (!last.error) return last;
    } catch (e) {
      last = { error: e } as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted || Date.now() - start >= budgetMs) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * 2 ** i * (0.5 + Math.random())));
  }
  return last;
}
