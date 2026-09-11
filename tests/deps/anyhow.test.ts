/**
 * `anyhow`'s two rendering modes. `{:?}` is what `zoxide: …` prints on a failed
 * command; `{:#}` is what each bad import record prints.
 */
import { describe, expect, test } from "vitest";

import { chain, context, formatAlternate, formatDebug } from "../../src/deps/anyhow.ts";

describe("anyhow", () => {
  const inner = new Error("Permission denied (os error 13)");
  const one = context(inner, "could not read from database: /tmp/db.zo");
  const two = context(one, "could not write to database");

  test("Debug renders a single cause indented by four spaces", () => {
    expect(formatDebug(one)).toBe(
      "could not read from database: /tmp/db.zo\n\nCaused by:\n    Permission denied (os error 13)",
    );
  });

  test("Debug numbers a multi-cause chain in five columns", () => {
    expect(formatDebug(two)).toBe(
      [
        "could not write to database",
        "",
        "Caused by:",
        "    0: could not read from database: /tmp/db.zo",
        "    1: Permission denied (os error 13)",
      ].join("\n"),
    );
  });

  test("Debug of a bare error is just its message", () => {
    expect(formatDebug(new Error("no match found"))).toBe("no match found");
  });

  test("alternate Display joins the chain with a colon", () => {
    expect(formatAlternate(two)).toBe(
      "could not write to database: could not read from database: /tmp/db.zo: Permission denied (os error 13)",
    );
  });

  test("chain walks causes outermost first", () => {
    expect(chain(two).map((e) => e.message)).toEqual([
      "could not write to database",
      "could not read from database: /tmp/db.zo",
      "Permission denied (os error 13)",
    ]);
  });
});
