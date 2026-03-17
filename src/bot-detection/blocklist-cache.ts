interface CacheEntry {
  blocked: boolean;
  expiresAt: number;
}

const DEFAULT_MAX_SIZE = 1000;

export class BlocklistCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxSize: number;

  constructor(ttlMs: number, maxSize: number = DEFAULT_MAX_SIZE) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  /** Returns true/false if cached and valid, null if cache miss or expired. */
  get(ip: string): boolean | null {
    const entry = this.cache.get(ip);
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.cache.delete(ip);
      return null;
    }
    return entry.blocked;
  }

  set(ip: string, blocked: boolean): void {
    // Evict oldest entry (FIFO) if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(ip)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(ip, { blocked, expiresAt: Date.now() + this.ttlMs });
  }
}
