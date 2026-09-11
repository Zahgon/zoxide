/**
 * The parts of `std::io` that zoxide's observable behaviour depends on.
 *
 * Rust renders an OS error as `<strerror> (os error <errno>)`; Node renders the
 * same failure as `ENOENT: no such file or directory, open '/x'`. Since those
 * strings reach the user through `zoxide: {e:?}`, they are converted back into
 * the Rust form here rather than passed through.
 */

/** The subset of `io::ErrorKind` the original matches on. */
export const ErrorKind = {
  NotFound: "NotFound",
  PermissionDenied: "PermissionDenied",
  AlreadyExists: "AlreadyExists",
  BrokenPipe: "BrokenPipe",
  Other: "Other",
} as const;

export type ErrorKind = (typeof ErrorKind)[keyof typeof ErrorKind];

const KIND_BY_CODE: ReadonlyMap<string, ErrorKind> = new Map([
  ["ENOENT", ErrorKind.NotFound],
  ["EACCES", ErrorKind.PermissionDenied],
  ["EPERM", ErrorKind.PermissionDenied],
  ["EEXIST", ErrorKind.AlreadyExists],
  ["EPIPE", ErrorKind.BrokenPipe],
  ["ERR_STREAM_DESTROYED", ErrorKind.BrokenPipe],
]);

interface NodeSystemError {
  code?: string;
  errno?: number;
  syscall?: string;
  message?: string;
}

function asSystemError(error: unknown): NodeSystemError | null {
  return typeof error === "object" && error !== null ? error : null;
}

/** `io::Error::kind()`. */
export function errorKind(error: unknown): ErrorKind {
  const code = asSystemError(error)?.code;
  return (code === undefined ? undefined : KIND_BY_CODE.get(code)) ?? ErrorKind.Other;
}

export function isNotFound(error: unknown): boolean {
  return errorKind(error) === ErrorKind.NotFound;
}

export function isBrokenPipe(error: unknown): boolean {
  return errorKind(error) === ErrorKind.BrokenPipe;
}

/**
 * The description libc's `strerror` gives each code, which is what Rust prints.
 *
 * Node embeds the same text in a filesystem error's message, but not in a
 * `spawn`/`spawnSync` failure (`spawnSync atuin ENOENT`), so the common codes
 * are tabulated. Only codes whose text is identical on Linux and macOS are
 * listed; anything else falls back to Node's own wording.
 */
const STRERROR: ReadonlyMap<string, string> = new Map([
  ["ENOENT", "No such file or directory"],
  ["EACCES", "Permission denied"],
  ["EPERM", "Operation not permitted"],
  ["EEXIST", "File exists"],
  ["EPIPE", "Broken pipe"],
  ["EISDIR", "Is a directory"],
  ["ENOTDIR", "Not a directory"],
  ["ELOOP", "Too many levels of symbolic links"],
  ["ENAMETOOLONG", "File name too long"],
  ["ENOSPC", "No space left on device"],
  ["EROFS", "Read-only file system"],
  ["EMFILE", "Too many open files"],
  ["EXDEV", "Cross-device link"],
  ["EINVAL", "Invalid argument"],
  ["ENOMEM", "Cannot allocate memory"],
  ["ENOTEMPTY", "Directory not empty"],
]);

/**
 * `impl Display for io::Error` — `<strerror> (os error <errno>)`.
 *
 * A filesystem error's Node message is `<CODE>: <strerror>, <syscall> '<path>'`;
 * the middle is the platform's own description, only lower-cased, so it is
 * lifted out and re-capitalised. A spawn failure carries no description at all,
 * and falls back to the table above.
 */
export function displayIoError(error: unknown): string {
  const system = asSystemError(error);
  if (system?.code === undefined || system.errno === undefined) {
    return error instanceof Error ? error.message : String(error);
  }

  const message = system.message ?? "";
  let strerror: string | undefined;
  if (message.startsWith(`${system.code}: `)) {
    const afterCode = message.slice(system.code.length + 2);
    const comma = afterCode.indexOf(", ");
    strerror = comma === -1 ? afterCode : afterCode.slice(0, comma);
    strerror = strerror.charAt(0).toUpperCase() + strerror.slice(1);
  }
  strerror ??= STRERROR.get(system.code) ?? message;

  return `${strerror} (os error ${Math.abs(system.errno)})`;
}

/** Converts a Node filesystem/process error into one that renders like Rust's. */
export function ioError(error: unknown): Error {
  const converted = new Error(displayIoError(error));
  const system = asSystemError(error);
  if (system !== null) {
    Object.defineProperty(converted, "code", { value: system.code, enumerable: false });
    Object.defineProperty(converted, "errno", { value: system.errno, enumerable: false });
    Object.defineProperty(converted, "syscall", { value: system.syscall, enumerable: false });
  }
  return converted;
}
