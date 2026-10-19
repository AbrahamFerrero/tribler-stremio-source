interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class TimedCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}
