import * as fs from "node:fs";
import * as path from "node:path";

import { context } from "../deps/anyhow.ts";
import { homeDir } from "../deps/dirs.ts";
import { ioError } from "../deps/io.ts";
import { debugPath, decodeUtf8 } from "../deps/utf8.ts";
import type { Dir } from "../db/index.ts";
import type { ImportError, Importer, ImportRecord } from "../import.ts";
import { readRecords } from "./lines.ts";

export class Z implements Importer {
  dirs(): Iterable<ImportRecord> {
    const dataPath = zDataPath();
    return parseFile(readDataFile(dataPath), dataPath);
  }
}

export function readDataFile(dataPath: string): Buffer {
  try {
    return fs.readFileSync(dataPath);
  } catch (error) {
    throw context(ioError(error), `could not read ${debugPath(dataPath)}`);
  }
}

/**
 * z stores entries as `path|rank|last_accessed`, split from the right so paths
 * containing `|` are preserved. fasd, zsh-z and z.lua all reuse this format.
 */
export function* parseFile(buffer: Buffer, dataPath: string): Generator<ImportRecord> {
  for (const record of readRecords(buffer, 0x0a, true)) {
    const fail = (source: unknown): ImportRecord => ({
      ok: false,
      error: { path: dataPath, lineNum: record.lineNum, source } satisfies ImportError,
    });

    let line: string;
    try {
      line = decodeUtf8(record.bytes);
    } catch (error) {
      yield fail(context(error, "invalid utf-8"));
      continue;
    }

    const invalid = (): ImportRecord => fail(new Error(`invalid entry: ${line}`));

    // `rsplitn(3, '|')`: two separators are required, and only the last two
    // count, so a path may itself contain `|`.
    const secondBar = line.lastIndexOf("|");
    const firstBar = secondBar <= 0 ? -1 : line.lastIndexOf("|", secondBar - 1);
    if (firstBar === -1) {
      yield invalid();
      continue;
    }

    const lastAccessed = line.slice(secondBar + 1);
    if (!isU64(lastAccessed)) {
      yield invalid();
      continue;
    }
    const rank = line.slice(firstBar + 1, secondBar);
    if (!isRustFloatLiteral(rank)) {
      yield invalid();
      continue;
    }

    const dir: Dir = {
      path: line.slice(0, firstBar),
      rank: parseRustFloat(rank),
      lastAccessed: Number(lastAccessed),
    };
    yield { ok: true, dir };
  }
}

/**
 * Rust's `str::parse::<u64>` grammar and range. Values above 2^53 keep their
 * magnitude but lose precision once stored, which no real `z` data file
 * produces.
 */
export function isU64(text: string): boolean {
  if (!/^\+?\d+$/.test(text)) {
    return false;
  }
  return BigInt(text) <= 18446744073709551615n;
}

/** Rust's `str::parse::<f64>` grammar. */
export function isRustFloatLiteral(text: string): boolean {
  return (
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ||
    /^[+-]?(?:inf|infinity|nan)$/i.test(text)
  );
}

export function parseRustFloat(text: string): number {
  if (/^[+-]?(?:inf|infinity)$/i.test(text)) {
    return text.startsWith("-") ? -Infinity : Infinity;
  }
  if (/^[+-]?nan$/i.test(text)) {
    return NaN;
  }
  return Number(text);
}

/**
 * Mirrors z's path logic:
 *
 * ```sh
 * local datafile="${_Z_DATA:-$HOME/.z}"
 * ```
 */
export function zDataPath(): string {
  const fromEnv = process.env["_Z_DATA"];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const home = homeDir();
  if (home === null) {
    throw new Error("could not find home directory");
  }
  return path.join(home, ".z");
}
