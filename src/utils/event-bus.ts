/**
 * Typed event emitter for APEX inter-system communication.
 */

/** Well-known APEX event names. */
export type ApexEventType =
  | 'episode:recorded'
  | 'memory:consolidated'
  | 'memory:bounds-warning'
  | 'memory:bounds-eviction'
  | 'skill:learned'
  | 'skill:promoted'
  | 'snapshot:created';

type Handler = (...args: unknown[]) => void;

export class EventBus {
  private listeners = new Map<string, Set<Handler>>();

  /**
   * Register a handler for an event.
   */
  on(event: ApexEventType | string, handler: Handler): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  /**
   * Remove a handler for an event.
   */
  off(event: ApexEventType | string, handler: Handler): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Emit an event, calling all registered handlers synchronously.
   */
  emit(event: ApexEventType | string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const handler of set) {
        handler(...args);
      }
    }
  }

  /**
   * Register a one-time handler that auto-removes after first invocation.
   */
  once(event: ApexEventType | string, handler: Handler): void {
    const wrapper: Handler = (...args: unknown[]) => {
      this.off(event, wrapper);
      handler(...args);
    };
    this.on(event, wrapper);
  }
}
