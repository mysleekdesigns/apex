import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';

const COLLECTIONS = ['episodes', 'memory', 'skills', 'reflections', 'metrics', 'snapshots'] as const;
export type Collection = (typeof COLLECTIONS)[number];

export class FileStore {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /** Return the root directory path for this store. */
  getBasePath(): string {
    return this.basePath;
  }

  /** Create the .apex-data/ directory structure. */
  async init(): Promise<void> {
    for (const collection of COLLECTIONS) {
      await mkdir(path.join(this.basePath, collection), { recursive: true });
    }
  }

  /** Read a single item from a collection by ID. Returns null if not found. */
  async read<T>(collection: string, id: string): Promise<T | null> {
    try {
      const filePath = path.join(this.basePath, collection, `${id}.json`);
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  /** Write an item to a collection. Creates the collection directory if needed. */
  async write<T>(collection: string, id: string, data: T): Promise<void> {
    const dirPath = path.join(this.basePath, collection);
    await mkdir(dirPath, { recursive: true });
    const filePath = path.join(dirPath, `${id}.json`);
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** List all IDs in a collection. */
  async list(collection: string): Promise<string[]> {
    try {
      const dirPath = path.join(this.basePath, collection);
      const files = await readdir(dirPath);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  /** Delete an item from a collection. */
  async delete(collection: string, id: string): Promise<void> {
    try {
      const filePath = path.join(this.basePath, collection, `${id}.json`);
      await rm(filePath);
    } catch {
      // Already gone — fine
    }
  }

  /** Read all items from a collection. */
  async readAll<T>(collection: string): Promise<T[]> {
    const ids = await this.list(collection);
    const items: T[] = [];
    for (const id of ids) {
      const item = await this.read<T>(collection, id);
      if (item !== null) items.push(item);
    }
    return items;
  }
}
