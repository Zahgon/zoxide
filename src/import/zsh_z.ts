import * as path from "node:path";

import { homeDir } from "../deps/dirs.ts";
import type { Importer, ImportRecord } from "../import.ts";
import { parseFile, readDataFile } from "./z.ts";

export class ZshZ implements Importer {
  dirs(): Iterable<ImportRecord> {
    const dataPath = dataPathFor();
    // zsh-z uses the same `path|rank|last_accessed` line format as z.
    return parseFile(readDataFile(dataPath), dataPath);
  }
}

/**
 * Mirrors zsh-z's path logic:
 *
 * ```sh
 * # Allow the user to specify a custom datafile in $ZSHZ_DATA (or legacy $_Z_DATA)
 * local custom_datafile="${ZSHZ_DATA:-$_Z_DATA}"
 * # If the user specified a datafile, use that or default to ~/.z
 * local datafile=${${custom_datafile:-$HOME/.z}:A}
 * ```
 */
function dataPathFor(): string {
  const fromEnv = process.env["ZSHZ_DATA"] ?? process.env["_Z_DATA"];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const home = homeDir();
  if (home === null) {
    throw new Error("could not find home directory");
  }
  return path.join(home, ".z");
}
