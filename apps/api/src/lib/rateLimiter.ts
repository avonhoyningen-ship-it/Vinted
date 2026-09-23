/**
 * Serialises calls per key and enforces a minimum gap (plus random jitter)
 * between them. Used to keep request volume to Vinted low and polite.
 */
export class RateLimiter {
  private chains = new Map<string, Promise<unknown>>();
  private lastRun = new Map<string, number>();

  constructor(
    private minGapMs: number,
    private jitterMs = Math.round(minGapMs * 0.25),
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  schedule<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const last = this.lastRun.get(key) ?? 0;
        const gap = this.minGapMs + Math.random() * this.jitterMs;
        const wait = last + gap - Date.now();
        if (last > 0 && wait > 0) await this.sleep(wait);
        try {
          return await fn();
        } finally {
          this.lastRun.set(key, Date.now());
        }
      });
    this.chains.set(key, next);
    return next;
  }
}
