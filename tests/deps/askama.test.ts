/**
 * The Askama subset the shell templates use. Whitespace control is the part
 * most likely to drift, so each construct is asserted on its own before
 * `tests/shell.test.ts` exercises the real templates.
 */
import { describe, expect, test } from "vitest";

import { render, TemplateError, type Value } from "../../src/deps/askama.ts";

function vars(entries: Record<string, Value>): Map<string, Value> {
  return new Map(Object.entries(entries));
}

describe("askama", () => {
  test("renders an expression", () => {
    expect(render("a{{ x }}b", vars({ x: "Z" }))).toBe("aZb");
  });

  test("preserves whitespace unless a tag suppresses it", () => {
    expect(render("a\n{% if t %}\nb\n{% endif %}\nc", vars({ t: true }))).toBe("a\n\nb\n\nc");
    expect(render("a\n{%- if t -%}\nb\n{%- endif -%}\nc", vars({ t: true }))).toBe("abc");
    expect(render("a\n{%- if t %}\nb\n{% endif -%}\nc", vars({ t: true }))).toBe("a\nb\nc");
  });

  test("takes the else branch", () => {
    expect(render("{% if t %}yes{% else %}no{% endif %}", vars({ t: false }))).toBe("no");
  });

  test("chains else-if on an enum comparison", () => {
    const template = "{% if h == E::A %}a{% else if h == E::B %}b{% else %}c{% endif %}";
    const withHook = (variant: string): Value => ({ enum: "E", variant });
    expect(render(template, vars({ h: withHook("A") }))).toBe("a");
    expect(render(template, vars({ h: withHook("B") }))).toBe("b");
    expect(render(template, vars({ h: withHook("C") }))).toBe("c");
  });

  test("supports != on enums", () => {
    expect(render("{% if h != E::A %}x{% endif %}", vars({ h: { enum: "E", variant: "B" } }))).toBe("x");
  });

  test("a let assigns to an enclosing decl", () => {
    const template = "{% decl p %}{% if t %}{% let p = \"yes\" %}{% else %}{% let p = \"no\" %}{% endif %}[{{ p }}]";
    expect(render(template, vars({ t: true }))).toBe("[yes]");
    expect(render(template, vars({ t: false }))).toBe("[no]");
  });

  test("a let without a decl is scoped to its block", () => {
    expect(render('{% let x = "outer" %}{% if t %}{% let x = "inner" %}{{ x }}{% endif %}-{{ x }}', vars({ t: true }))).toBe(
      "inner-outer",
    );
  });

  test("string literals honour escapes", () => {
    expect(render('{% let s = "a\\nb\\\\c" %}{{ s }}', vars({}))).toBe("a\nb\\c");
  });

  test("matches an Option", () => {
    const template = "{% match c %}{% when Some with (c) %}[{{ c }}]{% when None %}none{% endmatch %}";
    expect(render(template, vars({ c: "z" }))).toBe("[z]");
    expect(render(template, vars({ c: null }))).toBe("none");
  });

  test("matches an enum", () => {
    const template = "{% match h %}{% when E::A %}a{% when E::B %}b{% endmatch %}";
    expect(render(template, vars({ h: { enum: "E", variant: "B" } }))).toBe("b");
  });

  test("if let binds the inner value", () => {
    const template = "{% if let Some(c) = c %}[{{ c }}]{% endif %}";
    expect(render(template, vars({ c: "z" }))).toBe("[z]");
    expect(render(template, vars({ c: null }))).toBe("");
  });

  test("unwrap_or substitutes the default for None", () => {
    expect(render('{{ c.unwrap_or("cd") }}', vars({ c: null }))).toBe("cd");
    expect(render('{{ c.unwrap_or("cd") }}', vars({ c: "z" }))).toBe("z");
  });

  test("cfg!(windows) follows the platform", () => {
    expect(render("{% if cfg!(windows) %}win{% else %}unix{% endif %}", vars({}))).toBe(
      process.platform === "win32" ? "win" : "unix",
    );
  });

  test("does not escape anything, as a .txt template", () => {
    expect(render("{{ x }}", vars({ x: '<a href="&">' }))).toBe('<a href="&">');
  });

  test("rejects malformed templates instead of looping", () => {
    expect(() => render("{{ nope }}", vars({}))).toThrow(TemplateError);
    expect(() => render("{% oops %}", vars({}))).toThrow(TemplateError);
    expect(() => render("{{ x ", vars({ x: "a" }))).toThrow(TemplateError);
    expect(() => render("{% if t %}", vars({ t: true }))).toThrow(
      "unterminated block, expected one of: else, endif",
    );
    expect(() => render("{% match c %}{% when None %}", vars({ c: null }))).toThrow(
      "unterminated block, expected one of: when, endmatch",
    );
  });
});
