/**
 * The database file format, which the original delegated to `bincode` 1.3 and
 * `serde`. It is persistent state shared with other zoxide installations, so
 * the byte layout is asserted directly rather than only round-tripped.
 */
import { describe, expect, test } from "vitest";

import { Database } from "../../src/db/index.ts";
import { Deserializer, Serializer, SIZE_U32 } from "../../src/deps/bincode.ts";

describe("bincode/db.zo", () => {
  test("encodes version, count, and each entry little-endian", () => {
    const bytes = Database.serialize([{ path: "/foo", rank: 2.5, lastAccessed: 946684800 }]);

    expect(bytes.subarray(0, 4).toString("hex")).toBe("03000000"); // u32 version = 3
    expect(bytes.subarray(4, 12).toString("hex")).toBe("0100000000000000"); // u64 count = 1
    expect(bytes.subarray(12, 20).toString("hex")).toBe("0400000000000000"); // u64 str len
    expect(bytes.subarray(20, 24).toString("utf8")).toBe("/foo");
    expect(bytes.readDoubleLE(24)).toBe(2.5);
    expect(bytes.readBigUInt64LE(32)).toBe(946684800n);
    expect(bytes.length).toBe(40);
  });

  test("round-trips multi-byte paths by UTF-8 length", () => {
    const dirs = [
      { path: "/tmp/é", rank: 1.25, lastAccessed: 1 },
      { path: "/tmp/日本", rank: 0.5, lastAccessed: 2 },
    ];
    expect(Database.deserialize(Database.serialize(dirs))).toEqual(dirs);
  });

  test("an empty database is the version plus a zero count", () => {
    expect(Database.serialize([]).toString("hex")).toBe("03000000" + "0000000000000000");
  });

  test("rejects a truncated header", () => {
    expect(() => Database.deserialize(Buffer.from([3, 0, 0]))).toThrow(
      "could not deserialize database: corrupted data",
    );
  });

  test("rejects an unsupported version", () => {
    const bytes = Database.serialize([]);
    bytes.writeUInt32LE(2, 0);
    expect(() => Database.deserialize(bytes)).toThrow("unsupported version (got 2, supports 3)");
  });

  test("rejects a truncated body", () => {
    const bytes = Database.serialize([{ path: "/foo", rank: 1, lastAccessed: 1 }]);
    expect(() => Database.deserialize(bytes.subarray(0, bytes.length - 4))).toThrow(
      "could not deserialize database",
    );
  });
});

describe("bincode primitives", () => {
  test("the serializer tracks the length it has written", () => {
    const serializer = new Serializer();
    expect(serializer.length).toBe(0);
    serializer.u32(3);
    expect(serializer.length).toBe(SIZE_U32);
    serializer.str("abc");
    expect(serializer.length).toBe(SIZE_U32 + 8 + 3);
    expect(serializer.finish().length).toBe(serializer.length);
  });

  test("u32, u64 and f64 round-trip little-endian", () => {
    const serializer = new Serializer();
    serializer.u32(0xdeadbeef);
    serializer.u64(18446744073709551615n);
    serializer.f64(-0.5);
    const deserializer = new Deserializer(serializer.finish());
    expect(deserializer.u32()).toBe(0xdeadbeef);
    expect(deserializer.u64()).toBe(18446744073709551615n);
    expect(deserializer.f64()).toBe(-0.5);
    expect(deserializer.remaining).toBe(0);
  });

  test("reading past the end is an end-of-file, and the limit is its own error", () => {
    expect(() => new Deserializer(Buffer.alloc(2)).u32()).toThrow("io error: unexpected end of file");
    expect(() => new Deserializer(Buffer.alloc(64), 2).u32()).toThrow("the size limit has been reached");
  });

  test("an impossible sequence length surfaces as end-of-file, not its own error", () => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(18446744073709551615n, 0);
    const deserializer = new Deserializer(bytes);
    expect(deserializer.seqLength()).toBe(18446744073709551615n);
    expect(() => deserializer.str()).toThrow("io error: unexpected end of file");
  });
});
