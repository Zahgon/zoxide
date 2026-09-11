/**
 * `glob::Pattern`, which `_ZO_EXCLUDE_DIRS` exposes to users. The cases below
 * pin the crate's default `MatchOptions`: case sensitive, `*` crossing path
 * separators, and no special treatment of a leading dot.
 */
import { describe, expect, test } from "vitest";

import { Pattern, PatternError } from "../../src/deps/glob.ts";

describe("glob::Pattern", () => {
  test.each([
    ["/home/user", "/home/user", true],
    ["/home/user", "/home/user/x", false],
    ["/home/*", "/home/user", true],
    // `*` is not stopped by a separator unless require_literal_separator is set.
    ["/home/*", "/home/user/project", true],
    ["/home/?ser", "/home/user", true],
    ["/home/?ser", "/home/uuser", false],
    ["/home/[uv]ser", "/home/vser", true],
    ["/home/[!uv]ser", "/home/vser", false],
    ["/home/[!uv]ser", "/home/wser", true],
    ["/home/[a-c]", "/home/b", true],
    ["/home/[a-c]", "/home/d", false],
    ["/**/target", "/a/b/target", true],
    ["/a/**/target", "/a/target", true],
    // A leading dot is not special.
    ["/home/*", "/home/.config", true],
    // Matching is case sensitive.
    ["/home/User", "/home/user", false],
  ])("%s matches %s => %s", (pattern, path, expected) => {
    expect(Pattern.new(pattern).matches(path)).toBe(expected);
  });

  test("an unterminated class is a literal bracket, not an error", () => {
    const pattern = Pattern.new("/home/[abc");
    expect(pattern.matches("/home/[abc")).toBe(true);
  });

  test("rejects three or more consecutive wildcards", () => {
    expect(() => Pattern.new("a/***/b")).toThrow(PatternError);
    expect(() => Pattern.new("a/***/b")).toThrow(
      "Pattern syntax error near position 4: wildcards are either regular `*` or recursive `**`",
    );
  });

  test("rejects a recursive wildcard that is not a whole component", () => {
    expect(() => Pattern.new("a**/b")).toThrow(
      "Pattern syntax error near position 0: recursive wildcards must form a single path component",
    );
    expect(() => Pattern.new("a/**b")).toThrow(
      "Pattern syntax error near position 4: recursive wildcards must form a single path component",
    );
  });

  test("keeps its original text", () => {
    const pattern = Pattern.new("/home/*/src");
    expect(pattern.original).toBe("/home/*/src");
    expect(pattern.toString()).toBe("/home/*/src");
    expect(String(pattern)).toBe("/home/*/src");
  });

  test("escape wraps every metacharacter in a one-character class", () => {
    expect(Pattern.escape("/home/a*b?c[d]e")).toBe("/home/a[*]b[?]c[[]d[]]e");
    const escaped = Pattern.escape("/home/user[1]");
    expect(Pattern.new(escaped).matches("/home/user[1]")).toBe(true);
    expect(Pattern.new(escaped).matches("/home/userX")).toBe(false);
  });
});
