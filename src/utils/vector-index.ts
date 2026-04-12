/**
 * HNSW (Hierarchical Navigable Small World) vector index.
 *
 * A from-scratch implementation of the HNSW algorithm for approximate
 * nearest neighbor search. Supports cosine, euclidean, and dot product
 * distance functions with configurable construction and search parameters.
 *
 * Reference: Malkov & Yashunin, "Efficient and robust approximate nearest
 * neighbor search using Hierarchical Navigable Small World graphs" (2016).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the HNSW index. */
export interface HNSWConfig {
  /** Max bi-directional connections per node (default 16). */
  M?: number;
  /** Exploration factor used during construction (default 200). */
  efConstruction?: number;
  /** Exploration factor used during search (default 50). */
  ef?: number;
  /** Distance metric (default 'cosine'). */
  distanceFunction?: 'cosine' | 'euclidean' | 'dotProduct';
}

/** A single search result with the matched id and its distance to the query. */
export interface SearchResult {
  id: string;
  distance: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Min-heap priority queue keyed by a numeric priority. */
class MinHeap<T> {
  private heap: Array<{ priority: number; value: T }> = [];

  get length(): number {
    return this.heap.length;
  }

  peek(): { priority: number; value: T } | undefined {
    return this.heap[0];
  }

  push(priority: number, value: T): void {
    this.heap.push({ priority, value });
    this._bubbleUp(this.heap.length - 1);
  }

  pop(): { priority: number; value: T } | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  toArray(): Array<{ priority: number; value: T }> {
    return [...this.heap];
  }

  private _bubbleUp(idx: number): void {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.heap[parent].priority <= this.heap[idx].priority) break;
      [this.heap[parent], this.heap[idx]] = [this.heap[idx], this.heap[parent]];
      idx = parent;
    }
  }

  private _sinkDown(idx: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < n && this.heap[left].priority < this.heap[smallest].priority) {
        smallest = left;
      }
      if (right < n && this.heap[right].priority < this.heap[smallest].priority) {
        smallest = right;
      }
      if (smallest === idx) break;
      [this.heap[smallest], this.heap[idx]] = [this.heap[idx], this.heap[smallest]];
      idx = smallest;
    }
  }
}

/** Max-heap built on top of MinHeap by negating priorities. */
class MaxHeap<T> {
  private inner = new MinHeap<T>();

  get length(): number {
    return this.inner.length;
  }

  peek(): { priority: number; value: T } | undefined {
    const top = this.inner.peek();
    return top ? { priority: -top.priority, value: top.value } : undefined;
  }

  push(priority: number, value: T): void {
    this.inner.push(-priority, value);
  }

  pop(): { priority: number; value: T } | undefined {
    const item = this.inner.pop();
    return item ? { priority: -item.priority, value: item.value } : undefined;
  }

  toArray(): Array<{ priority: number; value: T }> {
    return this.inner.toArray().map((e) => ({ priority: -e.priority, value: e.value }));
  }
}

// ---------------------------------------------------------------------------
// Distance functions
// ---------------------------------------------------------------------------

type DistanceFn = (a: number[], b: number[]) => number;

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function dotProductDistance(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return -dot;
}

function getDistanceFunction(name: string): DistanceFn {
  switch (name) {
    case 'euclidean':
      return euclideanDistance;
    case 'dotProduct':
      return dotProductDistance;
    case 'cosine':
    default:
      return cosineDistance;
  }
}

// ---------------------------------------------------------------------------
// HNSW Node
// ---------------------------------------------------------------------------

