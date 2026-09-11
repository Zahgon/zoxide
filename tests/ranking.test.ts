/**
 * The ranking and query algorithms: scoring, aging, dedup, and the filters the
 * query stream applies (and the deletions it performs on the way).
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Database } from "../src/db/index.ts";
import { display, score } from "../src/db/dir.ts";
import { Stream, StreamOptions } from "../src/db/stream.ts";
import { Pattern } from "../src/deps/glob.ts";
import { DAY, HOUR, MONTH, WEEK } from "../src/util.ts";
import { tempdir } from "./support.ts";

const NOW = 1_000_000_000;

describe("score", () => {
  test.each([
    [0, 4],
    [HOUR - 1, 4],
    [HOUR, 2],
    [DAY - 1, 2],
    [DAY, 0.5],
    [WEEK - 1, 0.5],
    [WEEK, 0.25],
    [10 * WEEK, 0.25],
  ])("an entry %i seconds old scores rank * %f", (age, multiplier) => {
    expect(score({ path: "/x", rank: 3, lastAccessed: NOW - age }, NOW)).toBeCloseTo(3 * multiplier, 10);
  });

  test("a future timestamp saturates rather than going negative", () => {
    expect(score({ path: "/x", rank: 3, lastAccessed: NOW + WEEK }, NOW)).toBe(12);
  });
});

describe("display", () => {
  test("prints the bare path without a score", () => {
    expect(display({ path: "/x", rank: 1, lastAccessed: NOW }).toString()).toBe("/x");
  });

  test("right-aligns the score in six columns and clamps it", () => {
    const dir = { path: "/x", rank: 1, lastAccessed: NOW };
    expect(display(dir).withScore(NOW).toString()).toBe("   4.0 /x");
    expect(display(dir).withScore(NOW).withSeparator("\t").toString()).toBe("   4.0\t/x");
    expect(display({ ...dir, rank: 1e9 }).withScore(NOW).toString()).toBe("9999.0 /x");
    expect(display({ ...dir, rank: -1e9 }).withScore(NOW).toString()).toBe("   0.0 /x");
  });
});

describe("Database", () => {
  test("add clamps the rank at zero and keeps last_accessed", () => {
    const db = Database.create("");
    db.add("/x", 1, NOW);
    db.add("/x", -5, NOW + 10);
    expect(db.dirs).toEqual([{ path: "/x", rank: 0, lastAccessed: NOW }]);
  });

  test("addUpdate also moves last_accessed forward", () => {
    const db = Database.create("");
    db.addUpdate("/x", 1, NOW);
    db.addUpdate("/x", 2, NOW + 10);
    expect(db.dirs).toEqual([{ path: "/x", rank: 3, lastAccessed: NOW + 10 }]);
  });

  test("remove is a swap-remove, so it does not preserve order", () => {
    const db = Database.create("");
    for (const path of ["/a", "/b", "/c"]) {
      db.addUnchecked(path, 1, NOW);
    }
    expect(db.remove("/a")).toBe(true);
    expect(db.dirs.map((d) => d.path)).toEqual(["/c", "/b"]);
    expect(db.remove("/a")).toBe(false);
  });

  test("age rescales by 0.9 * maxAge / total and drops anything under 1", () => {
    const db = Database.create("");
    db.addUnchecked("/a", 60, NOW);
    db.addUnchecked("/b", 40, NOW);
    db.addUnchecked("/c", 1, NOW);
    db.age(50);

    // total 101 > 50, so factor = 0.9 * 50 / 101.
    const factor = (0.9 * 50) / 101;
    expect(db.dirs).toEqual([
      { path: "/a", rank: 60 * factor, lastAccessed: NOW },
      { path: "/b", rank: 40 * factor, lastAccessed: NOW },
    ]);
  });

  test("age below the threshold changes nothing", () => {
    const db = Database.create("");
    db.addUnchecked("/a", 5, NOW);
    db.age(50);
    expect(db.dirs).toEqual([{ path: "/a", rank: 5, lastAccessed: NOW }]);
  });

  test("dedup sums ranks and keeps the newest timestamp", () => {
    const db = Database.create("");
    db.addUnchecked("/b", 1, NOW);
    db.addUnchecked("/a", 2, NOW + 5);
    db.addUnchecked("/b", 3, NOW + 10);
    db.dedup();

    const byPath = Object.fromEntries(db.dirs.map((d) => [d.path, d]));
    expect(byPath).toEqual({
      "/a": { path: "/a", rank: 2, lastAccessed: NOW + 5 },
      "/b": { path: "/b", rank: 4, lastAccessed: NOW + 10 },
    });
  });

  test("sortByPath compares UTF-8 bytes, as Rust's str::cmp does", () => {
    const db = Database.create("");
    for (const path of ["/é", "/z", "/a"]) {
      db.addUnchecked(path, 1, NOW);
    }
    db.sortByPath();
    expect(db.dirs.map((d) => d.path)).toEqual(["/a", "/z", "/é"]);
  });
});

describe("Stream", () => {
  let dir: { path: string; cleanup: () => void };

  beforeEach(() => {
    dir = tempdir();
  });
  afterEach(() => {
    dir.cleanup();
  });

  function streamOf(db: Database, configure: (o: StreamOptions) => StreamOptions = (o) => o): string[] {
    const stream = new Stream(db, configure(new StreamOptions(NOW)));
    const seen: string[] = [];
    for (;;) {
      const next = stream.next();
      if (next === null) {
        return seen;
      }
      seen.push(next.path);
    }
  }

  test("yields the highest score first", () => {
    const db = Database.create("");
    db.addUnchecked("/low", 1, NOW);
    db.addUnchecked("/high", 5, NOW);
    db.addUnchecked("/mid", 3, NOW);
    expect(streamOf(db)).toEqual(["/high", "/mid", "/low"]);
  });

  test("filters by base directory on component boundaries", () => {
    const db = Database.create("");
    db.addUnchecked("/foo/bar", 1, NOW);
    db.addUnchecked("/foobar", 1, NOW);
    expect(streamOf(db, (o) => o.withBaseDir("/foo"))).toEqual(["/foo/bar"]);
  });

  test("an excluded entry is deleted from the database, not just skipped", () => {
    const db = Database.create("");
    db.addUnchecked("/keep", 1, NOW);
    db.addUnchecked("/drop/me", 1, NOW);
    expect(streamOf(db, (o) => o.withExclude([Pattern.new("/drop/*")]))).toEqual(["/keep"]);
    expect(db.dirs.map((d) => d.path)).toEqual(["/keep"]);
  });

  test("a missing directory is dropped only once it is older than the TTL", () => {
    const db = Database.create("");
    db.addUnchecked("/missing/recent", 1, NOW - MONTH);
    db.addUnchecked("/missing/stale", 1, NOW - 4 * MONTH);
    expect(streamOf(db, (o) => o.withExists(true))).toEqual([]);
    expect(db.dirs.map((d) => d.path)).toEqual(["/missing/recent"]);
  });

  test("resolveSymlinks makes a symlinked directory count as missing", () => {
    mkdirSync(join(dir.path, "real"));
    symlinkSync(join(dir.path, "real"), join(dir.path, "link"));
    writeFileSync(join(dir.path, "file"), "");

    const paths = [join(dir.path, "real"), join(dir.path, "link"), join(dir.path, "file")];
    const build = (): Database => {
      const db = Database.create("");
      for (const path of paths) {
        db.addUnchecked(path, 1, NOW);
      }
      return db;
    };

    expect(streamOf(build(), (o) => o.withExists(true)).sort()).toEqual([paths[0], paths[1]].sort());
    expect(streamOf(build(), (o) => o.withExists(true).withResolveSymlinks(true))).toEqual([paths[0]]);
  });

  test("no keywords matches everything", () => {
    const db = Database.create("");
    db.addUnchecked("/anything", 1, NOW);
    expect(streamOf(db, (o) => o.withKeywords([]))).toEqual(["/anything"]);
  });
});
