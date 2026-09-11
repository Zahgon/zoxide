import * as fs from "node:fs";
import * as path from "node:path";

import { context } from "../deps/anyhow.ts";
import { homeDir } from "../deps/dirs.ts";
import { ioError } from "../deps/io.ts";
import { debugPath, decodeUtf8 } from "../deps/utf8.ts";
import type { Dir } from "../db/index.ts";
import type { ImportError, Importer, ImportRecord } from "../import.ts";
import { readRecords } from "./lines.ts";
import { isRustFloatLiteral, parseRustFloat } from "./z.ts";

export class Autojump implements Importer {
  dirs(): Iterable<ImportRecord> {
    const dataPath = dataPathFor();
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(dataPath);
    } catch (error) {
      throw context(ioError(error), `could not read ${debugPath(dataPath)}`);
    }
    return parse(buffer, dataPath);
  }
}

function* parse(buffer: Buffer, dataPath: string): Generator<ImportRecord> {
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

    const tab = line.indexOf("\t");
    if (tab === -1) {
      yield fail(new Error(`invalid entry: ${line}`));
      continue;
    }
    const rawRank = line.slice(0, tab);
    if (!isRustFloatLiteral(rawRank)) {
      yield fail(context(new Error("invalid float literal"), `invalid rank: ${rawRank}`));
      continue;
    }

    // Normalize the rank using a sigmoid function. Don't import actual ranks
    // from autojump, since its scoring algorithm is very different and might
    // take a while to normalize.
    const dir: Dir = { path: line.slice(tab + 1), rank: sigmoid(parseRustFloat(rawRank)), lastAccessed: 0 };
    yield { ok: true, dir };
  }
}

/**
 * Mirrors autojump's path logic:
 *
 * ```python
 * if is_osx():
 *     data_home = os.path.join(os.path.expanduser('~'), 'Library')
 * elif is_windows():
 *     data_home = os.getenv('APPDATA')
 * else:
 *     data_home = os.getenv(
 *         'XDG_DATA_HOME',
 *         os.path.join(os.path.expanduser('~'), '.local', 'share'),
 *     )
 * data_path = os.path.join(data_home, 'autojump', 'autojump.txt')
 * ```
 */
function dataPathFor(): string {
  let dataHome: string;
  if (process.platform === "darwin") {
    dataHome = path.join(requireHome(), "Library");
  } else if (process.platform === "win32") {
    const appdata = process.env["APPDATA"];
    if (appdata === undefined) {
      throw new Error("%APPDATA% is not set");
    }
    dataHome = appdata;
  } else {
    const xdg = process.env["XDG_DATA_HOME"];
    dataHome = xdg !== undefined ? xdg : path.join(requireHome(), ".local", "share");
  }
  return path.join(dataHome, "autojump", "autojump.txt");
}

function requireHome(): string {
  const home = homeDir();
  if (home === null) {
    throw new Error("could not find home directory");
  }
  return home;
}

function sigmoid(x: number): number {
  return 1.0 / (1.0 + Math.exp(-x));
}