interface HNSWNode {
  id: string;
  vector: number[];
  level: number;
  /** Neighbors per layer. neighbors[layer] = Set of node indices. */
  neighbors: Array<Set<number>>;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Serialization constants
// ---------------------------------------------------------------------------

const MAGIC = 0x484e5357; // 'HNSW'
const VERSION = 1;

// ---------------------------------------------------------------------------
// HNSWIndex
// ---------------------------------------------------------------------------

/**
 * Hierarchical Navigable Small World index for approximate nearest neighbor search.
 *
 * @example
 * ```ts
 * const index = new HNSWIndex(128); // 128-dimensional vectors
 * index.insert('doc-1', vector1);
 * index.insert('doc-2', vector2);
 * const results = index.search(queryVector, 5);
 * ```
 */
export class HNSWIndex {
  private readonly dimensions: number;
  private readonly M: number;
  private readonly Mmax0: number;
  private readonly efConstruction: number;
  private efSearch: number;
  private readonly mL: number;
  private readonly distanceFnName: 'cosine' | 'euclidean' | 'dotProduct';
  private readonly distanceFn: DistanceFn;

  private nodes: HNSWNode[] = [];
  private idToIndex: Map<string, number> = new Map();
  private entryPointIndex: number = -1;
  private maxLevel: number = -1;
  private activeCount: number = 0;

  /**
   * Create a new HNSW index.
   *
   * @param dimensions - Dimensionality of vectors stored in this index.
   * @param config - Optional algorithm parameters.
   */
  constructor(dimensions: number, config?: HNSWConfig) {
    if (dimensions <= 0 || !Number.isInteger(dimensions)) {
      throw new Error(`dimensions must be a positive integer, got ${dimensions}`);
    }

    this.dimensions = dimensions;
    this.M = config?.M ?? 16;
    this.Mmax0 = this.M * 2;
    this.efConstruction = config?.efConstruction ?? 200;
    this.efSearch = config?.ef ?? 50;
    this.mL = 1 / Math.log(this.M);
    this.distanceFnName = config?.distanceFunction ?? 'cosine';
    this.distanceFn = getDistanceFunction(this.distanceFnName);
  }

  // -----------------------------------------------------------------------
  // Public API — info
  // -----------------------------------------------------------------------

  /** Number of non-deleted entries in the index. */
  get size(): number {
    return this.activeCount;
  }

  /** Check whether an id exists (and is not deleted) in the index. */
  has(id: string): boolean {
    const idx = this.idToIndex.get(id);
    if (idx === undefined) return false;
    return !this.nodes[idx].deleted;
  }

  /** Return the dimensionality of vectors in this index. */
  getDimensions(): number {
    return this.dimensions;
  }

  // -----------------------------------------------------------------------
  // Public API — core operations
  // -----------------------------------------------------------------------

  /**
   * Insert a vector with the given id into the index.
   *
   * @param id - Unique identifier for this vector.
   * @param vector - The vector to insert. Must match the index dimensions.
   * @throws If the vector length does not match the configured dimensions.
   */
  insert(id: string, vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
      );
    }

    // If the id already exists, delete the old entry first.
    if (this.idToIndex.has(id)) {
      this.delete(id);
    }

    const level = this._randomLevel();
    const nodeIndex = this.nodes.length;
    const neighbors: Array<Set<number>> = [];
    for (let i = 0; i <= level; i++) {
      neighbors.push(new Set());
    }

    const node: HNSWNode = { id, vector, level, neighbors, deleted: false };
    this.nodes.push(node);
    this.idToIndex.set(id, nodeIndex);
    this.activeCount++;

    // First node — set as entry point and return.
    if (this.activeCount === 1 || this.entryPointIndex === -1) {
      this.entryPointIndex = nodeIndex;
      this.maxLevel = level;
      return;
    }

    let currentNode = this.entryPointIndex;
    let currentDist = this.distanceFn(vector, this.nodes[currentNode].vector);

    // Phase 1: Traverse from top layer down to level+1 using greedy search.
    for (let lc = this.maxLevel; lc > level; lc--) {
      const changed = this._greedyClosest(vector, currentNode, lc);
      currentNode = changed.index;
      currentDist = changed.distance;
    }

