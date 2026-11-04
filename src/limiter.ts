/** Runs at most `concurrency` tasks at once and keeps at most `maxQueued` more waiting. */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueued: number,
  ) {}

  get queued(): number {
    return this.waiting.length;
  }

  /**
   * False when there is no room left: the caller should answer 503 instead of accepting more work.
   * `pending` counts work that was accepted but has not reached `run` yet (uploads still streaming in),
   * so many parallel uploads cannot all pass the check before any of them is queued.
   */
  canAccept(pending = 0): boolean {
    return this.active + this.waiting.length + pending < this.concurrency + this.maxQueued;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot straight to the next task
      else this.active--;
    }
  }
}
