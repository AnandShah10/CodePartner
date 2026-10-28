/**
 * Per-path write serialization inside the extension host.
 * Complements toolScheduler (turn-level) for overlapping async writers.
 */

const locks = new Map<string, Promise<void>>();

function norm(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/**
 * Run `fn` exclusively for `pathKey` (other writers to the same key wait).
 */
export async function withFileWriteLock<T>(
  pathKey: string,
  fn: () => Promise<T> | T
): Promise<T> {
  const key = norm(pathKey || "");
  const prev = locks.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => gate);
  locks.set(
    key,
    tail.catch(() => undefined).then(() => undefined)
  );
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) {
      // leave resolved promise so awaiters chain; prune later
    }
  }
}
