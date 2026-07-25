/**
 * Bounded async queue with producer backpressure.
 *
 * Producers await `push` while the queue is at capacity. Closing unblocks both
 * producers and consumers so cancellation/disposal never hangs on capacity.
 */

export class BoundedAsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly capacity: number;
  private closed = false;
  private closeError: Error | null = null;
  private pushWaiters: Array<() => void> = [];
  private shiftWaiters: Array<() => void> = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("BoundedAsyncQueue capacity must be a positive integer.");
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.items.length;
  }

  get maxSize(): number {
    return this.capacity;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Enqueue an item, waiting while full. Returns `"closed"` if the queue was
   * closed before the item could be accepted (item is dropped).
   */
  async push(item: T): Promise<"ok" | "closed"> {
    while (this.items.length >= this.capacity && !this.closed) {
      await new Promise<void>((resolve) => {
        this.pushWaiters.push(resolve);
      });
    }
    if (this.closed) {
      return "closed";
    }
    this.items.push(item);
    this.wakeShift();
    return "ok";
  }

  /**
   * Dequeue the next item, waiting while empty. After close, drains remaining
   * items then returns `{ kind: "end" }`.
   */
  async shift(): Promise<
    | { readonly kind: "value"; readonly value: T }
    | { readonly kind: "end"; readonly error: Error | null }
  > {
    while (this.items.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => {
        this.shiftWaiters.push(resolve);
      });
    }
    const item = this.items.shift();
    if (item !== undefined) {
      this.wakePush();
      return { kind: "value", value: item };
    }
    return { kind: "end", error: this.closeError };
  }

  /** Close the queue and wake all waiters. Idempotent. */
  close(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error ?? null;
    this.wakePush();
    this.wakeShift();
  }

  private wakePush(): void {
    for (const wake of this.pushWaiters.splice(0)) {
      wake();
    }
  }

  private wakeShift(): void {
    for (const wake of this.shiftWaiters.splice(0)) {
      wake();
    }
  }
}

/** Default streaming event/output queue capacity (chunks/events). */
export const DEFAULT_STREAM_QUEUE_CAPACITY = 64;
