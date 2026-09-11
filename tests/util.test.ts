/**
 * Path handling that the original got from `std::path` — component
 * normalisation, `Path::starts_with`, and the lexical `resolve_path` that makes
 * a path absolute without touching the filesystem.
 */
import { describe, expect, test } from "vitest";

import { components, pathStartsWith, resolvePath, toLowercase } from "../src/util.ts";

describe.skipIf(process.platform === "win32")("components", () => {
  test.each([
    ["/foo/bar", ["/", "foo", "bar"]],
    ["/foo//bar/", ["/", "foo", "bar"]],
    ["/foo/./bar", ["/", "foo", "bar"]],
    ["./foo", [".", "foo"]],
    ["foo/./bar", ["foo", "bar"]],
    ["/", ["/"]],
    ["", []],
    ["../foo", ["..", "foo"]],
  ])("%s => %j", (input, expected) => {
    expect(components(input)).toEqual(expected);
  });
});

describe.skipIf(process.platform === "win32")("pathStartsWith", () => {
  test.each([
    ["/foo/bar", "/foo", true],
    ["/foo/bar", "/foo/bar", true],
    // A prefix must line up on component boundaries.
    ["/foo/bar", "/fo", false],
    ["/foobar", "/foo", false],
    ["/foo/bar", "/foo/", true],
    ["/foo/bar", "", true],
    ["/foo", "/foo/bar", false],
  ])("%s starts with %s => %s", (target, base, expected) => {
    expect(pathStartsWith(target, base)).toBe(expected);
  });
});

describe.skipIf(process.platform === "win32")("resolvePath", () => {
  test.each([
    ["/foo/bar", "/foo/bar"],
    ["/foo/./bar", "/foo/bar"],
    ["/foo/../bar", "/bar"],
    ["/foo/bar/..", "/foo"],
    ["/foo//bar/", "/foo/bar"],
    // `..` never escapes the root.
    ["/..", "/"],
    ["/../../foo", "/foo"],
    ["/", "/"],
  ])("%s => %s", (input, expected) => {
    expect(resolvePath(input)).toBe(expected);
  });

  test("resolves a relative path against the current directory, without touching the filesystem", () => {
    const cwd = process.cwd();
    expect(resolvePath("foo/bar")).toBe(`${cwd}/foo/bar`);
    expect(resolvePath("")).toBe(cwd);
    expect(resolvePath("./missing/../also-missing")).toBe(`${cwd}/also-missing`);
  });
});

describe("toLowercase", () => {
  test("takes the ASCII fast path without changing the result", () => {
    expect(toLowercase("/FOO/Bar_1")).toBe("/foo/bar_1");
  });

  test("falls back to full Unicode lowering", () => {
    expect(toLowercase("/tmp/ÉCOLE")).toBe("/tmp/école");
    expect(toLowercase("/tmp/ΣΣ")).toBe("/tmp/σς");
  });
});
