import { context } from "./deps/anyhow.ts";
import { ErrorKind, errorKind, ioError } from "./deps/io.ts";

/** Custom error type for early exit. */
export class SilentExit extends Error {
  readonly code: number;

  constructor(code: number) {
    // `impl Display for SilentExit` writes nothing.
    super("");
    this.code = code;
  }
}

/**
 * `BrokenPipeHandler::pipe_exit` — a closed downstream pipe is a clean exit,
 * anything else is an error naming the device that could not be written to.
 */
export function pipeExit(error: unknown, device: string): never {
  if (errorKind(error) === ErrorKind.BrokenPipe) {
    throw new SilentExit(0);
  }
  throw context(ioError(error), `could not write to ${device}`);
}
