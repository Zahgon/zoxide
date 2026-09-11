/**
 * The importers, driven through their real entry points so that the data-file
 * lookup rules are exercised alongside the parsers.
 *
 * `zoxide import` never aborts on a bad record — it prints one line per failure
 * and keeps going — so the reported line numbers and reasons are asserted as
 * carefully as the records that succeed.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { formatAlternate } from "../src/deps/anyhow.ts";
import type { ImportRecord } from "../src/import.ts";
import { Atuin, Autojump, Fasd, Z, ZLua, ZshZ } from "../src/import.ts";
import { tempdir } from "./support.ts";

let dir: { path: string; cleanup: () => void };
const saved = { ...process.env };

beforeEach(() => {
  dir = tempdir();
});
afterEach(() => {
  dir.cleanup();
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, saved);
});

function seed(name: string, contents: string | Buffer): string {
  const path = join(dir.path, name);
  writeFileSync(path, contents);
  return path;
}

function collect(records: Iterable<ImportRecord>): { dirs: unknown[]; errors: string[] } {
  const dirs: unknown[] = [];
  const errors: string[] = [];
  for (const record of records) {
    if (record.ok) {
      dirs.push(record.dir);
    } else {
      const { path, lineNum, source } = record.error;
      errors.push(`${path === null ? `line ${lineNum}` : `${path}:${lineNum}`}: ${formatAlternate(source)}`);
    }
  }
  return { dirs, errors };
}

describe("import z", () => {
  test("parses path|rank|last_accessed, splitting from the right", () => {
    process.env["_Z_DATA"] = seed("z", "/tmp/a|3|100\n/pipe|d|1.5|200\n");
    expect(collect(new Z().dirs())).toEqual({
      dirs: [
        { path: "/tmp/a", rank: 3, lastAccessed: 100 },
        { path: "/pipe|d", rank: 1.5, lastAccessed: 200 },
      ],
      errors: [],
    });
  });

  test("skips blank lines but still counts them", () => {
    const path = seed("z", "/tmp/a|1|100\n\n\nbroken\n/tmp/b|1|200\n");
    process.env["_Z_DATA"] = path;
    const { dirs, errors } = collect(new Z().dirs());
    expect(dirs).toHaveLength(2);
    expect(errors).toEqual([`${path}:4: invalid entry: broken`]);
  });

  test("reports a bad rank or timestamp as an invalid entry", () => {
    const path = seed("z", "/tmp/a|x|100\n/tmp/b|1|y\n/tmp/c|1|-1\n");
    process.env["_Z_DATA"] = path;
    const { dirs, errors } = collect(new Z().dirs());
    expect(dirs).toEqual([]);
    expect(errors).toEqual([
      `${path}:1: invalid entry: /tmp/a|x|100`,
      `${path}:2: invalid entry: /tmp/b|1|y`,
      `${path}:3: invalid entry: /tmp/c|1|-1`,
    ]);
  });

  test("strips CRLF line endings", () => {
    process.env["_Z_DATA"] = seed("z", "/tmp/a|1|100\r\n");
    expect(collect(new Z().dirs()).dirs).toEqual([{ path: "/tmp/a", rank: 1, lastAccessed: 100 }]);
  });

  test("reports invalid UTF-8 the way Rust does", () => {
    const path = seed("z", Buffer.from("/tmp/\xff|1|100\n", "latin1"));
    process.env["_Z_DATA"] = path;
    expect(collect(new Z().dirs()).errors).toEqual([
      `${path}:1: invalid utf-8: invalid utf-8 sequence of 1 bytes from index 5`,
    ]);
  });

  test("a missing data file aborts the whole import", () => {
    process.env["_Z_DATA"] = join(dir.path, "missing");
    expect(() => collect(new Z().dirs())).toThrow(`could not read "${join(dir.path, "missing")}"`);
  });

  test("falls back to ~/.z", () => {
    delete process.env["_Z_DATA"];
    process.env["HOME"] = dir.path;
    seed(".z", "/tmp/a|1|100\n");
    expect(collect(new Z().dirs()).dirs).toEqual([{ path: "/tmp/a", rank: 1, lastAccessed: 100 }]);
  });
});

describe("import fasd and zsh-z", () => {
  test("fasd reuses z's format under $_FASD_DATA", () => {
    process.env["_FASD_DATA"] = seed("fasd", "/tmp/a|2|100\n");
    expect(collect(new Fasd().dirs()).dirs).toEqual([{ path: "/tmp/a", rank: 2, lastAccessed: 100 }]);
  });

  test("zsh-z prefers $ZSHZ_DATA over $_Z_DATA", () => {
    process.env["ZSHZ_DATA"] = seed("zshz", "/tmp/preferred|1|100\n");
    process.env["_Z_DATA"] = seed("z", "/tmp/legacy|1|100\n");
    expect(collect(new ZshZ().dirs()).dirs).toEqual([{ path: "/tmp/preferred", rank: 1, lastAccessed: 100 }]);
  });

  test("zsh-z falls back to $_Z_DATA", () => {
    delete process.env["ZSHZ_DATA"];
    process.env["_Z_DATA"] = seed("z", "/tmp/legacy|1|100\n");
    expect(collect(new ZshZ().dirs()).dirs).toEqual([{ path: "/tmp/legacy", rank: 1, lastAccessed: 100 }]);
  });
});

describe("import z.lua", () => {
  test("uses $_ZL_DATA when it is set", () => {
    process.env["_ZL_DATA"] = seed("zlua", "/tmp/a|1|100\n");
    expect(collect(new ZLua().dirs()).dirs).toEqual([{ path: "/tmp/a", rank: 1, lastAccessed: 100 }]);
  });

  test("ignores an empty or Windows-looking $_ZL_DATA", () => {
    process.env["HOME"] = dir.path;
    seed(".zlua", "/tmp/home|1|100\n");
    for (const value of ["", "C:/windows/path", String.raw`d:\windows\path`]) {
      process.env["_ZL_DATA"] = value;
      expect(collect(new ZLua().dirs()).dirs).toEqual([{ path: "/tmp/home", rank: 1, lastAccessed: 100 }]);
    }
  });

  test("falls back to the fish data file, and reports the first path when both are missing", () => {
    process.env["HOME"] = dir.path;
    process.env["XDG_DATA_HOME"] = join(dir.path, "xdg");
    delete process.env["_ZL_DATA"];
    expect(() => collect(new ZLua().dirs())).toThrow(`could not read "${join(dir.path, ".zlua")}"`);

    mkdirSync(join(dir.path, "xdg", "zlua"), { recursive: true });
    writeFileSync(join(dir.path, "xdg", "zlua", "zlua.txt"), "/tmp/fish|1|100\n");
    expect(collect(new ZLua().dirs()).dirs).toEqual([{ path: "/tmp/fish", rank: 1, lastAccessed: 100 }]);
  });
});

describe("import autojump", () => {
  /**
   * autojump's own data-home rules: `~/Library` on macOS, `%APPDATA%` on
   * Windows, `$XDG_DATA_HOME` (else `~/.local/share`) everywhere else.
   */
  function autojumpFile(): string {
    process.env["HOME"] = dir.path;
    process.env["APPDATA"] = join(dir.path, "appdata");
    process.env["XDG_DATA_HOME"] = join(dir.path, "xdg");
    const home =
      process.platform === "darwin"
        ? join(dir.path, "Library")
        : process.platform === "win32"
          ? join(dir.path, "appdata")
          : join(dir.path, "xdg");
    const directory = join(home, "autojump");
    mkdirSync(directory, { recursive: true });
    return join(directory, "autojump.txt");
  }

  test("normalises the rank through a sigmoid and zeroes last_accessed", () => {
    writeFileSync(autojumpFile(), "10.0\t/tmp/a\n-4\t/tmp/b\n");

    expect(collect(new Autojump().dirs()).dirs).toEqual([
      { path: "/tmp/a", rank: 1 / (1 + Math.exp(-10)), lastAccessed: 0 },
      { path: "/tmp/b", rank: 1 / (1 + Math.exp(4)), lastAccessed: 0 },
    ]);
  });

  test("reports a bad rank and a missing tab separately", () => {
    const path = autojumpFile();
    writeFileSync(path, "nope\t/tmp/c\nnotab\n");

    expect(collect(new Autojump().dirs()).errors).toEqual([
      `${path}:1: invalid rank: nope: invalid float literal`,
      `${path}:2: invalid entry: notab`,
    ]);
  });

  test("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
    if (process.platform !== "linux") {
      return;
    }
    process.env["HOME"] = dir.path;
    delete process.env["XDG_DATA_HOME"];
    const directory = join(dir.path, ".local", "share", "autojump");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "autojump.txt"), "1\t/tmp/a\n");
    expect(collect(new Autojump().dirs()).dirs).toHaveLength(1);
  });
});

