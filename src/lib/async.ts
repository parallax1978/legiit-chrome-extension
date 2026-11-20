/** Small concurrency helpers. No timers are left running after an abort. */

export class AbortError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs `fn` over `items` with at most `limit` running at once. Results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** A signal that aborts after `ms`, or when `parent` aborts. Call `clear` when done. */
export function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}