    // Phase 2: For each layer from min(level, maxLevel) down to 0, find and connect neighbors.
    for (let lc = Math.min(level, this.maxLevel); lc >= 0; lc--) {
      const candidates = this._searchLayer(vector, currentNode, this.efConstruction, lc);
      const maxM = lc === 0 ? this.Mmax0 : this.M;
      const selected = this._selectNeighborsHeuristic(vector, candidates, maxM, lc);

      // Connect new node to selected neighbors.
      for (const { index: neighborIdx } of selected) {
        node.neighbors[lc].add(neighborIdx);
        const neighborNode = this.nodes[neighborIdx];

        // Ensure neighbor has enough layer arrays (should already, but be safe).
        if (lc < neighborNode.neighbors.length) {
          neighborNode.neighbors[lc].add(nodeIndex);

          // Shrink neighbor connections if over limit.
          if (neighborNode.neighbors[lc].size > maxM) {
            this._shrinkNeighbors(neighborIdx, lc, maxM);
          }
        }
      }

      // Update current node for next layer down.
      if (selected.length > 0) {
        currentNode = selected[0].index;
        currentDist = selected[0].distance;
      }
    }

    // Update entry point if new node has a higher level.
    if (level > this.maxLevel) {
      this.entryPointIndex = nodeIndex;
      this.maxLevel = level;
    }
  }

  /**
   * Search for the k nearest neighbors of the query vector.
   *
   * @param query - The query vector. Must match index dimensions.
   * @param k - Number of nearest neighbors to return.
   * @param ef - Optional search exploration factor (overrides the default).
   * @returns An array of search results sorted by distance (ascending).
   */
  search(query: number[], k: number, ef?: number): SearchResult[] {
    if (query.length !== this.dimensions) {
      throw new Error(
        `Query dimension mismatch: expected ${this.dimensions}, got ${query.length}`,
      );
    }
    if (this.activeCount === 0 || this.entryPointIndex === -1) {
      return [];
    }

    const efLocal = Math.max(ef ?? this.efSearch, k);
    let currentNode = this.entryPointIndex;

    // Traverse from top layer down to layer 1 with greedy search.
    for (let lc = this.maxLevel; lc > 0; lc--) {
      const closest = this._greedyClosest(query, currentNode, lc);
      currentNode = closest.index;
    }

    // Search layer 0 with ef exploration factor.
    const candidates = this._searchLayer(query, currentNode, efLocal, 0);

    // Filter deleted, sort, and return top k.
    const results: SearchResult[] = [];
    for (const c of candidates) {
      if (!this.nodes[c.index].deleted) {
        results.push({ id: this.nodes[c.index].id, distance: c.distance });
      }
    }
    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, k);
  }

  /**
   * Mark a node as deleted (lazy deletion). The node is excluded from future
   * search results but its connections remain for graph traversal.
   *
   * @param id - The id of the node to delete.
   * @returns `true` if the node existed and was deleted, `false` otherwise.
   */
  delete(id: string): boolean {
    const idx = this.idToIndex.get(id);
    if (idx === undefined) return false;
    const node = this.nodes[idx];
    if (node.deleted) return false;

    node.deleted = true;
    this.activeCount--;

    // If we deleted the entry point, find a new one.
    if (idx === this.entryPointIndex) {
      this._updateEntryPoint();
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // Public API — bulk operations
  // -----------------------------------------------------------------------

  /**
   * Insert multiple vectors in batch.
   *
   * @param items - Array of `{ id, vector }` pairs to insert.
   */
  insertBatch(items: Array<{ id: string; vector: number[] }>): void {
    for (const item of items) {
      this.insert(item.id, item.vector);
    }
  }

  // -----------------------------------------------------------------------
  // Public API — persistence
  // -----------------------------------------------------------------------

  /**
   * Serialize the index to a compact binary format.
   *
   * The format uses DataView for cross-platform compatibility:
   * - Header: magic (u32), version (u32), dimensions (u32), node count (u32),
   *   M (u16), Mmax0 (u16), efConstruction (u16), efSearch (u16),
   *   distanceFn name length (u8), distanceFn name (utf8),
   *   entryPointIndex (i32), maxLevel (i32)
   * - Per node: id length (u32), id (utf8), deleted (u8), level (u16),
   *   vector (float32[dimensions]),
   *   per layer: neighbor count (u16), neighbor indices (u32 each)
   */
  serialize(): Uint8Array {
    // Calculate total size needed.
    const encoder = new TextEncoder();
    const distNameBytes = encoder.encode(this.distanceFnName);

    // Header: magic(4) + version(4) + dims(4) + nodeCount(4)
    //       + M(2) + Mmax0(2) + efC(2) + efS(2)
    //       + distNameLen(1) + distName(var)
    //       + entryPoint(4) + maxLevel(4)
    let totalSize = 4 + 4 + 4 + 4 + 2 + 2 + 2 + 2 + 1 + distNameBytes.length + 4 + 4;

    for (const node of this.nodes) {
      const idBytes = encoder.encode(node.id);
      // idLen(4) + id(var) + deleted(1) + level(2) + vector(dims*4)
      totalSize += 4 + idBytes.length + 1 + 2 + this.dimensions * 4;
      // Per layer: neighborCount(2) + neighbors(count * 4)
      for (let l = 0; l <= node.level; l++) {
        totalSize += 2 + node.neighbors[l].size * 4;
      }
    }

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let offset = 0;

    // Write header
    view.setUint32(offset, MAGIC, true); offset += 4;
    view.setUint32(offset, VERSION, true); offset += 4;
    view.setUint32(offset, this.dimensions, true); offset += 4;
    view.setUint32(offset, this.nodes.length, true); offset += 4;
    view.setUint16(offset, this.M, true); offset += 2;
    view.setUint16(offset, this.Mmax0, true); offset += 2;
    view.setUint16(offset, this.efConstruction, true); offset += 2;
    view.setUint16(offset, this.efSearch, true); offset += 2;
    view.setUint8(offset, distNameBytes.length); offset += 1;
    bytes.set(distNameBytes, offset); offset += distNameBytes.length;
    view.setInt32(offset, this.entryPointIndex, true); offset += 4;
    view.setInt32(offset, this.maxLevel, true); offset += 4;

    // Write nodes
    for (const node of this.nodes) {
      const idBytes = encoder.encode(node.id);
      view.setUint32(offset, idBytes.length, true); offset += 4;
      bytes.set(idBytes, offset); offset += idBytes.length;
      view.setUint8(offset, node.deleted ? 1 : 0); offset += 1;
      view.setUint16(offset, node.level, true); offset += 2;

      // Vector
      for (let i = 0; i < this.dimensions; i++) {
        view.setFloat32(offset, node.vector[i], true); offset += 4;
      }

      // Neighbor lists per layer
      for (let l = 0; l <= node.level; l++) {
        const neighbors = node.neighbors[l];
        view.setUint16(offset, neighbors.size, true); offset += 2;
        for (const n of neighbors) {
          view.setUint32(offset, n, true); offset += 4;
        }
      }
    }

    return new Uint8Array(buffer);
  }

  /**
   * Deserialize an HNSW index from binary data previously produced by {@link serialize}.
   *
   * @param data - The binary data to deserialize.
   * @returns A fully reconstructed HNSWIndex.
   */
  static deserialize(data: Buffer | Uint8Array): HNSWIndex {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    let offset = 0;

    // Header
    const magic = view.getUint32(offset, true); offset += 4;
    if (magic !== MAGIC) {
      throw new Error(`Invalid HNSW data: bad magic number 0x${magic.toString(16)}`);
    }
    const version = view.getUint32(offset, true); offset += 4;
    if (version !== VERSION) {
      throw new Error(`Unsupported HNSW version: ${version}`);
    }

    const dimensions = view.getUint32(offset, true); offset += 4;
    const nodeCount = view.getUint32(offset, true); offset += 4;
    const M = view.getUint16(offset, true); offset += 2;
    const Mmax0 = view.getUint16(offset, true); offset += 2;
    const efConstruction = view.getUint16(offset, true); offset += 2;
    const efSearch = view.getUint16(offset, true); offset += 2;

    const distNameLen = view.getUint8(offset); offset += 1;
    const distanceFnName = decoder.decode(bytes.subarray(offset, offset + distNameLen)) as
      'cosine' | 'euclidean' | 'dotProduct';
    offset += distNameLen;

    const entryPointIndex = view.getInt32(offset, true); offset += 4;
    const maxLevel = view.getInt32(offset, true); offset += 4;

    const index = new HNSWIndex(dimensions, {
      M,
      efConstruction,
      ef: efSearch,
      distanceFunction: distanceFnName,
    });

    // Restore internal state directly.
    index.entryPointIndex = entryPointIndex;
    index.maxLevel = maxLevel;

    // Read nodes
    for (let n = 0; n < nodeCount; n++) {
      const idLen = view.getUint32(offset, true); offset += 4;
      const id = decoder.decode(bytes.subarray(offset, offset + idLen));
      offset += idLen;
      const deleted = view.getUint8(offset) === 1; offset += 1;
      const level = view.getUint16(offset, true); offset += 2;

      // Vector
      const vector: number[] = new Array(dimensions);
      for (let i = 0; i < dimensions; i++) {
        vector[i] = view.getFloat32(offset, true); offset += 4;
      }

      // Neighbors
      const neighbors: Array<Set<number>> = [];
      for (let l = 0; l <= level; l++) {
        const count = view.getUint16(offset, true); offset += 2;
        const set = new Set<number>();
        for (let j = 0; j < count; j++) {
          set.add(view.getUint32(offset, true)); offset += 4;
        }
        neighbors.push(set);
      }

      const node: HNSWNode = { id, vector, level, neighbors, deleted };
      index.nodes.push(node);
      index.idToIndex.set(id, index.nodes.length - 1);
      if (!deleted) {
        index.activeCount++;
      }
    }

    return index;
  }

  // -----------------------------------------------------------------------
  // Private — HNSW algorithm internals
  // -----------------------------------------------------------------------

  /** Assign a random level for a new node using exponential decay. */
  private _randomLevel(): number {
    return Math.floor(-Math.log(Math.random()) * this.mL);
  }

  /**
   * Greedy search within a single layer starting from `startIndex`,
   * moving to the closest neighbor until no improvement is found.
   */
  private _greedyClosest(
    query: number[],
    startIndex: number,
    layer: number,
  ): { index: number; distance: number } {
    let currentIndex = startIndex;
    let currentDist = this.distanceFn(query, this.nodes[currentIndex].vector);

    let improved = true;
    while (improved) {
      improved = false;
      const node = this.nodes[currentIndex];
      if (layer >= node.neighbors.length) break;

      for (const neighborIdx of node.neighbors[layer]) {
        const neighborNode = this.nodes[neighborIdx];
        const dist = this.distanceFn(query, neighborNode.vector);
        if (dist < currentDist) {
          currentDist = dist;
          currentIndex = neighborIdx;
          improved = true;
        }
      }
    }

    return { index: currentIndex, distance: currentDist };
  }

  /**
   * Search a single layer starting from `entryIndex`, returning up to `ef`
   * closest candidates. This is the core ef-bounded greedy search.
   */
  private _searchLayer(
    query: number[],
    entryIndex: number,
    ef: number,
    layer: number,
  ): Array<{ index: number; distance: number }> {
    const entryDist = this.distanceFn(query, this.nodes[entryIndex].vector);
    const visited = new Set<number>([entryIndex]);

    // candidates: min-heap of nodes to explore (closest first)
    const candidates = new MinHeap<number>();
    candidates.push(entryDist, entryIndex);

    // result: max-heap of best results so far (farthest first for easy eviction)
    const result = new MaxHeap<number>();
    result.push(entryDist, entryIndex);

    while (candidates.length > 0) {
      const closest = candidates.pop()!;

      // If the closest candidate is farther than the farthest result, stop.
      const farthestResult = result.peek()!;
      if (closest.priority > farthestResult.priority) break;

      const node = this.nodes[closest.value];
      if (layer >= node.neighbors.length) continue;

      for (const neighborIdx of node.neighbors[layer]) {
        if (visited.has(neighborIdx)) continue;
        visited.add(neighborIdx);

        const neighborDist = this.distanceFn(query, this.nodes[neighborIdx].vector);
        const currentFarthest = result.peek()!;

        if (result.length < ef || neighborDist < currentFarthest.priority) {
          candidates.push(neighborDist, neighborIdx);
          result.push(neighborDist, neighborIdx);

          if (result.length > ef) {
            result.pop(); // Evict farthest
          }
        }
      }
    }

    return result.toArray().map((e) => ({ index: e.value, distance: e.priority }));
  }

  /**
   * Heuristic neighbor selection (algorithm 4 from the paper).
   * Selects diverse neighbors rather than just the closest, improving graph
   * connectivity and search quality.
   */
  private _selectNeighborsHeuristic(
    query: number[],
    candidates: Array<{ index: number; distance: number }>,
    maxConnections: number,
    layer: number,
  ): Array<{ index: number; distance: number }> {
    if (candidates.length <= maxConnections) {
      return [...candidates];
    }

    // Sort candidates by distance (closest first).
    const sorted = [...candidates].sort((a, b) => a.distance - b.distance);
    const selected: Array<{ index: number; distance: number }> = [];

    for (const candidate of sorted) {
      if (selected.length >= maxConnections) break;

      // Check if this candidate is closer to the query than to any
      // already-selected neighbor. This promotes diversity.
      let tooClose = false;
      for (const sel of selected) {
        const interDist = this.distanceFn(
          this.nodes[candidate.index].vector,
          this.nodes[sel.index].vector,
        );
        if (interDist < candidate.distance) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) {
        selected.push(candidate);
      }
    }

    // If the heuristic was too aggressive and we don't have enough,
    // fill from remaining candidates in order of distance.
    if (selected.length < maxConnections) {
      const selectedSet = new Set(selected.map((s) => s.index));
      for (const candidate of sorted) {
        if (selected.length >= maxConnections) break;
        if (!selectedSet.has(candidate.index)) {
          selected.push(candidate);
          selectedSet.add(candidate.index);
        }
      }
    }

    return selected;
  }

  /**
   * Shrink a node's neighbor list at a given layer to at most `maxConnections`
   * using the heuristic selection strategy.
   */
  private _shrinkNeighbors(nodeIndex: number, layer: number, maxConnections: number): void {
    const node = this.nodes[nodeIndex];
    const currentNeighbors = node.neighbors[layer];
    if (currentNeighbors.size <= maxConnections) return;

    const candidates: Array<{ index: number; distance: number }> = [];
    for (const neighborIdx of currentNeighbors) {
      candidates.push({
        index: neighborIdx,
        distance: this.distanceFn(node.vector, this.nodes[neighborIdx].vector),
      });
    }

    const selected = this._selectNeighborsHeuristic(node.vector, candidates, maxConnections, layer);
    node.neighbors[layer] = new Set(selected.map((s) => s.index));
  }

  /**
   * Find a new entry point after the current one is deleted.
   * Walks through all nodes to find the highest-level non-deleted node.
   */
  private _updateEntryPoint(): void {
    let bestIndex = -1;
    let bestLevel = -1;

    for (let i = 0; i < this.nodes.length; i++) {
      if (!this.nodes[i].deleted && this.nodes[i].level > bestLevel) {
        bestLevel = this.nodes[i].level;
        bestIndex = i;
      }
    }

    this.entryPointIndex = bestIndex;
    this.maxLevel = bestLevel;
  }
}
