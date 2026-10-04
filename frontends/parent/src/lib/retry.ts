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
  { attempts = 2, timeoutMs = 8000, budgetMs = 10_000, signal }: RetryOptions = {},
): Promise<T> {
  const start = Date.now();
  let last = { error: new Error("not run") } as T;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return { error: new DOMException("Aborted", "AbortError") } as T;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    try {
      last = await run(ctl.signal);
      if (!last.error) return last;
    } catch (e) {
      last = { error: e } as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (timedOut) last = { ...last, error: Object.assign(new Error(`no answer within ${timeoutMs / 1000}s`), { name: "TimeoutError" }) };
    // A request that timed out is not retried: the database is already too busy
    // to answer, and a second copy of the same query only adds to the pile.
    // Fast failures (a 5xx, a dropped connection) are worth one more try.
    if (timedOut || signal?.aborted || Date.now() - start >= budgetMs) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700 * 2 ** i * (0.5 + Math.random())));
  }
  return last;
}

export const isTimeout = (e: unknown) => (e as { name?: string } | null)?.name === "TimeoutError";

/** `withRetry`, plus one more try after a short cool-down when the failure was
 *  fast (a 502, a dropped connection) rather than a timeout. An overloaded
 *  database often recovers within seconds; retrying instantly just joins the
 *  queue, retrying after a pause usually lands. A timeout is not retried again:
 *  waiting longer on a database that already said nothing helps nobody. */
export async function withCooldown<T extends { error: unknown }>(
  run: (signal: AbortSignal) => PromiseLike<T>,
  opts: RetryOptions & { cooldownMs?: number } = {},
): Promise<T> {
  const first = await withRetry(run, opts);
  const { signal, cooldownMs = 3000 } = opts;
  if (!first.error || signal?.aborted || isTimeout(first.error)) return first;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, cooldownMs);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
  if (signal?.aborted) return first;
  return withRetry(run, opts);
}
