import * as path from "node:path";

import { context } from "./deps/anyhow.ts";
import { dataLocalDir, homeDir } from "./deps/dirs.ts";
import { Pattern } from "./deps/glob.ts";
import type { Rank } from "./db/dir.ts";

export function dataDir(): string {
  const fromEnv = process.env["_ZO_DATA_DIR"];
  let dir: string;
  if (fromEnv !== undefined) {
    dir = fromEnv;
  } else {
    const local = dataLocalDir();
    if (local === null) {
      throw new Error("could not find data directory, please set _ZO_DATA_DIR manually");
    }
    dir = path.join(local, "zoxide");
  }

  if (!path.isAbsolute(dir)) {
    throw new Error("_ZO_DATA_DIR must be an absolute path");
  }
  return dir;
}

export function echo(): boolean {
  return process.env["_ZO_ECHO"] === "1";
}

export function excludeDirs(): Pattern[] {
  const fromEnv = process.env["_ZO_EXCLUDE_DIRS"];
  if (fromEnv !== undefined) {
    return splitPaths(fromEnv).map((pattern) => {
      try {
        return Pattern.new(pattern);
      } catch (error) {
        throw context(error, `invalid glob in _ZO_EXCLUDE_DIRS: ${pattern}`);
      }
    });
  }

  // The home directory is excluded by default.
  const home = homeDir();
  if (home === null) {
    return [];
  }
  try {
    return [Pattern.new(Pattern.escape(home))];
  } catch {
    return [];
  }
}

export function fzfOpts(): string | undefined {
  return process.env["_ZO_FZF_OPTS"];
}

export function maxage(): Rank {
  const raw = process.env["_ZO_MAXAGE"];
  if (raw === undefined) {
    return 10_000.0;
  }
  if (!/^\+?\d+$/.test(raw) || Number(raw) > 4_294_967_295) {
    throw context(
      new Error(parseIntError(raw)),
      `unable to parse _ZO_MAXAGE as integer: ${raw}`,
    );
  }
  return Number(raw);
}

/** `std::num::ParseIntError`'s `Display`, which the context chain prints. */
function parseIntError(raw: string): string {
  if (raw === "") {
    return "cannot parse integer from empty string";
  }
  return /^\+?\d+$/.test(raw) ? "number too large to fit in target type" : "invalid digit found in string";
}

export function resolveSymlinks(): boolean {
  return process.env["_ZO_RESOLVE_SYMLINKS"] === "1";
}

/** `env::split_paths` — the platform's `PATH` separator, with empties kept. */
function splitPaths(value: string): string[] {
  return value.split(path.delimiter);
}
