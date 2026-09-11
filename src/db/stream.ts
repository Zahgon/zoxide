import * as fs from "node:fs";

import type { Pattern } from "../deps/glob.ts";
import * as util from "../util.ts";
import { MONTH } from "../util.ts";
import type { Database } from "./index.ts";
import type { Dir, Epoch } from "./dir.ts";

/**
 * A lazily filtered view over the database, highest score first.
 *
 * The stream is not a pure iterator: entries that match an exclude glob, and
 * stale entries whose directory no longer exists, are deleted from the database
 * as they are passed over.
 */
export class Stream {
  readonly #db: Database;
  readonly #options: StreamOptions;
  #index: number;

  constructor(db: Database, options: StreamOptions) {
    db.sortByScore(options.now);
    this.#db = db;
    this.#options = options;
    this.#index = db.dirs.length - 1;
  }

  next(): Dir | null {
    while (this.#index >= 0) {
      const index = this.#index;
      this.#index -= 1;
      const dir = this.#db.dirs[index]!;

      if (!this.filterByKeywords(dir.path)) {
        continue;
      }
      if (!this.#filterByBaseDir(dir.path)) {
        continue;
      }
      if (!this.#filterByExclude(dir.path)) {
        this.#db.swapRemove(index);
        continue;
      }
      // Exists queries are slow, this should always be checked last.
      if (!this.#filterByExists(dir.path)) {
        if (dir.lastAccessed < this.#options.ttl) {
          this.#db.swapRemove(index);
        }
        continue;
      }

      return this.#db.dirs[index]!;
    }

    return null;
  }

  #filterByBaseDir(dirPath: string): boolean {
    const baseDir = this.#options.baseDir;
    return baseDir === null || util.pathStartsWith(dirPath, baseDir);
  }

  #filterByExclude(dirPath: string): boolean {
    return !this.#options.exclude.some((pattern) => pattern.matches(dirPath));
  }

  #filterByExists(dirPath: string): boolean {
    if (!this.#options.exists) {
      return true;
    }

    // The logic here is reversed - if we resolve symlinks when adding entries
    // to the database, we should not return symlinks when querying from the
    // database.
    const stat = this.#options.resolveSymlinks ? fs.lstatSync : fs.statSync;
    try {
      return stat(dirPath).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * The query algorithm: the last keyword must match inside the final path
   * component, and each earlier keyword must match before the one after it.
   *
   * Exposed for the same reason the original exposes it — the test suite drives
   * it directly.
   */
  filterByKeywords(dirPath: string): boolean {
    const keywords = this.#options.keywords;
    const keywordsLast = keywords[keywords.length - 1];
    if (keywordsLast === undefined) {
      return true;
    }

    let path = util.toLowercase(dirPath);
    const last = path.lastIndexOf(keywordsLast);
    if (last === -1) {
      return false;
    }
    if (Array.from(path.slice(last + keywordsLast.length)).some((char) => util.isSeparator(char))) {
      return false;
    }
    path = path.slice(0, last);

    for (let index = keywords.length - 2; index >= 0; index -= 1) {
      const found = path.lastIndexOf(keywords[index]!);
      if (found === -1) {
        return false;
      }
      path = path.slice(0, found);
    }

    return true;
  }
}

export class StreamOptions {
  /** The current time. */
  readonly now: Epoch;

  /** Only directories matching these keywords will be returned. */
  keywords: string[] = [];

  /** Directories that match any of these globs will be lazily removed. */
  exclude: Pattern[] = [];

  /** Directories will only be returned if they exist on the filesystem. */
  exists = false;

  /** Whether to resolve symlinks when checking if a directory exists. */
  resolveSymlinks = false;

  /**
   * Directories that do not exist and haven't been accessed since TTL will be
   * lazily removed.
   */
  readonly ttl: Epoch;

  /**
   * Only return directories within this parent directory. Does not check if the
   * path exists.
   */
  baseDir: string | null = null;

  constructor(now: Epoch) {
    this.now = now;
    this.ttl = Math.max(0, now - 3 * MONTH);
  }

  withKeywords(keywords: Iterable<string>): StreamOptions {
    this.keywords = Array.from(keywords, util.toLowercase);
    return this;
  }

  withExclude(exclude: Pattern[]): StreamOptions {
    this.exclude = exclude;
    return this;
  }

  withExists(exists: boolean): StreamOptions {
    this.exists = exists;
    return this;
  }

  withResolveSymlinks(resolveSymlinks: boolean): StreamOptions {
    this.resolveSymlinks = resolveSymlinks;
    return this;
  }

  withBaseDir(baseDir: string | null): StreamOptions {
    this.baseDir = baseDir;
    return this;
  }
}
