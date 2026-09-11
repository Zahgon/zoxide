import * as fs from "node:fs";
import * as path from "node:path";

import { context } from "../deps/anyhow.ts";
import { homeDir } from "../deps/dirs.ts";
import { ErrorKind, errorKind, ioError } from "../deps/io.ts";
import { debugPath } from "../deps/utf8.ts";
import type { Importer, ImportRecord } from "../import.ts";
import { parseFile } from "./z.ts";

export class ZLua implements Importer {
  dirs(): Iterable<ImportRecord> {
    const dataPath = dataPathFor();
    let firstError: unknown;
    try {
      return parseFile(fs.readFileSync(dataPath), dataPath);
    } catch (error) {
      if (errorKind(error) !== ErrorKind.NotFound) {
        throw context(ioError(error), `could not read ${debugPath(dataPath)}`);
      }
      firstError = error;
    }

    const fishPath = dataPathFish();
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(fishPath);
    } catch (error) {
      // Both paths missing - report the original path's error.
      if (errorKind(error) === ErrorKind.NotFound) {
        throw context(ioError(firstError), `could not read ${debugPath(dataPath)}`);
      }
      // Fish path failed for some other reason (permissions, etc.)
      throw context(ioError(error), `could not read ${debugPath(fishPath)}`);
    }
    // z.lua uses the same `path|rank|last_accessed` line format as z.
    return parseFile(buffer, fishPath);
  }
}

/**
 * Mirrors z.lua's path logic:
 *
 * ```lua
 * DATA_FILE = '~/.zlua'    -- default
 *
 * -- in z_init():
 * local _zl_data = os.getenv('_ZL_DATA')
 * if _zl_data ~= nil and _zl_data ~= "" then
 *     if windows then
 *         DATA_FILE = _zl_data
 *     else
 *         -- avoid windows environments affect cygwin & msys
 *         if not string.match(_zl_data, '^%a:[/\\]') then
 *             DATA_FILE = _zl_data
 *         end
 *     end
 * end
 * ```
 */
function dataPathFor(): string {
  const fromEnv = process.env["_ZL_DATA"];
  if (
    fromEnv !== undefined &&
    // Skip empty paths.
    fromEnv !== "" &&
    // On non-Windows, skip values that look like a Windows path (`C:\...`) —
    // guards against Cygwin/MSYS environments leaking through.
    (process.platform === "win32" || !looksLikeWindowsPath(fromEnv))
  ) {
    return fromEnv;
  }

  return path.join(requireHome(), ".zlua");
}

/**
 * Mirrors z.lua's path logic on Fish:
 *
 * ```fish
 * if test -z "$XDG_DATA_HOME"
 *     set -U _ZL_DATA_DIR "$HOME/.local/share/zlua"
 * else
 *     set -U _ZL_DATA_DIR "$XDG_DATA_HOME/zlua"
 * end
 * set -x _ZL_DATA "$_ZL_DATA_DIR/zlua.txt"
 * ```
 */
function dataPathFish(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg !== undefined ? xdg : path.join(requireHome(), ".local", "share");
  return path.join(base, "zlua", "zlua.txt");
}

function requireHome(): string {
  const home = homeDir();
  if (home === null) {
    throw new Error("could not find home directory");
  }
  return home;
}

/** Matches Lua's `^%a:[/\\]` — ASCII letter, colon, slash-or-backslash. */
function looksLikeWindowsPath(text: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(text);
}
