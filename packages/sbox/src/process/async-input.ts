/**
 * Own and close caller-provided async iterables so session cleanup never hangs
 * on a pending `next()` or a hanging `return()`.
 */

/** Sentinel when settlement wins a race against iterator.next(). */
export const INPUT_SETTLED = Symbol("sbox.inputSettled");

export type InputRaceResult<T> = IteratorResult<T> | typeof INPUT_SETTLED;

/**
 * Race an iterator step against an already-resolved or pending settlement.
 * A pending `next()` is abandoned on settlement; callers must still invoke
 * `closeAsyncIterator` so `return()` is started when available.
 */
export async function nextOrSettled<T>(
  nextPromise: Promise<IteratorResult<T>>,
  whenSettled: Promise<void>,
  isSettled: () => boolean,
): Promise<InputRaceResult<T>> {
  if (isSettled()) {
    return INPUT_SETTLED;
  }
  const settled = whenSettled.then((): typeof INPUT_SETTLED => INPUT_SETTLED);
  // Abandon the losing branch; do not cancel the underlying next() Promise
  // (not generally possible). Settlement must not await it.
  return await Promise.race([nextPromise, settled]);
}

/**
 * Best-effort close. Starts `return()` when available but never awaits it —
 * a caller iterator must not be able to block native handle/transport cleanup.
 * Late rejections are observed so they do not become unhandled.
 */
export function closeAsyncIterator(iterator: AsyncIterator<unknown>): void {
  if (typeof iterator.return !== "function") {
    return;
  }
  try {
    const result = iterator.return();
    if (
      result !== undefined &&
      result !== null &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      observeDetached(Promise.resolve(result));
    }
  } catch {
    // Synchronous return() failures must not block native cleanup.
  }
}

/**
 * Observe a fire-and-forget task without letting rejections become unhandled.
 */
export function observeDetached(task: Promise<unknown>): void {
  void task.then(
    () => undefined,
    () => undefined,
  );
}
