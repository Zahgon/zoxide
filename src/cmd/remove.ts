import { Database } from "../db/index.ts";
import * as util from "../util.ts";
import type { Remove } from "./cmd.ts";

export function run(cmd: Remove): void {
  const db = Database.open();

  for (const dirPath of cmd.paths) {
    if (db.remove(dirPath)) {
      continue;
    }
    const absolute = util.pathToStr(util.resolvePath(dirPath));
    if (absolute === dirPath || !db.remove(absolute)) {
      throw new Error(`path not found in database: ${dirPath}`);
    }
  }

  db.save();
}
