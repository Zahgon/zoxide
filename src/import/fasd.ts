import * as path from "node:path";

import { homeDir } from "../deps/dirs.ts";
import type { Importer, ImportRecord } from "../import.ts";
import { parseFile, readDataFile } from "./z.ts";

export class Fasd implements Importer {
  dirs(): Iterable<ImportRecord> {
    const dataPath = dataPathFor();
    // fasd uses the same `path|rank|last_accessed` line format as z, so reuse
    // z's parser.
    return parseFile(readDataFile(dataPath), dataPath);
  }
}

/**
 * Mirrors fasd's path logic:
 *
 * ```sh
 * [ -z "$_FASD_DATA" ] && _FASD_DATA="$HOME/.fasd"
 * ```
 */
function dataPathFor(): string {
  const fromEnv = process.env["_FASD_DATA"];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const home = homeDir();
  if (home === null) {
    throw new Error("could not find home directory");
  }
  return path.join(home, ".fasd");
}
