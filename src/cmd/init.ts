import { context } from "../deps/anyhow.ts";
import * as config from "../config.ts";
import { pipeExit } from "../error.ts";
import { type Opts, SHELL_TEMPLATES } from "../shell.ts";
import type { Init } from "./cmd.ts";
import { writeStdout } from "./io.ts";

export function run(cmd: Init): void {
  const opts: Opts = {
    cmd: cmd.noCmd ? null : cmd.cmd,
    hook: cmd.hook,
    echo: config.echo(),
    resolveSymlinks: config.resolveSymlinks(),
  };

  let source: string;
  try {
    source = SHELL_TEMPLATES[cmd.shell](opts);
  } catch (error) {
    throw context(error, "could not render template");
  }

  try {
    writeStdout(`${source}\n`);
  } catch (error) {
    pipeExit(error, "stdout");
  }
}