describe("import atuin", () => {
  /**
   * atuin is a subprocess, so a stub on `PATH` stands in for it. The stub also
   * records the argv it was given: the `--format`/`--print0` pair is what makes
   * the output parseable, so it is part of the contract.
   */
  function stubAtuin(stdout: string, exitCode = 0): string {
    const bin = join(dir.path, "bin");
    mkdirSync(bin, { recursive: true });
    // The payload goes in a file rather than the script, so NUL separators
    // survive the trip through the shell.
    const payload = join(dir.path, "atuin.out");
    writeFileSync(payload, Buffer.from(stdout, "utf8"));
    const log = join(dir.path, "atuin.argv");
    const script = join(bin, "atuin");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > ${JSON.stringify(log)}`,
        `cat ${JSON.stringify(payload)}`,
        `exit ${String(exitCode)}`,
        "",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    process.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
    return log;
  }

  test("parses NUL-separated records and asks atuin for the right format", () => {
    const log = stubAtuin("2024-01-02 03:04:05\t/tmp/a\0" + "2024-01-02 03:04:06\t/tmp/b\0");
    const { dirs, errors } = collect(new Atuin().dirs());

    expect(errors).toEqual([]);
    expect(dirs).toEqual([
      { path: "/tmp/a", rank: 1, lastAccessed: Date.UTC(2024, 0, 2, 3, 4, 5) / 1000 },
      { path: "/tmp/b", rank: 1, lastAccessed: Date.UTC(2024, 0, 2, 3, 4, 6) / 1000 },
    ]);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
      "history",
      "list",
      "--format={time}\t{directory}",
      "--print0",
    ]);
  });

  test("collapses consecutive records for the same directory", () => {
    stubAtuin(
      "2024-01-02 03:04:05\t/tmp/a\0" +
        "2024-01-02 03:04:06\t/tmp/a\0" +
        "2024-01-02 03:04:07\t/tmp/b\0" +
        "2024-01-02 03:04:08\t/tmp/a\0",
    );
    expect(collect(new Atuin().dirs()).dirs.map((d) => (d as { path: string }).path)).toEqual([
      "/tmp/a",
      "/tmp/b",
      "/tmp/a",
    ]);
  });

  test("reports a malformed record by line number, without a file path", () => {
    stubAtuin("notab\0" + "9999-99-99 00:00:00\t/tmp/b\0" + "2024-01-02 03:04:05\t/tmp/c\0");
    const { dirs, errors } = collect(new Atuin().dirs());
    expect(dirs).toHaveLength(1);
    expect(errors).toEqual([
      "line 1: invalid entry: notab",
      `line 2: invalid timestamp: "9999-99-99 00:00:00": the 'day' component could not be parsed`,
    ]);
  });

  test("timestamps are read as UTC, and a bad date is rejected", () => {
    stubAtuin("2024-02-30 00:00:00\t/tmp/a\0" + "1970-01-01 00:00:01\t/tmp/b\0");
    const { dirs, errors } = collect(new Atuin().dirs());
    expect(dirs).toEqual([{ path: "/tmp/b", rank: 1, lastAccessed: 1 }]);
    expect(errors).toHaveLength(1);
  });

  test("a missing atuin aborts the import with the original's wording", () => {
    process.env["PATH"] = join(dir.path, "empty-bin");
    expect(() => collect(new Atuin().dirs())).toThrow(
      "failed to run `atuin`; is it installed and on PATH?",
    );
  });
});
