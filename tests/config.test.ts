/**
 * The environment-variable surface: `_ZO_DATA_DIR`, `_ZO_ECHO`,
 * `_ZO_EXCLUDE_DIRS`, `_ZO_FZF_OPTS`, `_ZO_MAXAGE` and `_ZO_RESOLVE_SYMLINKS`.
 *
 * Every message here is quoted from the original — these strings reach the user
 * through `zoxide: …` and are part of the contract.
 */
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import * as config from "../src/config.ts";
import { formatAlternate } from "../src/deps/anyhow.ts";
import { tempdir } from "./support.ts";

const VARS = [
  "_ZO_DATA_DIR",
  "_ZO_ECHO",
  "_ZO_EXCLUDE_DIRS",
  "_ZO_FZF_OPTS",
  "_ZO_MAXAGE",
  "_ZO_RESOLVE_SYMLINKS",
  "XDG_DATA_HOME",
  "HOME",
] as const;

let dir: { path: string; cleanup: () => void };
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = tempdir();
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) {
    delete process.env[name];
  }
  process.env["HOME"] = dir.path;
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  dir.cleanup();
});

describe("dataDir", () => {
  test("honours an absolute _ZO_DATA_DIR", () => {
    process.env["_ZO_DATA_DIR"] = join(dir.path, "data");
    expect(config.dataDir()).toBe(join(dir.path, "data"));
  });

  test("rejects a relative one", () => {
    process.env["_ZO_DATA_DIR"] = "relative/path";
    expect(() => config.dataDir()).toThrow("_ZO_DATA_DIR must be an absolute path");
  });

  test("falls back to the platform data directory with zoxide appended", () => {
    const expected =
      process.platform === "darwin"
        ? join(dir.path, "Library", "Application Support", "zoxide")
        : join(dir.path, ".local", "share", "zoxide");
    if (process.platform === "win32") {
      return;
    }
    expect(config.dataDir()).toBe(expected);
  });

  test("honours XDG_DATA_HOME where the platform uses it", () => {
    if (process.platform !== "linux") {
      return;
    }
    process.env["XDG_DATA_HOME"] = join(dir.path, "xdg");
    expect(config.dataDir()).toBe(join(dir.path, "xdg", "zoxide"));
  });
});

describe("flags", () => {
  test.each([
    ["1", true],
    ["0", false],
    ["", false],
    ["true", false],
    ["11", false],
  ])("_ZO_ECHO=%j => %s", (value, expected) => {
    process.env["_ZO_ECHO"] = value;
    expect(config.echo()).toBe(expected);
  });

  test("unset means off", () => {
    expect(config.echo()).toBe(false);
    expect(config.resolveSymlinks()).toBe(false);
  });

  test("_ZO_RESOLVE_SYMLINKS only reacts to exactly 1", () => {
    process.env["_ZO_RESOLVE_SYMLINKS"] = "1";
    expect(config.resolveSymlinks()).toBe(true);
    process.env["_ZO_RESOLVE_SYMLINKS"] = "yes";
    expect(config.resolveSymlinks()).toBe(false);
  });

  test("_ZO_FZF_OPTS is passed through verbatim, empty included", () => {
    expect(config.fzfOpts()).toBeUndefined();
    process.env["_ZO_FZF_OPTS"] = "";
    expect(config.fzfOpts()).toBe("");
    process.env["_ZO_FZF_OPTS"] = "--height=10 --reverse";
    expect(config.fzfOpts()).toBe("--height=10 --reverse");
  });
});

describe("maxage", () => {
  test("defaults to 10000", () => {
    expect(config.maxage()).toBe(10_000);
  });

  test.each([["0", 0], ["1", 1], ["4294967295", 4_294_967_295], ["+7", 7]])(
    "parses %s",
    (value, expected) => {
      process.env["_ZO_MAXAGE"] = value;
      expect(config.maxage()).toBe(expected);
    },
  );

  test.each([
    ["abc", "invalid digit found in string"],
    ["", "cannot parse integer from empty string"],
    ["-1", "invalid digit found in string"],
    ["1.5", "invalid digit found in string"],
    ["4294967296", "number too large to fit in target type"],
  ])("rejects %j", (value, cause) => {
    process.env["_ZO_MAXAGE"] = value;
    expect(() => config.maxage()).toThrow(`unable to parse _ZO_MAXAGE as integer: ${value}`);
    try {
      config.maxage();
    } catch (error) {
      expect(formatAlternate(error)).toBe(`unable to parse _ZO_MAXAGE as integer: ${value}: ${cause}`);
    }
  });
});

describe("excludeDirs", () => {
  test("defaults to the home directory, glob-escaped", () => {
    process.env["HOME"] = join(dir.path, "u[1]");
    const patterns = config.excludeDirs();
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.matches(join(dir.path, "u[1]"))).toBe(true);
    expect(patterns[0]!.matches(join(dir.path, "uX"))).toBe(false);
  });

  test("splits on the platform PATH separator", () => {
    process.env["_ZO_EXCLUDE_DIRS"] = ["/a/*", "/b/?", "/c"].join(delimiter);
    const patterns = config.excludeDirs();
    expect(patterns.map((p) => p.original)).toEqual(["/a/*", "/b/?", "/c"]);
    expect(patterns[0]!.matches("/a/x")).toBe(true);
    expect(patterns[1]!.matches("/b/xy")).toBe(false);
  });

  test("an empty value yields a single empty pattern, matching nothing useful", () => {
    process.env["_ZO_EXCLUDE_DIRS"] = "";
    const patterns = config.excludeDirs();
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.matches("/anything")).toBe(false);
  });

  test("reports a bad glob with the offending pattern", () => {
    process.env["_ZO_EXCLUDE_DIRS"] = "a/***/b";
    expect(() => config.excludeDirs()).toThrow("invalid glob in _ZO_EXCLUDE_DIRS: a/***/b");
    try {
      config.excludeDirs();
    } catch (error) {
      expect(formatAlternate(error)).toBe(
        "invalid glob in _ZO_EXCLUDE_DIRS: a/***/b: Pattern syntax error near position 4: " +
          "wildcards are either regular `*` or recursive `**`",
      );
    }
  });
});
