/**
 * Test the checked-in shell completions, the counterpart of
 * `tests/completions.rs`.
 *
 * The original generates `contrib/completions/*` from the clap command tree in
 * `build.rs` and then feeds the result to each shell. The generators are Rust
 * build-dependencies with no target counterpart, so the generated files are
 * carried over unchanged and these tests keep checking that each one still
 * loads — plus, since nothing regenerates them any more, that they still
 * describe the CLI this port implements.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { CMD } from "../src/cmd/cmd.ts";
import { hasCommand, runCommand, tempdir } from "./support.ts";

const COMPLETIONS = fileURLToPath(new URL("../contrib/completions/", import.meta.url));

function completion(name: string): string {
  return readFileSync(`${COMPLETIONS}${name}`, "utf8");
}

describe.skipIf(!hasCommand("bash"))("completions_bash", () => {
  test("loads", () => {
    const outcome = runCommand("bash", ["--noprofile", "--norc", "-c", completion("zoxide.bash")]);
    expect(outcome).toEqual({ status: 0, stdout: "", stderr: "" });
  });
});

// Elvish: the completions file uses editor commands to add completions to the
// shell. However, Elvish does not support running editor commands from a
// script, so we can't create a test for this. See: https://github.com/elves/elvish/issues/1299

describe.skipIf(!hasCommand("fish"))("completions_fish", () => {
  test("loads", () => {
    const dir = tempdir();
    try {
      const outcome = runCommand("fish", ["--command", completion("zoxide.fish"), "--private"], {
        env: { HOME: dir.path },
      });
      expect(outcome).toEqual({ status: 0, stdout: "", stderr: "" });
    } finally {
      dir.cleanup();
    }
  });
});

describe.skipIf(!hasCommand("pwsh"))("completions_powershell", () => {
  test("loads", () => {
    const outcome = runCommand("pwsh", [
      "-NoLogo",
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      completion("_zoxide.ps1"),
    ]);
    expect(outcome).toEqual({ status: 0, stdout: "", stderr: "" });
  });
});

describe.skipIf(!hasCommand("zsh"))("completions_zsh", () => {
  test("loads", () => {
    const source = `
    set -eu
    completions='./contrib/completions'
    test -d "$completions"
    fpath=("$completions" $fpath)
    autoload -Uz compinit
    compinit -u
    `;
    const outcome = runCommand("zsh", ["-c", source, "--no-rcs"]);
    expect(outcome).toEqual({ status: 0, stdout: "", stderr: "" });
  });
});

describe("completions describe the current CLI", () => {
  const files = ["zoxide.bash", "_zoxide", "zoxide.fish", "zoxide.elv", "zoxide.nu", "_zoxide.ps1", "zoxide.ts"];

  // Each generator spells a flag differently (`--score`, `-l score`, `'score'`),
  // so the bare name is what every format has in common — matched on word
  // boundaries, so `score` cannot be satisfied by an unrelated `scoreboard`.
  // Word boundaries are on word characters only: `--score` must match (the
  // leading `-` is not part of the name) while `scoreboard` must not.
  const mentions = (source: string, name: string): boolean =>
    new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`).test(source);

  test.each(files)("%s mentions every subcommand and flag", (file) => {
    const source = completion(file);
    const missing: string[] = [];
    for (const sub of CMD.subcommands ?? []) {
      if (!mentions(source, sub.name)) {
        missing.push(sub.name);
      }
      for (const arg of sub.args ?? []) {
        if (!mentions(source, arg.long)) {
          missing.push(`--${arg.long}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("the word-boundary check accepts a real flag and rejects a near miss", () => {
    expect(mentions("complete --score", "score")).toBe(true);
    expect(mentions("complete -l score", "score")).toBe(true);
    expect(mentions("complete 'score'", "score")).toBe(true);
    expect(mentions("complete --scoreboard", "score")).toBe(false);
    expect(mentions("complete rescore", "score")).toBe(false);
    expect(mentions("complete --base-dir", "base-dir")).toBe(true);
    expect(mentions("complete --base-directory", "base-dir")).toBe(false);
  });
});
