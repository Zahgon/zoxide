/**
 * The clap surface: help layout, usage strings, error wording and exit codes.
 *
 * Every expectation here was captured from the original binary, so this file is
 * the regression net for behaviour that used to come from clap 4.
 */
import { describe, expect, test } from "vitest";

import { CMD } from "../../src/cmd/cmd.ts";
import { binNameFrom, ClapError, didYouMean, jaroWinkler, parse, renderHelp } from "../../src/deps/clap.ts";

function attempt(argv: readonly string[]): ClapError {
  try {
    parse(CMD, argv, "zoxide");
  } catch (error) {
    if (error instanceof ClapError) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(argv)} to produce output`);
}

describe("help", () => {
  test("renders the root help template", () => {
    expect(renderHelp(CMD, "zoxide", [])).toBe(
      `zoxide 0.10.0
Ajeet D'Souza <98ajeet@gmail.com>
https://github.com/ajeetdsouza/zoxide

A smarter cd command for your terminal

Usage:
  zoxide <COMMAND>

Commands:
  add     Add a new directory or increment its rank
  edit    Edit the database
  import  Import entries from another application
  init    Generate shell configuration
  query   Search for a directory in the database
  remove  Remove a directory from the database

Options:
  -h, --help     Print help
  -V, --version  Print version

Environment variables:
  _ZO_DATA_DIR          Path for zoxide data files
  _ZO_ECHO              Print the matched directory before navigating to it when set to 1
  _ZO_EXCLUDE_DIRS      List of directory globs to be excluded
  _ZO_FZF_OPTS          Custom flags to pass to fzf
  _ZO_MAXAGE            Maximum total age after which entries start getting deleted
  _ZO_RESOLVE_SYMLINKS  Resolve symlinks when storing paths
`,
    );
  });

  test("aligns each section to its own widest entry", () => {
    const help = attempt(["query", "--help"]).toString();
    expect(help).toContain("Arguments:\n  [KEYWORDS]...  \n");
    expect(help).toContain("  -a, --all              Show unavailable directories\n");
    expect(help).toContain("      --base-dir <path>  Only search within this directory\n");
  });

  test("appends defaults and possible values", () => {
    const help = attempt(["init", "--help"]).toString();
    expect(help).toContain("      --cmd <CMD>    Changes the prefix of the `z` and `zi` commands [default: z]\n");
    expect(help).toContain(
      "      --hook <HOOK>  Changes how often zoxide increments a directory's score [default: pwd] [possible values: none, prompt, pwd]\n",
    );
    expect(help).toContain("  <SHELL>  [possible values: bash, elvish, fish, nushell, posix, powershell, tcsh, xonsh, zsh]\n");
  });

  test("a nested leaf uses clap's default template", () => {
    expect(attempt(["edit", "decrement", "--help"]).toString()).toBe(
      "Usage: zoxide edit decrement <PATH>\n\nArguments:\n  <PATH>  \n\nOptions:\n  -h, --help     Print help\n  -V, --version  Print version\n",
    );
    expect(attempt(["import", "z.lua", "--help"]).toString()).toBe(
      "Import from z.lua\n\nUsage: zoxide import z.lua [OPTIONS]\n\nOptions:\n      --merge    Merge into existing database\n  -h, --help     Print help\n  -V, --version  Print version\n",
    );
  });

  test("--version propagates to every level", () => {
    expect(attempt(["--version"]).toString()).toBe("zoxide 0.10.0\n");
    expect(attempt(["add", "--version"]).toString()).toBe("zoxide-add 0.10.0\n");
    expect(attempt(["import", "z", "--version"]).toString()).toBe("zoxide-import-z 0.10.0\n");
    expect(attempt(["edit", "reload", "--version"]).toString()).toBe("zoxide-edit-reload 0.10.0\n");
  });

  test("help goes to stdout with exit 0, missing-subcommand help to stderr with exit 2", () => {
    const help = attempt(["--help"]);
    expect([help.exitCode, help.useStderr]).toEqual([0, false]);

    const bare = attempt([]);
    expect([bare.exitCode, bare.useStderr]).toEqual([2, true]);
    expect(bare.toString()).toBe(help.toString());
    expect(attempt(["--"]).toString()).toBe(help.toString());
  });
});

describe("errors", () => {
  test.each([
    [["nope"], "error: unrecognized subcommand 'nope'\n\nUsage: zoxide <COMMAND>\n\nFor more information, try '--help'.\n"],
    [
      ["ad"],
      "error: unrecognized subcommand 'ad'\n\n  tip: a similar subcommand exists: 'add'\n\nUsage: zoxide <COMMAND>\n\nFor more information, try '--help'.\n",
    ],
    [
      ["import", "zshz"],
      "error: unrecognized subcommand 'zshz'\n\n  tip: some similar subcommands exist: 'z', 'zsh-z'\n\nUsage: zoxide import [OPTIONS] <COMMAND>\n\nFor more information, try '--help'.\n",
    ],
    [
      ["add"],
      "error: the following required arguments were not provided:\n  <PATHS>...\n\nUsage: zoxide add <PATHS>...\n\nFor more information, try '--help'.\n",
    ],
    [
      ["add", "--zzz", "/tmp"],
      "error: unexpected argument '--zzz' found\n\n  tip: to pass '--zzz' as a value, use '-- --zzz'\n\nUsage: zoxide add [OPTIONS] <PATHS>...\n\nFor more information, try '--help'.\n",
    ],
    [
      ["query", "--interactiv"],
      "error: unexpected argument '--interactiv' found\n\n  tip: a similar argument exists: '--interactive'\n\nUsage: zoxide query --interactive [KEYWORDS]...\n\nFor more information, try '--help'.\n",
    ],
    [
      ["add", "--score"],
      "error: a value is required for '--score <SCORE>' but none was supplied\n\nFor more information, try '--help'.\n",
    ],
    [
      ["init", "posix", "--hook"],
      "error: a value is required for '--hook <HOOK>' but none was supplied\n  [possible values: none, prompt, pwd]\n\nFor more information, try '--help'.\n",
    ],
    [
      ["add", "--score", "abc", "/tmp"],
      "error: invalid value 'abc' for '--score <SCORE>': invalid float literal\n\nFor more information, try '--help'.\n",
    ],
    [
      ["init", "bsh"],
      "error: invalid value 'bsh' for '<SHELL>'\n  [possible values: bash, elvish, fish, nushell, posix, powershell, tcsh, xonsh, zsh]\n\n  tip: a similar value exists: 'bash'\n\nFor more information, try '--help'.\n",
    ],
    [
      ["init", "nope"],
      "error: invalid value 'nope' for '<SHELL>'\n  [possible values: bash, elvish, fish, nushell, posix, powershell, tcsh, xonsh, zsh]\n\nFor more information, try '--help'.\n",
    ],
    [
      ["query", "-i", "-l"],
      "error: the argument '--interactive' cannot be used with '--list'\n\nUsage: zoxide query --interactive [KEYWORDS]...\n\nFor more information, try '--help'.\n",
    ],
    [
      ["query", "-l", "-i"],
      "error: the argument '--list' cannot be used with '--interactive'\n\nUsage: zoxide query --list [KEYWORDS]...\n\nFor more information, try '--help'.\n",
    ],
    [
      ["--help=x"],
      "error: unexpected value 'x' for '--help' found; no more were expected\n\nUsage: zoxide --help <COMMAND>\n\nFor more information, try '--help'.\n",
    ],
    [
      ["import", "--merge"],
      "error: 'zoxide import' requires a subcommand but one was not provided\n  [subcommands: atuin, autojump, fasd, z, z.lua, zsh-z]\n\nUsage: zoxide import [OPTIONS] <COMMAND>\n\nFor more information, try '--help'.\n",
    ],
    [
      ["--", "add"],
      "error: unexpected argument 'add' found\n\n  tip: subcommand 'add' exists; to use it, remove the '--' before it\n\nUsage: zoxide <COMMAND>\n\nFor more information, try '--help'.\n",
    ],
    [
      ["init", "posix", "zsh"],
      "error: unexpected argument 'zsh' found\n\nUsage: zoxide init [OPTIONS] <SHELL>\n\nFor more information, try '--help'.\n",
    ],
  ])("%j", (argv, expected) => {
    const error = attempt(argv);
    expect(error.toString()).toBe(expected);
    expect([error.exitCode, error.useStderr]).toEqual([2, true]);
  });
});

describe("parsing", () => {
  test("a detached value may not begin with a dash, but an attached one may", () => {
    expect(attempt(["add", "--score", "-1", "/tmp"]).toString()).toContain("unexpected argument '-1' found");
    const matches = parse(CMD, ["add", "--score=-1", "/tmp"], "zoxide");
    expect(matches.subcommand?.values.get("score")).toBe("-1");
  });

  test("a short option swallows the rest of its token", () => {
    for (const argv of [["add", "-s2", "/tmp"], ["add", "-s=2", "/tmp"], ["add", "-s", "2", "/tmp"]]) {
      expect(parse(CMD, argv, "zoxide").subcommand?.values.get("score")).toBe("2");
    }
  });

  test("-h and -V swallow the rest of their token", () => {
    expect(attempt(["-hx"]).exitCode).toBe(0);
    expect(attempt(["-Vx"]).toString()).toBe("zoxide 0.10.0\n");
  });

  test("combined short flags all apply", () => {
    const matches = parse(CMD, ["query", "-al"], "zoxide");
    expect(matches.subcommand?.values.get("all")).toBe(true);
    expect(matches.subcommand?.values.get("list")).toBe(true);
  });

  test("a global flag is accepted before or after the subcommand", () => {
    expect(parse(CMD, ["import", "--merge", "z"], "zoxide").subcommand?.values.get("merge")).toBe(true);
    expect(
      parse(CMD, ["import", "z", "--merge"], "zoxide").subcommand?.subcommand?.values.get("merge"),
    ).toBe(true);
  });

  test("--no-aliases is an alias for --no-cmd", () => {
    expect(parse(CMD, ["init", "posix", "--no-aliases"], "zoxide").subcommand?.values.get("no-cmd")).toBe(true);
  });

  test("defaults are filled in", () => {
    const matches = parse(CMD, ["init", "posix"], "zoxide").subcommand;
    expect(matches?.values.get("cmd")).toBe("z");
    expect(matches?.values.get("hook")).toBe("pwd");
  });

  test("a bare dash is a value, not a flag", () => {
    expect(attempt(["-"]).toString()).toContain("unrecognized subcommand '-'");
  });
});

describe("suggestions", () => {
  test("jaro_winkler matches strsim, including the uncapped prefix bonus", () => {
    expect(jaroWinkler("ad", "add")).toBeCloseTo(0.9111, 4);
    expect(jaroWinkler("zlua", "z")).toBeCloseTo(0.775, 4);
    expect(jaroWinkler("zlua", "z.lua")).toBeCloseTo(0.94, 4);
    expect(jaroWinkler("pow", "posix")).toBeCloseTo(0.6889, 4);
  });

  test("candidates above 0.7 are listed by ascending confidence", () => {
    expect(didYouMean("zshz", ["atuin", "autojump", "fasd", "z", "z.lua", "zsh-z"])).toEqual(["z", "zsh-z"]);
    expect(didYouMean("nope", ["none", "prompt", "pwd"])).toEqual(["none"]);
    expect(didYouMean("POSIX", ["bash", "posix"])).toEqual([]);
  });
});

describe("binNameFrom", () => {
  test("uses the file name the program was invoked under", () => {
    expect(binNameFrom("/usr/local/bin/zoxide")).toBe("zoxide");
    expect(binNameFrom("/repo/src/main.ts")).toBe("main");
    expect(binNameFrom("qcapp")).toBe("qcapp");
  });
});
