import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { context, toError } from "./deps/anyhow.ts";
import { ErrorKind, errorKind, ioError } from "./deps/io.ts";
import { display, type Dir, type Epoch } from "./db/dir.ts";
import { SilentExit } from "./error.ts";

export const SECOND: Epoch = 1;
export const MINUTE: Epoch = 60 * SECOND;
export const HOUR: Epoch = 60 * MINUTE;
export const DAY: Epoch = 24 * HOUR;
export const WEEK: Epoch = 7 * DAY;
export const MONTH: Epoch = 30 * DAY;

const ERR_FZF_NOT_FOUND = "could not find fzf, is it installed?";

/** Builder for the `fzf` subprocess, matching `util::Fzf`. */
export class Fzf {
  #args: string[];
  #env: Record<string, string>;

  private constructor() {
    this.#args = [
      // Search mode
      "--delimiter=\t",
      "--nth=2",
      // Scripting
      "--read0",
    ];
    this.#env = {};
  }

  static new(): Fzf {
    // TODO: check version of fzf here.
    return new Fzf();
  }

  enablePreview(): Fzf {
    // Previews are only supported on UNIX.
    if (process.platform === "win32") {
      return this;
    }

    return this.args([
      // Non-POSIX args are only available on certain operating systems.
      process.platform === "linux"
        ? String.raw`--preview=\command -p ls -Cp --color=always --group-directories-first {2..}`
        : String.raw`--preview=\command -p ls -Cp {2..}`,
      // Rounded edges don't display correctly on some terminals.
      "--preview-window=down,30%,sharp",
    ]).envs({
      // Enables colorized `ls` output on macOS / FreeBSD.
      CLICOLOR: "1",
      // Forces colorized `ls` output when the output is not a TTY (like in
      // fzf's preview window) on macOS / FreeBSD.
      CLICOLOR_FORCE: "1",
      // Ensures that the preview command is run in a POSIX-compliant shell,
      // regardless of what shell the user has selected.
      SHELL: "sh",
    });
  }

  args(args: readonly string[]): Fzf {
    this.#args = [...this.#args, ...args];
    return this;
  }

  env(key: string, value: string): Fzf {
    this.#env[key] = value;
    return this;
  }

  envs(vars: Readonly<Record<string, string>>): Fzf {
    this.#env = { ...this.#env, ...vars };
    return this;
  }

  spawn(): FzfChild {
    const child: FzfProcess = spawn("fzf", this.#args, {
      env: { ...process.env, ...this.#env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    return new FzfChild(child);
  }
}

/** `fzf` is spawned with a piped stdin and stdout, and an inherited stderr. */
type FzfProcess = ChildProcess & {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
};

export class FzfChild {
  readonly #child: FzfProcess;
  readonly #stdout: Promise<string>;
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #spawnError: unknown = null;
  #stdinClosed = false;

  constructor(child: FzfProcess) {
    this.#child = child;

    // A missing binary is reported asynchronously by Node, so the failure is
    // captured here and surfaced from the first write or wait.
    child.on("error", (error) => {
      this.#spawnError = error;
    });
    // fzf closes its stdin as soon as the user picks an entry; that is an
    // expected end to the feed, not a crash.
    child.stdin.on("error", () => {
      this.#stdinClosed = true;
    });

    this.#stdout = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stdout.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      child.stdout.on("error", reject);
    });

    this.#exit = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
      child.on("error", () => resolve({ code: null, signal: null }));
    });
  }

  /** Feeds one entry to fzf; a broken pipe means the user has already chosen. */
  async write(dir: Dir, now: Epoch): Promise<string | null> {
    const line = `${display(dir).withScore(now).withSeparator("\t").toString()}\0`;
    if (this.#spawnError !== null) {
      throw this.#spawnFailure();
    }
    if (this.#stdinClosed) {
      return this.wait();
    }

    try {
      await new Promise<void>((resolve, reject) => {
        this.#child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      if (this.#spawnError !== null) {
        throw this.#spawnFailure();
      }
      if (errorKind(error) === ErrorKind.BrokenPipe) {
        return this.wait();
      }
      throw context(ioError(error), "could not write to fzf");
    }
    return null;
  }

  async wait(): Promise<string> {
    if (this.#spawnError !== null) {
      throw this.#spawnFailure();
    }

    // Drop stdin to prevent deadlock.
    this.#child.stdin.end();

    const output = await this.#stdout;
    const { code, signal } = await this.#exit;

    if (this.#spawnError !== null) {
      throw this.#spawnFailure();
    }
    if (signal !== null || code === null) {
      throw new Error("fzf was terminated");
    }
    switch (code) {
      case 0:
        return output;
      case 1:
        throw new Error("no match found");
      case 2:
        throw new Error("fzf returned an error");
      case 130:
        throw new SilentExit(130);
      default:
        throw code >= 128 && code <= 254
          ? new Error("fzf was terminated")
          : new Error("fzf returned an unknown error");
    }
  }

  #spawnFailure(): Error {
    return errorKind(this.#spawnError) === ErrorKind.NotFound
      ? new Error(ERR_FZF_NOT_FOUND)
      : context(ioError(this.#spawnError), "could not launch fzf");
  }
}

/** Similar to `fs.writeFileSync`, but atomic (best effort on Windows). */
export function write(target: string, contents: Buffer): void {
  const dir = path.dirname(target);

  // Create a tmpfile.
  const { fd, path: tmpPath } = tmpfile(dir);
  try {
    // Write to the tmpfile.
    try {
      fs.ftruncateSync(fd, contents.length);
    } catch {
      // `set_len` failures are ignored by the original too.
    }
    try {
      fs.writeSync(fd, contents);
    } catch (error) {
      throw context(ioError(error), `could not write to file: ${tmpPath}`);
    }

    // Set the owner of the tmpfile (UNIX only).
    if (process.platform !== "win32") {
      try {
        const stats = fs.statSync(target);
        fs.fchownSync(fd, stats.uid, stats.gid);
      } catch {
        // The target may not exist yet, and chown may not be permitted.
      }
    }

    // Close and rename the tmpfile. In some cases, errors from the last
    // write() are reported only on close(), so fsync explicitly first.
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      throw context(ioError(error), `could not sync writes to file: ${tmpPath}`);
    }
    fs.closeSync(fd);
    rename(tmpPath, target);
  } catch (error) {
    // In case of an error, delete the tmpfile.
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed on the success path.
    }
    try {
      fs.rmSync(tmpPath);
    } catch {
      // Nothing more can be done about a tmpfile that will not go away.
    }
    throw error;
  }
}

