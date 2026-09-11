/**
 * `str::from_utf8`'s error text, which an importer prints verbatim for a
 * malformed record. `Buffer.toString` would substitute U+FFFD instead.
 */
import { describe, expect, test } from "vitest";

import { debugPath, decodeUtf8, Utf8Error } from "../../src/deps/utf8.ts";

describe("decodeUtf8", () => {
  test("decodes valid input", () => {
    expect(decodeUtf8(Buffer.from("/tmp/日本", "utf8"))).toBe("/tmp/日本");
  });

  test("reports an invalid byte with its index", () => {
    expect(() => decodeUtf8(Buffer.from([0x2f, 0x61, 0x62, 0xff]))).toThrow(
      "invalid utf-8 sequence of 1 bytes from index 3",
    );
  });

  test("reports a bad continuation byte by how far the sequence got", () => {
    expect(() => decodeUtf8(Buffer.from([0xe6, 0x97, 0x2f]))).toThrow(
      "invalid utf-8 sequence of 2 bytes from index 0",
    );
  });

  test("reports a truncated sequence as incomplete", () => {
    const error = (() => {
      try {
        decodeUtf8(Buffer.from([0x61, 0xe6, 0x97]));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(Utf8Error);
    expect((error as Utf8Error).message).toBe("incomplete utf-8 byte sequence from index 1");
    expect((error as Utf8Error).errorLen).toBeNull();
  });

  test("rejects an overlong encoding", () => {
    expect(() => decodeUtf8(Buffer.from([0xc0, 0x80]))).toThrow("invalid utf-8 sequence of 1 bytes from index 0");
  });

  test("rejects a surrogate", () => {
    expect(() => decodeUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toThrow(
      "invalid utf-8 sequence of 1 bytes from index 0",
    );
  });
});

describe("debugPath", () => {
  test("quotes and escapes like Rust's Debug for Path", () => {
    expect(debugPath("/home/user/.z")).toBe('"/home/user/.z"');
    expect(debugPath('/tmp/a"b\\c')).toBe('"/tmp/a\\"b\\\\c"');
  });
});
