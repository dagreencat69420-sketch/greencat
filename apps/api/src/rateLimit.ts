/** Minimal in-memory fixed-window limiter (per process). Use a shared store if you scale out. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private now: () => number = Date.now) {}

  /** @returns ms to wait if limited, else 0 */
  take(key: string, limit: number, windowMs: number): number {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || e.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + windowMs });
      if (this.hits.size > 50_000) this.sweep(t);
      return 0;
    }
    if (e.count >= limit) return e.resetAt - t;
    e.count += 1;
    return 0;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
