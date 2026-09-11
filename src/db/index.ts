import * as fs from "node:fs";
import * as path from "node:path";

import { context } from "../deps/anyhow.ts";
import { Deserializer, Serializer, SIZE_U32 } from "../deps/bincode.ts";
import { errorKind, ErrorKind, ioError } from "../deps/io.ts";
import * as config from "../config.ts";
import * as util from "../util.ts";
import { type Dir, type Epoch, type Rank, score, totalCmp } from "./dir.ts";

export { type Dir, type Epoch, type Rank, display, score } from "./dir.ts";
export { Stream, StreamOptions } from "./stream.ts";

/** Bincode refuses to read a database larger than this, as the original does. */
const MAX_SIZE = 32 << 20;

export class Database {
  static readonly VERSION = 3;

  readonly #path: string;
  #dirs: Dir[];
  #dirty: boolean;

  private constructor(dbPath: string, dirs: Dir[], dirty: boolean) {
    this.#path = dbPath;
    this.#dirs = dirs;
    this.#dirty = dirty;
  }

  /** Test hook mirroring `Database::new`: an in-memory database at `path`. */
  static create(dbPath: string, dirs: Dir[] = [], dirty = false): Database {
    return new Database(dbPath, dirs, dirty);
  }

  static open(): Database {
    return Database.openDir(config.dataDir());
  }

  static openDir(dataDir: string): Database {
    const unresolved = path.join(dataDir, "db.zo");
    let dbPath: string;
    try {
      dbPath = fs.realpathSync(unresolved);
    } catch {
      dbPath = unresolved;
    }

    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(dbPath);
    } catch (error) {
      if (errorKind(error) === ErrorKind.NotFound) {
        // Create the data directory, but no file: `save` writes one only once
        // something has actually changed.
        try {
          fs.mkdirSync(dataDir, { recursive: true });
        } catch (mkdirError) {
          throw context(ioError(mkdirError), `unable to create data directory: ${dataDir}`);
        }
        return new Database(dbPath, [], false);
      }
      throw context(ioError(error), `could not read from database: ${dbPath}`);
    }

    return new Database(dbPath, Database.deserialize(bytes), false);
  }

  save(): void {
    // Only write to disk if the database is modified.
    if (!this.#dirty) {
      return;
    }
    const bytes = Database.serialize(this.#dirs);
    try {
      util.write(this.#path, bytes);
    } catch (error) {
      throw context(error, "could not write to database");
    }
    this.#dirty = false;
  }

  /** Increments the rank of a directory, or creates it if it does not exist. */
  add(dirPath: string, by: Rank, now: Epoch): void {
    const dir = this.#dirs.find((candidate) => candidate.path === dirPath);
    if (dir === undefined) {
      this.#dirs.push({ path: dirPath, rank: Math.max(by, 0.0), lastAccessed: now });
    } else {
      dir.rank = Math.max(dir.rank + by, 0.0);
    }
    this.#dirty = true;
  }

  /**
   * Creates a new directory. This will create a duplicate entry if this
   * directory is already in the database, it is expected that the user either
   * does a check before calling this, or calls `dedup()` afterward.
   */
  addUnchecked(dirPath: string, rank: Rank, now: Epoch): void {
    this.#dirs.push({ path: dirPath, rank, lastAccessed: now });
    this.#dirty = true;
  }

  /**
   * Increments the rank and updates the last_accessed of a directory, or
   * creates it if it does not exist.
   */
  addUpdate(dirPath: string, by: Rank, now: Epoch): void {
    const dir = this.#dirs.find((candidate) => candidate.path === dirPath);
    if (dir === undefined) {
      this.#dirs.push({ path: dirPath, rank: Math.max(by, 0.0), lastAccessed: now });
    } else {
      dir.rank = Math.max(dir.rank + by, 0.0);
      dir.lastAccessed = now;
    }
    this.#dirty = true;
  }

  /**
   * Removes the directory with `path` from the store. This does not preserve
   * ordering, but is O(1).
   */
  remove(dirPath: string): boolean {
    const index = this.#dirs.findIndex((dir) => dir.path === dirPath);
    if (index === -1) {
      return false;
    }
    this.swapRemove(index);
    return true;
  }

  swapRemove(index: number): void {
    const last = this.#dirs.pop();
    if (last !== undefined && index < this.#dirs.length) {
      this.#dirs[index] = last;
    }
    this.#dirty = true;
  }

  age(maxAge: Rank): void {
    let dirty = false;
    const totalAge = this.#dirs.reduce((sum, dir) => sum + dir.rank, 0);
    if (totalAge > maxAge) {
      const factor = (0.9 * maxAge) / totalAge;
      for (let index = this.#dirs.length - 1; index >= 0; index -= 1) {
        const dir = this.#dirs[index]!;
        dir.rank *= factor;
        if (dir.rank < 1.0) {
          this.swapRemove(index);
        }
      }
      dirty = true;
    }
    this.#dirty ||= dirty;
  }

  dedup(): void {
    // Sort by path, so that equal paths are next to each other.
    this.sortByPath();

    let dirty = false;
    for (let index = this.#dirs.length - 1; index >= 1; index -= 1) {
      const current = this.#dirs[index]!;
      const previous = this.#dirs[index - 1]!;
      if (previous.path !== current.path) {
        continue;
      }
      // Merge current's rank and last_accessed into previous.
      previous.lastAccessed = Math.max(previous.lastAccessed, current.lastAccessed);
      previous.rank += current.rank;
      this.swapRemove(index);
      dirty = true;
    }
    this.#dirty ||= dirty;
  }

  sortByPath(): void {
    this.#dirs.sort((a, b) => compareStrings(a.path, b.path));
    this.#dirty = true;
  }

  sortByScore(now: Epoch): void {
    this.#dirs.sort((a, b) => totalCmp(score(a, now), score(b, now)));
    this.#dirty = true;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get dirs(): Dir[] {
    return this.#dirs;
  }

  get path(): string {
    return this.#path;
  }

  static serialize(dirs: readonly Dir[]): Buffer {
    const serializer = new Serializer();
    serializer.u32(Database.VERSION);
    serializer.u64(BigInt(dirs.length));
    for (const dir of dirs) {
      serializer.str(dir.path);
      serializer.f64(dir.rank);
      serializer.u64(BigInt(dir.lastAccessed));
    }
    return serializer.finish();
  }

  static deserialize(bytes: Buffer): Dir[] {
    // Split bytes into sections.
    if (bytes.length < SIZE_U32) {
      throw new Error("could not deserialize database: corrupted data");
    }

    const version = bytes.readUInt32LE(0);
    if (version !== Database.VERSION) {
      throw new Error(`unsupported version (got ${version}, supports ${Database.VERSION})`);
    }

    const deserializer = new Deserializer(bytes.subarray(SIZE_U32), MAX_SIZE);
    try {
      const count = deserializer.seqLength();
      const dirs: Dir[] = [];
      for (let index = 0n; index < count; index += 1n) {
        dirs.push({
          path: deserializer.str(),
          rank: deserializer.f64(),
          lastAccessed: Number(deserializer.u64()),
        });
      }
      return dirs;
    } catch (error) {
      throw context(error, "could not deserialize database");
    }
  }
}

/** Rust's `str::cmp`, which compares UTF-8 bytes rather than UTF-16 units. */
function compareStrings(left: string, right: string): number {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return Buffer.compare(a, b);
}
