/**
 * A deliberately minimal in-process circuit breaker.
 *
 * Not distributed, not persistent, no half-open probe storm control beyond a single trial
 * call. It exists so that when Jev is down, you stop paying 30 seconds of latency per
 * request to rediscover that fact. If you need more than this, you need a real resilience
 * library, and this file is the wrong place to grow one.
 */
export interface BreakerOptions {
  /** Consecutive transient failures before opening. */
  readonly threshold: number;
  /** How long to stay open before allowing one trial call. */
  readonly resetMs: number;
}

export class CircuitBreaker {
  #failures = 0;
  #openedAt: number | null = null;
  readonly #opts: BreakerOptions;

  constructor(opts: Partial<BreakerOptions> = {}) {
    this.#opts = { threshold: opts.threshold ?? 5, resetMs: opts.resetMs ?? 30_000 };
  }

  get isOpen(): boolean {
    if (this.#openedAt === null) return false;
    if (Date.now() - this.#openedAt >= this.#opts.resetMs) {
      // Half-open: let exactly one call through to test the water.
      this.#openedAt = null;
      this.#failures = this.#opts.threshold - 1;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#openedAt = null;
  }

  recordFailure(): void {
    this.#failures += 1;
    if (this.#failures >= this.#opts.threshold) this.#openedAt = Date.now();
  }
}
