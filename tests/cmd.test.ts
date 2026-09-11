/**
 * The commands themselves, driven end to end through `run()` against a real
 * temporary data directory — parse the argv the user would type, execute it,
 * and check what reached stdout, stderr and `db.zo`.
 *
 * This is the layer the original covered only through its binary; nothing in
 * `src/cmd/` had a Rust unit test.
 */
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CMD, fromMatches } from "../src/cmd/cmd.ts";
import { run } from "../src/cmd/index.ts";
import * as io from "../src/cmd/io.ts";
import { Database } from "../src/db/index.ts";
import { parse } from "../src/deps/clap.ts";
import { tempdir } from "./support.ts";

let dir: { path: string; cleanup: () => void };
let dataDir: string;
let out: string[];
let err: string[];
const saved = { ...process.env };

beforeEach(() => {
  dir = tempdir();
  dataDir = join(dir.path, "data");
  mkdirSync(dataDir);
  for (const name of ["one", "two", "two/three"]) {
    mkdirSync(join(dir.path, name), { recursive: true });
  }
  process.env["_ZO_DATA_DIR"] = dataDir;
  process.env["_ZO_EXCLUDE_DIRS"] = "/nonexistent";
  out = [];
  err = [];
  vi.spyOn(io, "writeStdout").mockImplementation((text: string) => void out.push(text));
  vi.spyOn(io, "writeStderr").mockImplementation((text: string) => void err.push(text));
});

afterEach(() => {
  vi.restoreAllMocks();
  dir.cleanup();
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, saved);
});

/** Parse an argv the way `main` does, then execute it. */
async function zoxide(...argv: string[]): Promise<void> {
  await run(fromMatches(parse(CMD, argv, "zoxide")));
}

function stdout(): string {
  return out.join("");
}

