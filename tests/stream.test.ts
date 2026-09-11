import { expect, test } from "vitest";

import { Database } from "../src/db/index.ts";
import { Stream, StreamOptions } from "../src/db/stream.ts";

/** The `#[rstest]` cases of `db::stream::tests::query`, in the same order. */
const CASES: readonly [readonly string[], string, boolean][] = [
  // Case normalization
  [["fOo", "bAr"], "/foo/bar", true],
  // Last component
  [["ba"], "/foo/bar", true],
  [["fo"], "/foo/bar", false],
  // Slash as suffix
  [["foo/"], "/foo", false],
  [["foo/"], "/foo/bar", true],
  [["foo/"], "/foo/bar/baz", false],
  [["foo", "/"], "/foo", false],
  [["foo", "/"], "/foo/bar", true],
  [["foo", "/"], "/foo/bar/baz", true],
  // Split components
  [["/", "fo", "/", "ar"], "/foo/bar", true],
  [["oo/ba"], "/foo/bar", true],
  // Overlap
  [["foo", "o", "bar"], "/foo/bar", false],
  [["/foo/", "/bar"], "/foo/bar", false],
  [["/foo/", "/bar"], "/foo/baz/bar", true],
];

// `db::stream::tests::query::case_01` … `case_14`. The module is this file and
// the case name is the test title, so each name is the original's leaf verbatim
// — a dropped case shows up as a missing name rather than a renamed one.
test.each(CASES.map((c, index) => [String(index + 1).padStart(2, "0"), ...c] as const))(
  "case_%s",
  (_index, keywords, path, isMatch) => {
    const db = Database.create("", [], false);
    const options = new StreamOptions(0).withKeywords(keywords);
    const stream = new Stream(db, options);
    expect(stream.filterByKeywords(path)).toBe(isMatch);
  },
);
