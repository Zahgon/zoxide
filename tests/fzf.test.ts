/**
 * The fzf integration: what zoxide sends the subprocess, and what it makes of
 * every exit code fzf can return.
 *
 * A stub `fzf` on `PATH` records the argv and the NUL-separated feed it was
 * given and replies with a scripted selection, so `query --interactive` and
 * `edit` can be exercised without a terminal.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CMD, fromMatches } from "../src/cmd/cmd.ts";
import { run } from "../src/cmd/index.ts";
import * as io from "../src/cmd/io.ts";
import { SilentExit } from "../src/error.ts";
import { parse } from "../src/deps/clap.ts";
import { tempdir } from "./support.ts";

let dir: { path: string; cleanup: () => void };
let out: string[];
const saved = { ...process.env };

beforeEach(() => {
  dir = tempdir();
  const dataDir = join(dir.path, "data");
  mkdirSync(dataDir);
  mkdirSync(join(dir.path, "one"));
  mkdirSync(join(dir.path, "two"));
  process.env["_ZO_DATA_DIR"] = dataDir;
  process.env["_ZO_EXCLUDE_DIRS"] = "/nonexistent";
  delete process.env["_ZO_FZF_OPTS"];
  out = [];
  vi.spyOn(io, "writeStdout").mockImplementation((text: string) => void out.push(text));
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

async function zoxide(...argv: string[]): Promise<void> {
  await run(fromMatches(parse(CMD, argv, "zoxide")));
}

interface Stub {
  argv: () => string[];
  stdin: () => string;
}

/** Puts a scripted `fzf` first on `PATH`. */
function stubFzf(selection: string, exitCode = 0): Stub {
  const bin = join(dir.path, "bin");
  mkdirSync(bin, { recursive: true });
  const argvLog = join(dir.path, "fzf.argv");
  const stdinLog = join(dir.path, "fzf.stdin");
  const payload = join(dir.path, "fzf.out");
  writeFileSync(payload, selection);

  const script = join(bin, "fzf");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
      `cat > ${JSON.stringify(stdinLog)}`,
      `cat ${JSON.stringify(payload)}`,
      `exit ${String(exitCode)}`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  process.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;

  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return {
    argv: () => read(argvLog).split("\n").filter(Boolean),
    stdin: () => read(stdinLog),
  };
}

async function seed(): Promise<void> {
  await zoxide("add", join(dir.path, "one"));
  await zoxide("add", join(dir.path, "two"));
  await zoxide("add", join(dir.path, "two"));
  out = [];
}

