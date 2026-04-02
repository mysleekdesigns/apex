/**
 * Fixed-capacity ring buffer with O(1) push and eviction.
 */

export class RingBuffer<T> {
  private readonly buffer: (T | undefined)[];
  private readonly _capacity: number;
  private head: number = 0;
  private _length: number = 0;

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error('RingBuffer capacity must be at least 1');
    }
    this._capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /**
   * Push an item into the buffer.
   * Returns the evicted item if the buffer was full, otherwise undefined.
   */
  push(item: T): T | undefined {
    let evicted: T | undefined;

    if (this._length === this._capacity) {
      // Buffer is full: the slot at head is the oldest item
      evicted = this.buffer[this.head];
    }

    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this._capacity;

    if (this._length < this._capacity) {
      this._length++;
    }

    return evicted;
  }

  /**
   * Get item at logical index (0 = oldest, length-1 = newest).
   */
  get(index: number): T {
    if (index < 0 || index >= this._length) {
      throw new RangeError(`Index ${index} out of bounds [0, ${this._length})`);
    }
    // The oldest item starts at (head - length) mod capacity
    const start = (this.head - this._length + this._capacity) % this._capacity;
    const actual = (start + index) % this._capacity;
    return this.buffer[actual] as T;
  }

  /**
   * Return all items as an array, oldest first.
   */
  toArray(): T[] {
    const result: T[] = [];
    const start = (this.head - this._length + this._capacity) % this._capacity;
    for (let i = 0; i < this._length; i++) {
      result.push(this.buffer[(start + i) % this._capacity] as T);
    }
    return result;
  }

  /** Number of items currently in the buffer. */
  get length(): number {
    return this._length;
  }

  /** Whether the buffer is at full capacity. */
  get isFull(): boolean {
    return this._length === this._capacity;
  }

  /** Remove all items from the buffer. */
  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this._length = 0;
  }
}
