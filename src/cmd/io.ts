import { writeSync } from "node:fs";

/**
 * A blocking write to a file descriptor, which is what `io::stdout()` gives the
 * original. Node's `process.stdout` buffers when it is a pipe, so a partial
 * write followed by `process.exit` would silently truncate; `writeSync` on the
 * descriptor has the same semantics as Rust's and surfaces `EPIPE` where the
 * original sees `BrokenPipe`.
 */
export function writeFd(fd: number, text: string): void {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

export function writeStdout(text: string): void {
  writeFd(1, text);
}

export function writeStderr(text: string): void {
  writeFd(2, text);
}
