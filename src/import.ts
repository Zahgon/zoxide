import * as config from "./config.ts";
import { formatAlternate } from "./deps/anyhow.ts";
import type { Database, Dir } from "./db/index.ts";
import { writeStderr } from "./cmd/io.ts";

export { Atuin } from "./import/atuin.ts";
export { Autojump } from "./import/autojump.ts";
export { Fasd } from "./import/fasd.ts";
export { Z } from "./import/z.ts";
export { ZLua } from "./import/z_lua.ts";
export { ZshZ } from "./import/zsh_z.ts";

/** A single record that failed to import. */
export interface ImportError {
  /**
   * Path of the source file containing the offending record. `null` if the
   * importer is not file-based (e.g. atuin streams from a subprocess).
   */
  readonly path: string | null;

  /** 1-indexed line number of the offending input. */
  readonly lineNum: number;

  /** Underlying reason the record could not be imported. */
  readonly source: unknown;
}

export type ImportRecord = { readonly ok: true; readonly dir: Dir } | { readonly ok: false; readonly error: ImportError };

export interface Importer {
  /**
   * Yields directory entries to be imported.
   *
   * Throwing reports failure to fetch the input (e.g. missing file, subprocess
   * errored). A yielded `ok: false` reports a malformed row, which doesn't
   * necessarily abort the whole import.
   */
  dirs(): Iterable<ImportRecord>;
}

/**
 * Drives a single importer end-to-end: writes each `ok` dir into the database
 * and prints each error to stderr in `<path>:<line>: <reason>` format. Doesn't
 * abort on per-record errors — bad rows are skipped, the rest of the import
 * continues. After the iteration completes successfully, the database is
 * deduplicated and aged.
 */
export function run(importer: Importer, db: Database): void {
  const excludeDirs = config.excludeDirs();

  for (const entry of importer.dirs()) {
    if (entry.ok) {
      if (excludeDirs.some((glob) => glob.matches(entry.dir.path))) {
        continue;
      }
      db.addUnchecked(entry.dir.path, entry.dir.rank, entry.dir.lastAccessed);
      continue;
    }

    const { path, lineNum, source } = entry.error;
    const location = path === null ? `line ${lineNum}` : `${path}:${lineNum}`;
    writeStderr(`${location}: ${formatAlternate(source)}\n`);
  }

  if (db.dirty) {
    db.dedup();
    db.age(config.maxage());
  }
}