const TMP_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Atomically create a tmpfile in the given directory. */
function tmpfile(dir: string): { fd: number; path: string } {
  const MAX_ATTEMPTS = 5;
  const TMP_NAME_LEN = 16;

  let attempts = 0;
  for (;;) {
    attempts += 1;

    // Generate a random name for the tmpfile.
    let name = "tmp_";
    while (name.length < TMP_NAME_LEN) {
      name += TMP_ALPHABET[Math.floor(Math.random() * TMP_ALPHABET.length)];
    }
    const tmpPath = path.join(dir, name);

    try {
      // Atomically create the tmpfile.
      return { fd: fs.openSync(tmpPath, "wx", 0o666), path: tmpPath };
    } catch (error) {
      if (errorKind(error) === ErrorKind.AlreadyExists && attempts < MAX_ATTEMPTS) {
        continue;
      }
      throw context(ioError(error), `could not create file: ${tmpPath}`);
    }
  }
}

/** Similar to `fs.renameSync`, but with retries on Windows. */
function rename(from: string, to: string): void {
  const MAX_ATTEMPTS = process.platform === "win32" ? 5 : 1;
  let attempts = 0;

  for (;;) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (errorKind(error) === ErrorKind.PermissionDenied && attempts < MAX_ATTEMPTS) {
        attempts += 1;
        continue;
      }
      throw context(ioError(error), `could not rename file: ${from} -> ${to}`);
    }
  }
}

export function canonicalize(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    throw context(ioError(error), `could not resolve path: ${target}`);
  }
}

export function currentDir(): string {
  try {
    return process.cwd();
  } catch (error) {
    throw context(toError(error), "could not get current directory");
  }
}

export function currentTime(): Epoch {
  return Math.floor(Date.now() / 1000);
}

/**
 * `util::path_to_str`. Node has already decoded the platform's bytes into a
 * JavaScript string by the time a path reaches here, so the original's
 * "invalid unicode in path" branch has no counterpart to detect.
 */
export function pathToStr(target: string): string {
  return target;
}

/**
 * Rust's `Path::components`, which normalises away repeated separators,
 * trailing separators, and interior `.` — but keeps a leading one.
 */
export function components(target: string): string[] {
  const parts: string[] = [];
  let rest = target;

  if (process.platform === "win32") {
    const parsed = path.win32.parse(target);
    if (parsed.root !== "") {
      parts.push(parsed.root);
      rest = target.slice(parsed.root.length);
    }
  } else if (rest.startsWith("/")) {
    parts.push("/");
    rest = rest.slice(1);
  }

  const separator = process.platform === "win32" ? /[\\/]+/ : /\/+/;
  const segments = rest.split(separator).filter((segment) => segment !== "");
  for (const [index, segment] of segments.entries()) {
    if (segment === "." && !(index === 0 && parts.length === 0)) {
      continue;
    }
    parts.push(segment);
  }
  return parts;
}

/** Rust's `Path::starts_with`, which compares whole components. */
export function pathStartsWith(target: string, base: string): boolean {
  const baseParts = components(base);
  const targetParts = components(target);
  if (baseParts.length > targetParts.length) {
    return false;
  }
  return baseParts.every((part, index) => targetParts[index] === part);
}

export function isSeparator(char: string): boolean {
  return char === "/" || (process.platform === "win32" && char === "\\");
}

/**
 * Returns the absolute version of a path. Like `fs.realpathSync`, but doesn't
 * resolve symlinks.
 */
export function resolvePath(target: string): string {
  const parts = components(target);
  const stack: string[] = [];
  let index = 0;

  // Initialise the root: an absolute path keeps its own, a relative one is
  // resolved against the current directory.
  const first = parts[0];
  if (first !== undefined && isRootComponent(first)) {
    stack.push(first);
    index = 1;
  } else {
    stack.push(...components(currentDir()));
  }

  for (; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      // `..` never escapes the root.
      const last = stack[stack.length - 1];
      if (last === undefined || !isRootComponent(last)) {
        stack.pop();
      }
      continue;
    }
    stack.push(part);
  }

  return joinComponents(stack);
}

function isRootComponent(part: string): boolean {
  return process.platform === "win32"
    ? /^(?:[A-Za-z]:[\\/]?|[\\/])$/.test(part)
    : part === "/";
}

function joinComponents(parts: readonly string[]): string {
  const [head, ...tail] = parts;
  if (head === undefined) {
    return "";
  }
  if (!isRootComponent(head)) {
    return parts.join(path.sep);
  }
  const separator = /[\\/]$/.test(head) ? "" : path.sep;
  return tail.length === 0 ? head : head + separator + tail.join(path.sep);
}

/** Convert a string to lowercase, with a fast path for ASCII strings. */
export function toLowercase(text: string): string {
  return isAscii(text) ? asciiLowercase(text) : text.toLowerCase();
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

function asciiLowercase(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : text[index];
  }
  return out;
}