function entries(): { path: string; rank: number }[] {
  return Database.openDir(dataDir)
    .dirs.map((d) => ({ path: d.path, rank: d.rank }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

describe("add", () => {
  test("creates an entry, then increments it", async () => {
    await zoxide("add", join(dir.path, "one"));
    expect(entries()).toEqual([{ path: join(dir.path, "one"), rank: 1 }]);
    await zoxide("add", join(dir.path, "one"));
    expect(entries()).toEqual([{ path: join(dir.path, "one"), rank: 2 }]);
  });

  test("honours --score, and clamps a negative result at zero", async () => {
    await zoxide("add", "--score", "5.5", join(dir.path, "one"));
    expect(entries()).toEqual([{ path: join(dir.path, "one"), rank: 5.5 }]);
    await zoxide("add", "--score=-100", join(dir.path, "one"));
    expect(entries()).toEqual([{ path: join(dir.path, "one"), rank: 0 }]);
  });

  test("resolves a relative path against the current directory", async () => {
    const cwd = process.cwd();
    process.chdir(dir.path);
    try {
      await zoxide("add", "two/../two/three");
    } finally {
      process.chdir(cwd);
    }
    expect(entries().map((e) => e.path)).toEqual([join(dir.path, "two", "three")]);
  });

  test("refuses a path that is not a directory", async () => {
    writeFileSync(join(dir.path, "file"), "");
    await expect(zoxide("add", join(dir.path, "file"))).rejects.toThrow(
      `not a directory: ${join(dir.path, "file")}`,
    );
    await expect(zoxide("add", join(dir.path, "missing"))).rejects.toThrow("not a directory:");
  });

  test("silently skips an excluded directory", async () => {
    process.env["_ZO_EXCLUDE_DIRS"] = join(dir.path, "one");
    await zoxide("add", join(dir.path, "one"), join(dir.path, "two"));
    expect(entries().map((e) => e.path)).toEqual([join(dir.path, "two")]);
  });

  test("_ZO_RESOLVE_SYMLINKS stores the target of a symlink", async () => {
    symlinkSync(join(dir.path, "two"), join(dir.path, "link"));
    process.env["_ZO_RESOLVE_SYMLINKS"] = "1";
    await zoxide("add", join(dir.path, "link"));
    expect(entries().map((e) => e.path)).toEqual([join(dir.path, "two")]);
  });

  test("without it, the symlink itself is stored", async () => {
    symlinkSync(join(dir.path, "two"), join(dir.path, "link"));
    await zoxide("add", join(dir.path, "link"));
    expect(entries().map((e) => e.path)).toEqual([join(dir.path, "link")]);
  });

  test("does not write a database when nothing changed", async () => {
    process.env["_ZO_EXCLUDE_DIRS"] = join(dir.path, "*");
    await zoxide("add", join(dir.path, "one"));
    expect(() => readFileSync(join(dataDir, "db.zo"))).toThrow();
  });
});

describe("query", () => {
  beforeEach(async () => {
    await zoxide("add", join(dir.path, "one"));
    await zoxide("add", join(dir.path, "two"));
    await zoxide("add", join(dir.path, "two"));
    out = [];
  });

  test("prints the single best match", async () => {
    await zoxide("query");
    expect(stdout()).toBe(`${join(dir.path, "two")}\n`);
  });

  test("--list prints every match, best first", async () => {
    await zoxide("query", "--list");
    expect(stdout()).toBe(`${join(dir.path, "two")}\n${join(dir.path, "one")}\n`);
  });

  test("--score prefixes a six-column score", async () => {
    await zoxide("query", "--list", "--score");
    expect(stdout().split("\n")[0]).toBe(`   8.0 ${join(dir.path, "two")}`);
  });

  test("filters by keyword", async () => {
    await zoxide("query", "one");
    expect(stdout()).toBe(`${join(dir.path, "one")}\n`);
  });

  test("--exclude skips a match, and says so when it was the only one", async () => {
    await zoxide("query", "--exclude", join(dir.path, "two"));
    expect(stdout()).toBe(`${join(dir.path, "one")}\n`);
    await expect(zoxide("query", "one", "--exclude", join(dir.path, "one"))).rejects.toThrow(
      "you are already in the only match",
    );
  });

  test("--base-dir restricts the search", async () => {
    await zoxide("query", "--list", "--base-dir", join(dir.path, "two"));
    expect(stdout()).toBe(`${join(dir.path, "two")}\n`);
  });

  test("reports no match found", async () => {
    await expect(zoxide("query", "nowhere")).rejects.toThrow("no match found");
  });

  test("--all keeps a directory that no longer exists", async () => {
    const gone = join(dir.path, "gone");
    mkdirSync(gone);
    await zoxide("add", gone);
    rmSync(gone, { recursive: true });
    out = [];

    await zoxide("query", "--list", "--all");
    expect(stdout()).toContain(gone);
    out = [];
    await zoxide("query", "--list");
    expect(stdout()).not.toContain(gone);
  });
});

describe("remove", () => {
  test("removes by exact string, then by resolved path", async () => {
    await zoxide("add", join(dir.path, "one"));
    await zoxide("remove", join(dir.path, "one"));
    expect(entries()).toEqual([]);

    await zoxide("add", join(dir.path, "one"));
    const cwd = process.cwd();
    process.chdir(dir.path);
    try {
      await zoxide("remove", "one");
    } finally {
      process.chdir(cwd);
    }
    expect(entries()).toEqual([]);
  });

  test("reports a path it does not hold", async () => {
    await expect(zoxide("remove", join(dir.path, "one"))).rejects.toThrow(
      `path not found in database: ${join(dir.path, "one")}`,
    );
  });
});

describe("edit", () => {
  beforeEach(async () => {
    await zoxide("add", join(dir.path, "one"));
    out = [];
  });

  test("reload prints every entry NUL-separated, score first", async () => {
    await zoxide("edit", "reload");
    expect(stdout()).toBe(`   4.0\t${join(dir.path, "one")}\0`);
  });

  test("increment, decrement and delete change the database", async () => {
    await zoxide("edit", "increment", join(dir.path, "one"));
    expect(entries()).toEqual([{ path: join(dir.path, "one"), rank: 2 }]);
    await zoxide("edit", "decrement", join(dir.path, "one"));
    expect(entries()).toEqual([{ path: join(dir.path, "one"), rank: 1 }]);
    await zoxide("edit", "delete", join(dir.path, "one"));
    expect(entries()).toEqual([]);
  });

  test("increment creates an entry that did not exist", async () => {
    await zoxide("edit", "increment", "/brand/new");
    expect(entries().map((e) => e.path)).toContain("/brand/new");
  });
});

describe("init", () => {
  test("writes the shell source plus exactly one newline", async () => {
    await zoxide("init", "posix", "--hook", "none");
    const source = stdout();
    expect(source.startsWith("# shellcheck shell=sh\n")).toBe(true);
    expect(source.endsWith("\n")).toBe(true);
    expect(source.endsWith("\n\n")).toBe(false);
  });

  test("reads _ZO_ECHO and _ZO_RESOLVE_SYMLINKS from the environment", async () => {
    await zoxide("init", "posix");
    const plain = stdout();
    out = [];
    process.env["_ZO_RESOLVE_SYMLINKS"] = "1";
    await zoxide("init", "posix");
    expect(stdout()).not.toBe(plain);
    expect(stdout()).toContain("\\command pwd -P");
  });

  test("ksh is an alias for posix", async () => {
    await zoxide("init", "ksh", "--hook", "none");
    const ksh = stdout();
    out = [];
    await zoxide("init", "posix", "--hook", "none");
    expect(ksh).toBe(stdout());
  });
});

describe("import", () => {
  beforeEach(() => {
    writeFileSync(join(dir.path, "zdata"), "/tmp/a|3|100\n/tmp/b|1|200\nbroken\n");
    process.env["_Z_DATA"] = join(dir.path, "zdata");
  });

  test("imports into an empty database and reports bad records on stderr", async () => {
    await zoxide("import", "z");
    expect(entries()).toEqual([
      { path: "/tmp/a", rank: 3 },
      { path: "/tmp/b", rank: 1 },
    ]);
    expect(err.join("")).toBe(`${join(dir.path, "zdata")}:3: invalid entry: broken\n`);
  });

  test("refuses a non-empty database without --merge, and merges with it", async () => {
    await zoxide("add", join(dir.path, "one"));
    await expect(zoxide("import", "z")).rejects.toThrow(
      "current database is not empty, specify --merge to continue anyway",
    );
    await zoxide("import", "z", "--merge");
    expect(entries().map((e) => e.path).sort()).toEqual(
      ["/tmp/a", "/tmp/b", join(dir.path, "one")].sort(),
    );
  });

  test("--merge is accepted before the source too", async () => {
    await zoxide("add", join(dir.path, "one"));
    await zoxide("import", "--merge", "z");
    expect(entries()).toHaveLength(3);
  });

  test("deduplicates the imported entries", async () => {
    writeFileSync(join(dir.path, "zdata"), "/tmp/a|3|100\n/tmp/a|2|300\n");
    await zoxide("import", "z");
    expect(entries()).toEqual([{ path: "/tmp/a", rank: 5 }]);
  });
});

describe("import sources", () => {
  /** Each importer, pointed at a data file through its own environment. */
  test.each([
    ["z", "_Z_DATA", "zdata", "/tmp/a|3|100\n"],
    ["fasd", "_FASD_DATA", "fasd", "/tmp/a|3|100\n"],
    ["zsh-z", "ZSHZ_DATA", "zshz", "/tmp/a|3|100\n"],
    ["z.lua", "_ZL_DATA", "zlua", "/tmp/a|3|100\n"],
  ])("%s reads $%s", async (source, variable, file, contents) => {
    writeFileSync(join(dir.path, file), contents);
    process.env[variable] = join(dir.path, file);
    await zoxide("import", source);
    expect(entries()).toEqual([{ path: "/tmp/a", rank: 3 }]);
  });

  test("autojump normalises its ranks", async () => {
    const home = join(dir.path, "home");
    const data =
      process.platform === "darwin" ? join(home, "Library") : join(home, ".local", "share");
    mkdirSync(join(data, "autojump"), { recursive: true });
    writeFileSync(join(data, "autojump", "autojump.txt"), "10\t/tmp/a\n");
    process.env["HOME"] = home;
    delete process.env["XDG_DATA_HOME"];

    await zoxide("import", "autojump");
    expect(entries()).toEqual([{ path: "/tmp/a", rank: 1 / (1 + Math.exp(-10)) }]);
  });

  test("atuin runs the subprocess, and says so when it is missing", async () => {
    process.env["PATH"] = join(dir.path, "empty-bin");
    await expect(zoxide("import", "atuin")).rejects.toThrow(
      "failed to run `atuin`; is it installed and on PATH?",
    );
  });
});
