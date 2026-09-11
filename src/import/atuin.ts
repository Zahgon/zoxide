import { spawnSync } from "node:child_process";

import { context } from "../deps/anyhow.ts";
import { ioError } from "../deps/io.ts";
import { decodeUtf8 } from "../deps/utf8.ts";
import type { Dir } from "../db/index.ts";
import type { ImportError, Importer, ImportRecord } from "../import.ts";
import { readRecords } from "./lines.ts";

export class Atuin implements Importer {
  dirs(): Iterable<ImportRecord> {
    // atuin renders `{time}` as `YYYY-MM-DD HH:MM:SS` in UTC.
    const result = spawnSync("atuin", ["history", "list", "--format={time}\t{directory}", "--print0"], {
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: Infinity,
    });
    if (result.error !== undefined) {
      throw context(ioError(result.error), "failed to run `atuin`; is it installed and on PATH?");
    }
    return parse(result.stdout);
  }
}

/**
 * Iterates atuin's NUL-separated `{time}\t{directory}` records, emitting one
 * `Dir` per directory transition (consecutive same-path records collapse).
 */
function* parse(buffer: Buffer): Generator<ImportRecord> {
  let previousCwd: string | null = null;

  for (const record of readRecords(buffer, 0x00, false)) {
    const fail = (source: unknown): ImportRecord => ({
      ok: false,
      error: { path: null, lineNum: record.lineNum, source } satisfies ImportError,
    });

    let line: string;
    try {
      line = decodeUtf8(record.bytes);
    } catch (error) {
      yield fail(context(error, "invalid utf-8"));
      continue;
    }

    const tab = line.indexOf("\t");
    if (tab === -1) {
      yield fail(new Error(`invalid entry: ${line}`));
      continue;
    }

    const rawTimestamp = line.slice(0, tab);
    const timestamp = parseTimestamp(rawTimestamp);
    if (timestamp === null) {
      yield fail(
        context(
          new Error("the 'day' component could not be parsed"),
          `invalid timestamp: ${JSON.stringify(rawTimestamp)}`,
        ),
      );
      continue;
    }

    const dirPath = line.slice(tab + 1);
    if (previousCwd === dirPath) {
      continue; // dedup consecutive same-path entries
    }
    previousCwd = dirPath;

    const dir: Dir = { path: dirPath, rank: 1.0, lastAccessed: timestamp };
    yield { ok: true, dir };
  }
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * `time`'s `[year]-[month]-[day] [hour]:[minute]:[second]`, assumed UTC. The
 * format is fixed-width, so anything else is rejected.
 */
function parseTimestamp(text: string): number | null {
  const match = TIMESTAMP.exec(text);
  if (match === null) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match.map(Number) as [number, number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const millis = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(millis);
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() + 1 !== month || roundTrip.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(millis / 1000);
}
