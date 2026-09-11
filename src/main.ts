#!/usr/bin/env node
/**
 * zoxide's entry point.
 *
 * Node 22.18+ runs this file directly: type annotations are stripped at load
 * time, so `src/main.ts` really is the installed executable, exactly as
 * `src/main.rs` compiled to one.
 */

import { realpathSync } from "node:fs";

import { formatDebug } from "./deps/anyhow.ts";
import { binNameFrom, ClapError, parse } from "./deps/clap.ts";
import { CMD, fromMatches } from "./cmd/cmd.ts";
import { run } from "./cmd/index.ts";
import { writeStderr, writeStdout } from "./cmd/io.ts";
import { SilentExit } from "./error.ts";

export async function main(argv: readonly string[], argv0: string): Promise<number> {
  try {
    await run(fromMatches(parse(CMD, argv, binNameFrom(argv0))));
    return 0;
  } catch (error) {
    if (error instanceof ClapError) {
      (error.useStderr ? writeStderr : writeStdout)(error.toString());
      return error.exitCode;
    }
    if (error instanceof SilentExit) {
      return error.code;
    }
    writeStderr(`zoxide: ${formatDebug(error)}\n`);
    return 1;
  }
}

/**
 * Run only when this file *is* the program, not when a test imports it. The
 * comparison resolves symlinks because `npm install --global` puts a link in
 * `bin/` that points at this file.
 */
function isEntryPoint(argv1: string): boolean {
  try {
    return realpathSync(argv1) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

const entry = process.argv[1];
if (entry !== undefined && isEntryPoint(entry)) {
  process.exitCode = await main(process.argv.slice(2), entry);
}
