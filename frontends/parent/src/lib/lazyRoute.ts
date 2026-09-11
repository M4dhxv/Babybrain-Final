import { lazy, type ComponentType } from "react";
import { isChunkLoadError } from "../components/RouteErrorBoundary";

// A stalled chunk request never rejects, so without a deadline a hung chunk
// leaves the route loader spinning forever instead of recovering.
const DEADLINE_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

function chunkError(name: string, cause: unknown): Error {
  const err = new Error(`Failed to fetch dynamically imported module: ${name}`);
  err.name = "ChunkLoadError";
  (err as Error & { cause?: unknown }).cause = cause;
  return err;
}

function withDeadline<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(chunkError(name, `timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Retries network-shaped failures with jittered backoff under one overall deadline,
 *  then rejects with a ChunkLoadError for RouteErrorBoundary's rate-limited reload.
 *  A module that downloads but throws while evaluating is a real bug and is not retried. */
export async function loadChunk<T>(load: () => Promise<T>, name: string): Promise<T> {
  const deadline = Date.now() + DEADLINE_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await withDeadline(load(), remaining, name);
    } catch (error) {
      if (!isChunkLoadError(error)) throw error;
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      // Jitter keeps many tabs from retrying in lockstep after a deploy or a network blip.
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
      const wait = Math.min(backoff, deadline - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw chunkError(name, lastError);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyRoute<T extends ComponentType<any>>(load: () => Promise<{ default: T }>, name: string) {
  return lazy(() => loadChunk(load, name));
}
