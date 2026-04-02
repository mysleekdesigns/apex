/**
 * Hashing utilities for APEX deduplication and fast lookups.
 */

/**
 * FNV-1a 32-bit hash.
 */
export function fnv1aHash(data: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    // Multiply by FNV prime 0x01000193, keeping within 32 bits
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Content hash for deduplication. Returns an 8-character hex string
 * derived from FNV-1a of the normalized content.
 */
export function contentHash(content: string): string {
  const normalized = content.trim().replace(/\s+/g, ' ');
  const hash = fnv1aHash(normalized);
  return hash.toString(16).padStart(8, '0');
}
