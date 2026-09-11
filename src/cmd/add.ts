import * as fs from "node:fs";

import * as config from "../config.ts";
import { Database } from "../db/index.ts";
import * as util from "../util.ts";
import type { Add } from "./cmd.ts";

// These characters can't be printed cleanly to a single line, so they can cause
// confusion when writing to stdout.
const EXCLUDE_CHARS = ["\n", "\r"];

export function run(cmd: Add): void {
  const excludeDirs = config.excludeDirs();
  const maxAge = config.maxage();
  const now = util.currentTime();

  const db = Database.open();

  for (const rawPath of cmd.paths) {
    const resolved = config.resolveSymlinks() ? util.canonicalize(rawPath) : util.resolvePath(rawPath);
    const dirPath = util.pathToStr(resolved);

    // Ignore path if it contains unsupported characters, or if it's in the
    // exclude list.
    if (EXCLUDE_CHARS.some((char) => dirPath.includes(char))) {
      continue;
    }
    if (excludeDirs.some((glob) => glob.matches(dirPath))) {
      continue;
    }
    if (!isDir(dirPath)) {
      throw new Error(`not a directory: ${dirPath}`);
    }

    db.addUpdate(dirPath, cmd.score ?? 1.0, now);
  }

  if (db.dirty) {
    db.age(maxAge);
  }
  db.save();
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
