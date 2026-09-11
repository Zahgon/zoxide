import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { Database } from "../src/db/index.ts";
import { tempdir } from "./support.ts";

// `db::tests::add` and `db::tests::remove`, from `src/db/mod.rs`. The module is
// this file and the test name is the title, so each name is the original's leaf
// verbatim — a dropped test shows up as a missing name, not a renamed one.

let dataDir: { path: string; cleanup: () => void };

beforeEach(() => {
  dataDir = tempdir();
});
afterEach(() => {
  dataDir.cleanup();
});

const path = process.platform === "win32" ? String.raw`C:\foo\bar` : "/foo/bar";
const now = 946684800;

test("add", () => {
  {
    const db = Database.openDir(dataDir.path);
    db.add(path, 1.0, now);
    db.add(path, 1.0, now);
    db.save();
  }

  {
    const db = Database.openDir(dataDir.path);
    expect(db.dirs.length).toBe(1);

    const dir = db.dirs[0]!;
    expect(dir.path).toBe(path);
    expect(Math.abs(dir.rank - 2.0)).toBeLessThan(0.01);
    expect(dir.lastAccessed).toBe(now);
  }
});

test("remove", () => {
  {
    const db = Database.openDir(dataDir.path);
    db.add(path, 1.0, now);
    db.save();
  }

  {
    const db = Database.openDir(dataDir.path);
    expect(db.remove(path)).toBe(true);
    db.save();
  }

  {
    const db = Database.openDir(dataDir.path);
    expect(db.dirs.length).toBe(0);
    expect(db.remove(path)).toBe(false);
    db.save();
  }
});

// Added by the migration: `Database::path` had no Rust test of its own.
test("the database file sits inside the data directory", () => {
  const db = Database.openDir(dataDir.path);
  expect(db.path).toBe(join(dataDir.path, "db.zo"));
  expect(db.dirty).toBe(false);
});
