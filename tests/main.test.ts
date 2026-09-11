/**
 * `main` — how a command's outcome becomes an exit code and which stream the
 * result lands on.
 *
 * The mapping is `src/main.rs`'s: success is 0, a `SilentExit` carries its own
 * code, a clap error prints itself and exits 2 (or 0 for `--help`), and anything
 * else prints `zoxide: {e:?}` and exits 1.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import * as io from "../src/cmd/io.ts";
import { main } from "../src/main.ts";
import { tempdir } from "./support.ts";

let dir: { path: string; cleanup: () => void };
let out: string[];
let err: string[];
const saved = { ...process.env };

beforeEach(() => {
  dir = tempdir();
  const dataDir = join(dir.path, "data");
  mkdirSync(dataDir);
  mkdirSync(join(dir.path, "one"));
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

const stdout = (): string => out.join("");
const stderr = (): string => err.join("");

describe("main", () => {
  test("a successful command exits 0 and writes to stdout", async () => {
    expect(await main(["add", join(dir.path, "one")], "/usr/bin/zoxide")).toBe(0);
    expect(stderr()).toBe("");
    expect(await main(["query", "--list"], "/usr/bin/zoxide")).toBe(0);
    expect(stdout()).toBe(`${join(dir.path, "one")}\n`);
  });

  test("--help exits 0 on stdout; no arguments prints the same text to stderr and exits 2", async () => {
    expect(await main(["--help"], "/usr/bin/zoxide")).toBe(0);
    const help = stdout();
    expect(help.startsWith("zoxide 0.10.0\n")).toBe(true);
    expect(stderr()).toBe("");

    out = [];
    expect(await main([], "/usr/bin/zoxide")).toBe(2);
    expect(stdout()).toBe("");
    expect(stderr()).toBe(help);
  });

  test("a parse error exits 2 on stderr", async () => {
    expect(await main(["nope"], "/usr/bin/zoxide")).toBe(2);
    expect(stderr()).toBe(
      "error: unrecognized subcommand 'nope'\n\nUsage: zoxide <COMMAND>\n\n" +
        "For more information, try '--help'.\n",
    );
  });

  test("a runtime error exits 1 and is rendered as `zoxide: {e:?}`", async () => {
    expect(await main(["query", "nothing-here"], "/usr/bin/zoxide")).toBe(1);
    expect(stderr()).toBe("zoxide: no match found\n");
  });

  test("a runtime error with a cause prints the Caused by block", async () => {
    process.env["_ZO_MAXAGE"] = "abc";
    expect(await main(["add", join(dir.path, "one")], "/usr/bin/zoxide")).toBe(1);
    expect(stderr()).toBe(
      "zoxide: unable to parse _ZO_MAXAGE as integer: abc\n\n" +
        "Caused by:\n    invalid digit found in string\n",
    );
  });

  test("the Usage line follows the name the program was invoked under", async () => {
    expect(await main(["nope"], "/tmp/qcapp")).toBe(2);
    expect(stderr()).toContain("Usage: qcapp <COMMAND>");
    err = [];
    // The header keeps the crate name whatever the binary is called.
    expect(await main(["--version"], "/tmp/qcapp")).toBe(0);
    expect(stdout()).toBe("zoxide 0.10.0\n");
  });

  test("a corrupt database is reported, not swallowed", async () => {
    writeFileSync(join(dir.path, "data", "db.zo"), Buffer.from([2, 0, 0, 0]));
    expect(await main(["query", "--list"], "/usr/bin/zoxide")).toBe(1);
    expect(stderr()).toBe("zoxide: unsupported version (got 2, supports 3)\n");
  });
});
