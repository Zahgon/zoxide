import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InitHook, type InitShell } from "../src/cmd/cmd.ts";
import type { Opts } from "../src/shell.ts";

/**
 * A `tempfile::tempdir()` equivalent that cleans up after the test.
 *
 * The path is resolved: on macOS `os.tmpdir()` is under `/var`, which is a
 * symlink to `/private/var`, so `process.cwd()` inside the directory would not
 * match the string the test handed out.
 */
export function tempdir(): { path: string; cleanup: () => void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "zoxide-test-")));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * The `opts` template from `src/shell.rs`: the Cartesian product of
 * `cmd × hook × echo × resolve_symlinks` — 2 × 3 × 2 × 2 = 24 combinations.
 */
export const OPTS: readonly Opts[] = (() => {
  const combinations: Opts[] = [];
  for (const cmd of [null, "z"]) {
    for (const hook of [InitHook.None, InitHook.Prompt, InitHook.Pwd]) {
      for (const echo of [false, true]) {
        for (const resolveSymlinks of [false, true]) {
          combinations.push({ cmd, hook, echo, resolveSymlinks });
        }
      }
    }
  }
  return combinations;
})();

export function optsName(opts: Opts): string {
  return `cmd=${opts.cmd ?? "None"} hook=${opts.hook} echo=${String(opts.echo)} resolve_symlinks=${String(opts.resolveSymlinks)}`;
}

/**
 * Whether an external interpreter or linter is available.
 *
 * The original gates these suites behind the `nix-dev` feature and provisions
 * every tool through `shell.nix`; without that shell they are skipped rather
 * than deleted, for the same reason the original skips them.
 */
export function hasCommand(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

export interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(command: string, args: readonly string[], options: { stdin?: string; env?: Record<string, string> } = {}): Outcome {
  const result = spawnSync(command, args, {
    input: options.stdin ?? "",
    encoding: "utf8",
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    maxBuffer: 4 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export const SHELLS: readonly InitShell[] = [
  "bash",
  "elvish",
  "fish",
  "nushell",
  "posix",
  "powershell",
  "tcsh",
  "xonsh",
  "zsh",
];
