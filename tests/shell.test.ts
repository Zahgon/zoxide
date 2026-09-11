/**
 * The shell-integration suite of `src/shell.rs`.
 *
 * The original gates this behind `#[cfg(feature = "nix-dev")]` because it needs
 * nine shells and five linters that only `shell.nix` provides. Here each
 * interpreter is probed instead, so the suite runs whatever the machine can run
 * and skips the rest rather than dropping the assertions.
 */
import { describe, expect, test } from "vitest";

import * as shell from "../src/shell.ts";
import { hasCommand, OPTS, optsName, runCommand, tempdir } from "./support.ts";

function suite(name: string, tool: string, body: (opts: (typeof OPTS)[number]) => void): void {
  describe.skipIf(!hasCommand(tool))(name, () => {
    test.each(OPTS.map((opts) => [optsName(opts), opts] as const))("%s", (_name, opts) => {
      body(opts);
    });
  });
}

function expectClean(outcome: ReturnType<typeof runCommand>, expectStdout = ""): void {
  expect({ status: outcome.status, stderr: outcome.stderr }).toEqual({ status: 0, stderr: "" });
  expect(outcome.stdout).toBe(expectStdout);
}

suite("bash_bash", "bash", (opts) => {
  const source = shell.bash(opts);
  expectClean(runCommand("bash", ["--noprofile", "--norc", "-e", "-u", "-o", "pipefail", "-c", source]));
});

suite("bash_shellcheck", "shellcheck", (opts) => {
  expectClean(runCommand("shellcheck", ["--enable=all", "-"], { stdin: shell.bash(opts) }));
});

suite("bash_shfmt", "shfmt", (opts) => {
  const source = `${shell.bash(opts)}\n`;
  expectClean(
    runCommand("shfmt", ["--diff", "--indent=4", "--language-dialect=bash", "--simplify", "-"], { stdin: source }),
  );
});

suite("elvish_elvish", "elvish", (opts) => {
  // Filter out lines using edit:*, since those functions are only available in
  // interactive editor mode.
  const source = shell
    .elvish(opts)
    .split("\n")
    .filter((line) => !line.includes("edit:"))
    .map((line) => `${line}\n`)
    .join("");
  expectClean(runCommand("elvish", ["-c", source, "-norc"]));
});

describe("fish_no_builtin_abbr", () => {
  test.each(OPTS.map((opts) => [optsName(opts), opts] as const))("%s", (_name, opts) => {
    expect(
      shell.fish(opts).includes("builtin abbr"),
      "`builtin abbr` does not work on older versions of Fish",
    ).toBe(false);
  });
});

suite("fish_fish", "fish", (opts) => {
  const source = shell.fish(opts);
  const dir = tempdir();
  try {
    expectClean(runCommand("fish", ["--command", source, "--no-config", "--private"], { env: { HOME: dir.path } }));
  } finally {
    dir.cleanup();
  }
});

suite("fish_fishindent", "fish_indent", (opts) => {
  const source = `${shell.fish(opts)}\n`;
  const dir = tempdir();
  try {
    expectClean(runCommand("fish_indent", [], { stdin: source, env: { HOME: dir.path } }), source);
  } finally {
    dir.cleanup();
  }
});

suite("nushell_nushell", "nu", (opts) => {
  const dir = tempdir();
  try {
    const outcome = runCommand("nu", ["--commands", shell.nushell(opts)], { env: { HOME: dir.path } });
    expect({ status: outcome.status, stderr: outcome.stderr }).toEqual({ status: 0, stderr: "" });
    if (opts.hook !== "pwd") {
      expect(outcome.stdout).toBe("");
    }
  } finally {
    dir.cleanup();
  }
});

suite("posix_bash", "bash", (opts) => {
  const source = shell.posix(opts);
  const outcome = runCommand("bash", [
    "--posix",
    "--noprofile",
    "--norc",
    "-e",
    "-u",
    "-o",
    "pipefail",
    "-c",
    source,
  ]);
  expect({ status: outcome.status, stderr: outcome.stderr }).toEqual({ status: 0, stderr: "" });
  if (opts.hook !== "pwd") {
    expect(outcome.stdout).toBe("");
  }
});

suite("posix_dash", "dash", (opts) => {
  const outcome = runCommand("dash", ["-e", "-u", "-c", shell.posix(opts)]);
  expect({ status: outcome.status, stderr: outcome.stderr }).toEqual({ status: 0, stderr: "" });
  if (opts.hook !== "pwd") {
    expect(outcome.stdout).toBe("");
  }
});

suite("posix_shellcheck", "shellcheck", (opts) => {
  expectClean(runCommand("shellcheck", ["--enable=all", "-"], { stdin: shell.posix(opts) }));
});

suite("posix_shfmt", "shfmt", (opts) => {
  const source = `${shell.posix(opts)}\n`;
  expectClean(
    runCommand("shfmt", ["--diff", "--indent=4", "--language-dialect=posix", "--simplify", "-"], { stdin: source }),
  );
});

suite("powershell_pwsh", "pwsh", (opts) => {
  const source = `Set-StrictMode -Version latest\n${shell.powershell(opts)}`;
  expectClean(runCommand("pwsh", ["-NoLogo", "-NonInteractive", "-NoProfile", "-Command", source]));
});

suite("tcsh_tcsh", "tcsh", (opts) => {
  expectClean(runCommand("tcsh", ["-e", "-f", "-s"], { stdin: shell.tcsh(opts) }));
});

suite("xonsh_black", "black", (opts) => {
  const source = `${shell.xonsh(opts)}\n`;
  const outcome = runCommand("black", ["--check", "--diff", "-"], { stdin: source });
  expect(outcome.status).toBe(0);
  expect(outcome.stdout).toBe("");
});

suite("xonsh_mypy", "mypy", (opts) => {
  const outcome = runCommand("mypy", ["--command", shell.xonsh(opts), "--strict"]);
  expect({ status: outcome.status, stderr: outcome.stderr }).toEqual({ status: 0, stderr: "" });
});

suite("xonsh_pylint", "pylint", (opts) => {
  const source = `${shell.xonsh(opts)}\n`;
  const outcome = runCommand("pylint", ["--from-stdin", "--persistent=n", "zoxide"], { stdin: source });
  expect({ status: outcome.status, stderr: outcome.stderr }).toEqual({ status: 0, stderr: "" });
});

suite("xonsh_xonsh", "xonsh", (opts) => {
  const dir = tempdir();
  try {
    expectClean(runCommand("xonsh", ["-c", shell.xonsh(opts), "--no-rc"], { env: { HOME: dir.path } }));
  } finally {
    dir.cleanup();
  }
});

// ShellCheck doesn't support zsh yet: https://github.com/koalaman/shellcheck/issues/809
suite("zsh_shellcheck", "shellcheck", (opts) => {
  expectClean(runCommand("shellcheck", ["--enable=all", "-"], { stdin: shell.zsh(opts) }));
});

suite("zsh_zsh", "zsh", (opts) => {
  expectClean(
    runCommand("zsh", ["-e", "-u", "-o", "pipefail", "--no-globalrcs", "--no-rcs", "-c", shell.zsh(opts)]),
  );
});
