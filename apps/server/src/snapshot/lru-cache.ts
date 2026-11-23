/** A small least-recently-used map. Analysis results are keyed by commit SHAs, so they never go stale. */
export class LruCache<TValue> {
  readonly #max: number;
  readonly #map = new Map<string, TValue>();

  constructor(max: number) {
    this.#max = max;
  }

  get(key: string): TValue | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: string, value: TValue): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next();
      if (oldest.done === true) break;
      this.#map.delete(oldest.value);
    }
  }
}
