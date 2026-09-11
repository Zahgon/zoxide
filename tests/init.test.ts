/**
 * `zoxide init <shell>` for every shell and every option combination, without
 * needing the shell itself.
 *
 * `tests/shell.test.ts` is the stronger check — it feeds each rendering to the
 * real interpreter — but it only runs where that interpreter exists. These
 * assertions are about the template contract and hold everywhere, so all nine
 * renderers are exercised on every machine.
 *
 * The per-shell expectations below were measured from the original binary
 * across its own renderings, not derived from this implementation.
 */
import { describe, expect, test } from "vitest";

import { InitHook, type InitShell } from "../src/cmd/cmd.ts";
import { type Opts, SHELL_TEMPLATES } from "../src/shell.ts";
import { OPTS, optsName, SHELLS } from "./support.ts";

const NOT_CONFIGURED = "# -- not configured --";
const SECTION = "# =============================================================================";

interface Facts {
  /** How many of the 36 option combinations produce distinct output. */
  readonly distinct: number;
  /** Which options this shell's template actually reads. */
  readonly sensitiveTo: readonly ("cmd" | "hook" | "echo" | "resolveSymlinks")[];
  /** Whether `--hook none` reaches the "not configured" marker. */
  readonly hookNoneMarker: boolean;
  /** The `pwd` invocation `_ZO_RESOLVE_SYMLINKS` switches between, if any. */
  readonly pwd?: readonly [logical: string, physical: string];
}

const FACTS: Readonly<Record<InitShell, Facts>> = {
  bash: {
    distinct: 24,
    sensitiveTo: ["cmd", "hook", "echo", "resolveSymlinks"],
    hookNoneMarker: false,
    pwd: ["\\builtin pwd -L", "\\builtin pwd -P"],
  },
  elvish: { distinct: 12, sensitiveTo: ["cmd", "hook", "echo"], hookNoneMarker: true },
  fish: {
    distinct: 24,
    sensitiveTo: ["cmd", "hook", "echo", "resolveSymlinks"],
    hookNoneMarker: true,
    pwd: ["builtin pwd -L", "builtin pwd -P"],
  },
  nushell: { distinct: 12, sensitiveTo: ["cmd", "hook", "echo"], hookNoneMarker: true },
  posix: {
    distinct: 24,
    sensitiveTo: ["cmd", "hook", "echo", "resolveSymlinks"],
    hookNoneMarker: true,
    pwd: ["\\command pwd -L", "\\command pwd -P"],
  },
  powershell: { distinct: 12, sensitiveTo: ["cmd", "hook", "echo"], hookNoneMarker: true },
  tcsh: {
    distinct: 12,
    sensitiveTo: ["cmd", "hook", "resolveSymlinks"],
    hookNoneMarker: false,
    pwd: ["pwd -L", "pwd -P"],
  },
  xonsh: { distinct: 24, sensitiveTo: ["cmd", "hook", "echo", "resolveSymlinks"], hookNoneMarker: true },
  zsh: {
    distinct: 24,
    sensitiveTo: ["cmd", "hook", "echo", "resolveSymlinks"],
    hookNoneMarker: false,
    pwd: ["\\builtin pwd -L", "\\builtin pwd -P"],
  },
};

const BASE: Opts = { cmd: "z", hook: InitHook.Pwd, echo: false, resolveSymlinks: false };

describe.each(SHELLS)("init %s", (shell) => {
  const facts = FACTS[shell];
  const render = (opts: Opts): string => SHELL_TEMPLATES[shell](opts);

  test.each(OPTS.map((opts) => [optsName(opts), opts] as const))("renders for %s", (_name, opts) => {
    const source = render(opts);
    expect(source.length).toBeGreaterThan(0);
    // Askama strips the template file's trailing newline; `zoxide init` writes
    // back exactly one.
    expect(source.endsWith("\n")).toBe(false);
    expect(source).toContain(SECTION);
    // Nothing may be left unsubstituted.
    expect(source).not.toMatch(/\{[{%]/);
  });

  test("is deterministic", () => {
    expect(render(BASE)).toBe(render(BASE));
  });

  test(`reads exactly ${facts.sensitiveTo.join(", ")}`, () => {
    const variants: Record<string, Opts> = {
      cmd: { ...BASE, cmd: null },
      hook: { ...BASE, hook: InitHook.None },
      echo: { ...BASE, echo: true },
      resolveSymlinks: { ...BASE, resolveSymlinks: true },
    };
    const reads = Object.entries(variants)
      .filter(([, opts]) => render(opts) !== render(BASE))
      .map(([name]) => name);
    expect(reads.sort()).toEqual([...facts.sensitiveTo].sort());
  });

  test("the command's name reaches the output", () => {
    expect(render({ ...BASE, cmd: "jj" })).toContain("jj");
    expect(render({ ...BASE, cmd: "jj" })).not.toBe(render(BASE));
  });

  test("--no-cmd leaves the command section unconfigured", () => {
    expect(render({ ...BASE, cmd: null })).toContain(NOT_CONFIGURED);
  });

  test(`--hook none ${facts.hookNoneMarker ? "leaves the hook section unconfigured" : "emits its own stub"}`, () => {
    expect(render({ ...BASE, hook: InitHook.None }).includes(NOT_CONFIGURED)).toBe(facts.hookNoneMarker);
    expect(render({ ...BASE, hook: InitHook.None })).not.toBe(render({ ...BASE, hook: InitHook.Prompt }));
    expect(render({ ...BASE, hook: InitHook.Prompt })).not.toBe(render({ ...BASE, hook: InitHook.Pwd }));
  });

  test(`${String(facts.distinct)} of the 36 option combinations render distinctly`, () => {
    expect(new Set(OPTS.map(render)).size).toBe(facts.distinct);
  });

  test.skipIf(facts.pwd === undefined)("_ZO_RESOLVE_SYMLINKS switches the pwd invocation", () => {
    const [logical, physical] = facts.pwd!;
    expect(render({ ...BASE, resolveSymlinks: false })).toContain(logical);
    expect(render({ ...BASE, resolveSymlinks: false })).not.toContain(physical);
    expect(render({ ...BASE, resolveSymlinks: true })).toContain(physical);
    expect(render({ ...BASE, resolveSymlinks: true })).not.toContain(logical);
  });
});
