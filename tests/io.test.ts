/**
 * The process-I/O seam: blocking writes to a descriptor, the broken-pipe exit,
 * and the translation of Node's error objects into the strings Rust prints.
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { writeFd, writeStderr, writeStdout } from "../src/cmd/io.ts";
import { displayIoError, ErrorKind, errorKind, ioError, isBrokenPipe, isNotFound } from "../src/deps/io.ts";
import { SilentExit, pipeExit } from "../src/error.ts";
import { tempdir } from "./support.ts";

describe("writeFd", () => {
  test("writes the whole buffer, in UTF-8", () => {
    const dir = tempdir();
    try {
      const path = join(dir.path, "out");
      const fd = openSync(path, "w");
      try {
        writeFd(fd, "héllo\n");
        writeFd(fd, "wörld");
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(path, "utf8")).toBe("héllo\nwörld");
      expect(readFileSync(path).length).toBe(Buffer.byteLength("héllo\nwörld", "utf8"));
    } finally {
      dir.cleanup();
    }
  });

  test("an empty write is a no-op", () => {
    const dir = tempdir();
    try {
      const path = join(dir.path, "out");
      const fd = openSync(path, "w");
      writeFd(fd, "");
      closeSync(fd);
      expect(readFileSync(path, "utf8")).toBe("");
    } finally {
      dir.cleanup();
    }
  });

  test("writeStdout and writeStderr reach descriptors 1 and 2", () => {
    // Asserted from outside the process: an in-process call could only be
    // checked for "did not throw", which would pass even if both went to the
    // same descriptor, or to neither.
    const dir = tempdir();
    try {
      const module = fileURLToPath(new URL("../src/cmd/io.ts", import.meta.url));
      const probe = join(dir.path, "probe.ts");
      writeFileSync(
        probe,
        `import { writeStdout, writeStderr } from ${JSON.stringify(module)};\n` +
          `writeStdout("to-stdout-\u00e9");\n` +
          `writeStderr("to-stderr-\u00e9");\n`,
      );
      const result = spawnSync(process.execPath, [probe], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("to-stdout-é");
      expect(result.stderr).toBe("to-stderr-é");

      // Also drive both in-process, so the wrappers are exercised under
      // instrumentation. An empty write reaches no descriptor, which is why
      // the assertions above are made from outside instead.
      expect(() => {
        writeStdout("");
        writeStderr("");
      }).not.toThrow();
    } finally {
      dir.cleanup();
    }
  });
});

describe("pipeExit", () => {
  test("a broken pipe is a silent, successful exit", () => {
    const broken = Object.assign(new Error("EPIPE: broken pipe, write"), {
      code: "EPIPE",
      errno: -32,
      syscall: "write",
    });
    try {
      pipeExit(broken, "stdout");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SilentExit);
      expect((error as SilentExit).code).toBe(0);
      // `impl Display for SilentExit` writes nothing.
      expect((error as SilentExit).message).toBe("");
    }
  });

  test("any other write failure names the device", () => {
    const denied = Object.assign(new Error("EACCES: permission denied, write"), {
      code: "EACCES",
      errno: -13,
      syscall: "write",
    });
    expect(() => pipeExit(denied, "stdout")).toThrow("could not write to stdout");
    try {
      pipeExit(denied, "fzf");
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toBe("Permission denied (os error 13)");
    }
  });
});

describe("io error translation", () => {
  const of = (code: string, errno: number, message: string, syscall = "open"): Error =>
    Object.assign(new Error(message), { code, errno, syscall });

  test.each([
    ["ENOENT", ErrorKind.NotFound],
    ["EACCES", ErrorKind.PermissionDenied],
    ["EPERM", ErrorKind.PermissionDenied],
    ["EEXIST", ErrorKind.AlreadyExists],
    ["EPIPE", ErrorKind.BrokenPipe],
    ["ERR_STREAM_DESTROYED", ErrorKind.BrokenPipe],
    ["EIO", ErrorKind.Other],
  ])("%s maps to %s", (code, kind) => {
    expect(errorKind(of(code, -1, `${code}: something`))).toBe(kind);
  });

  test("an unrecognised value is Other", () => {
    expect(errorKind(new Error("plain"))).toBe(ErrorKind.Other);
    expect(errorKind(null)).toBe(ErrorKind.Other);
    expect(isNotFound(of("ENOENT", -2, "ENOENT: x"))).toBe(true);
    expect(isNotFound(new Error("plain"))).toBe(false);
    expect(isBrokenPipe(of("EPIPE", -32, "EPIPE: x"))).toBe(true);
    expect(isBrokenPipe(of("ENOENT", -2, "ENOENT: x"))).toBe(false);
  });

  test("a filesystem error keeps the platform's own description", () => {
    expect(displayIoError(of("ENOENT", -2, "ENOENT: no such file or directory, open '/x'"))).toBe(
      "No such file or directory (os error 2)",
    );
    expect(displayIoError(of("EACCES", -13, "EACCES: permission denied, open '/x'"))).toBe(
      "Permission denied (os error 13)",
    );
  });

  test("a spawn failure carries no description, so the table supplies one", () => {
    const spawnFailure = Object.assign(new Error("spawnSync atuin ENOENT"), {
      code: "ENOENT",
      errno: -2,
      syscall: "spawnSync atuin",
    });
    expect(displayIoError(spawnFailure)).toBe("No such file or directory (os error 2)");
  });

  test("a non-system error passes through unchanged", () => {
    expect(displayIoError(new Error("something else"))).toBe("something else");
    expect(displayIoError("a string")).toBe("a string");
  });

  test("ioError preserves the code for later matching", () => {
    const converted = ioError(of("ENOENT", -2, "ENOENT: no such file or directory, open '/x'"));
    expect(converted.message).toBe("No such file or directory (os error 2)");
    expect(errorKind(converted)).toBe(ErrorKind.NotFound);
  });
});