describe("query --interactive", () => {
  test("prints the selected path, with the score column stripped", async () => {
    await seed();
    stubFzf(`   8.0\t${join(dir.path, "two")}`);
    await zoxide("query", "-i");
    expect(out.join("")).toBe(join(dir.path, "two"));
  });

  test("--score keeps the whole selection", async () => {
    await seed();
    stubFzf(`   8.0\t${join(dir.path, "two")}`);
    await zoxide("query", "-i", "--score");
    expect(out.join("")).toBe(`   8.0\t${join(dir.path, "two")}`);
  });

  test("a selection shorter than the score column is rejected", async () => {
    await seed();
    stubFzf("abc");
    await expect(zoxide("query", "-i")).rejects.toThrow("could not read selection from fzf");
  });

  test("feeds every candidate as a NUL-terminated score/tab/path record", async () => {
    await seed();
    const stub = stubFzf(`   8.0\t${join(dir.path, "two")}`);
    await zoxide("query", "-i");
    expect(stub.stdin()).toBe(
      `   8.0\t${join(dir.path, "two")}\0   4.0\t${join(dir.path, "one")}\0`,
    );
  });

  test("passes fzf its search, layout and preview flags", async () => {
    await seed();
    const stub = stubFzf(`   8.0\t${join(dir.path, "two")}`);
    await zoxide("query", "-i");
    const argv = stub.argv();
    expect(argv.slice(0, 3)).toEqual(["--delimiter=\t", "--nth=2", "--read0"]);
    expect(argv).toContain("--exact");
    expect(argv).toContain("--no-sort");
    expect(argv).toContain("--bind=ctrl-z:ignore,btab:up,tab:down");
    expect(argv).toContain("--height=45%");
    expect(argv).toContain("--exit-0");
    if (process.platform !== "win32") {
      expect(argv).toContain("--preview-window=down,30%,sharp");
      expect(argv.some((a) => a.startsWith("--preview="))).toBe(true);
    }
  });

  test("_ZO_FZF_OPTS replaces zoxide's own flags", async () => {
    await seed();
    process.env["_ZO_FZF_OPTS"] = "--height=10";
    const stub = stubFzf(`   8.0\t${join(dir.path, "two")}`);
    await zoxide("query", "-i");
    // Only the three scripting flags remain; the rest come from the variable,
    // which fzf reads out of FZF_DEFAULT_OPTS rather than argv.
    expect(stub.argv()).toEqual(["--delimiter=\t", "--nth=2", "--read0"]);
  });

  test("--exclude drops a candidate before it reaches fzf", async () => {
    await seed();
    const stub = stubFzf(`   4.0\t${join(dir.path, "one")}`);
    await zoxide("query", "-i", "--exclude", join(dir.path, "two"));
    expect(stub.stdin()).toBe(`   4.0\t${join(dir.path, "one")}\0`);
  });

  test.each([
    [1, "no match found"],
    [2, "fzf returned an error"],
    [129, "fzf was terminated"],
    [254, "fzf was terminated"],
    [3, "fzf returned an unknown error"],
    [127, "fzf returned an unknown error"],
  ])("exit %i is reported as %s", async (code, message) => {
    await seed();
    stubFzf("", code);
    await expect(zoxide("query", "-i")).rejects.toThrow(message);
  });

  test("exit 130 is a silent exit with the same code", async () => {
    await seed();
    stubFzf("", 130);
    await expect(zoxide("query", "-i")).rejects.toBeInstanceOf(SilentExit);
    try {
      await zoxide("query", "-i");
    } catch (error) {
      expect((error as SilentExit).code).toBe(130);
    }
  });

  test("a missing fzf says so", async () => {
    await seed();
    process.env["PATH"] = join(dir.path, "empty-bin");
    await expect(zoxide("query", "-i")).rejects.toThrow("could not find fzf, is it installed?");
  });
});

describe("edit", () => {
  test("passes fzf its reload bindings, header and label", async () => {
    await seed();
    const stub = stubFzf("");
    await zoxide("edit");
    const argv = stub.argv();
    expect(argv).toContain("--border-label=  zoxide-edit  ");
    expect(argv).toContain("--color=label:bold");
    expect(argv).toContain("--padding=1,0,0,0");
    const bind = argv.find((a) => a.startsWith("--bind="));
    expect(bind).toContain("ctrl-r:reload(zoxide edit reload)");
    expect(bind).toContain("ctrl-d:reload(zoxide edit delete {2..})");
    expect(bind).toContain("ctrl-w:reload(zoxide edit increment {2..})");
    expect(bind).toContain("ctrl-s:reload(zoxide edit decrement {2..})");
    expect(bind).toContain("start:reload(zoxide edit reload)");
    expect(bind).toContain("enter:abort");
    // `edit` drives fzf entirely through `zoxide edit reload`, so it sends
    // nothing on stdin.
    expect(stub.stdin()).toBe("");
  });

  test("propagates fzf's interrupt", async () => {
    await seed();
    stubFzf("", 130);
    await expect(zoxide("edit")).rejects.toBeInstanceOf(SilentExit);
  });

  test("a missing fzf says so", async () => {
    await seed();
    process.env["PATH"] = join(dir.path, "empty-bin");
    await expect(zoxide("edit")).rejects.toThrow("could not find fzf, is it installed?");
  });
});
