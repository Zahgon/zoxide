/**
 * The command-line surface, the analogue of the original's `#[derive(Parser)]`
 * block. Everything here is declarative: `src/deps/clap.ts` turns it into the
 * same parser, help text and error messages clap produced.
 */

import type { Arg, Command, Matches } from "../deps/clap.ts";

export const VERSION = "0.10.0";
export const AUTHOR = "Ajeet D'Souza <98ajeet@gmail.com>";
export const ABOUT = "A smarter cd command for your terminal";

/**
 * `help_template`, with the `color-print` markup already resolved. zoxide only
 * ever writes help to a pipe or a colour-disabled terminal in the tests, and
 * clap drops the styling in that case, so the markup contributes no bytes.
 */
const HELP_TEMPLATE = `{before-help}{name} {version}
{author}
https://github.com/ajeetdsouza/zoxide

{about}

{usage-heading}
{tab}{usage}

{all-args}{after-help}

Environment variables:
{tab}_ZO_DATA_DIR        {tab}Path for zoxide data files
{tab}_ZO_ECHO            {tab}Print the matched directory before navigating to it when set to 1
{tab}_ZO_EXCLUDE_DIRS    {tab}List of directory globs to be excluded
{tab}_ZO_FZF_OPTS        {tab}Custom flags to pass to fzf
{tab}_ZO_MAXAGE          {tab}Maximum total age after which entries start getting deleted
{tab}_ZO_RESOLVE_SYMLINKS{tab}Resolve symlinks when storing paths`;

export const InitHook = {
  None: "none",
  Prompt: "prompt",
  Pwd: "pwd",
} as const;
export type InitHook = (typeof InitHook)[keyof typeof InitHook];

export const INIT_HOOKS: readonly InitHook[] = [InitHook.None, InitHook.Prompt, InitHook.Pwd];

export const InitShell = {
  Bash: "bash",
  Elvish: "elvish",
  Fish: "fish",
  Nushell: "nushell",
  Posix: "posix",
  Powershell: "powershell",
  Tcsh: "tcsh",
  Xonsh: "xonsh",
  Zsh: "zsh",
} as const;
export type InitShell = (typeof InitShell)[keyof typeof InitShell];

export const INIT_SHELLS: readonly InitShell[] = [
  InitShell.Bash,
  InitShell.Elvish,
  InitShell.Fish,
  InitShell.Nushell,
  InitShell.Posix,
  InitShell.Powershell,
  InitShell.Tcsh,
  InitShell.Xonsh,
  InitShell.Zsh,
];

export const ImportFrom = {
  Atuin: "atuin",
  Autojump: "autojump",
  Fasd: "fasd",
  Z: "z",
  ZLua: "z.lua",
  ZshZ: "zsh-z",
} as const;
export type ImportFrom = (typeof ImportFrom)[keyof typeof ImportFrom];

// ─── Parsed shapes ───────────────────────────────────────────────────────────

export interface Add {
  readonly kind: "add";
  readonly paths: readonly string[];
  readonly score: number | null;
}

export type EditCommand =
  | { readonly kind: "decrement"; readonly path: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "increment"; readonly path: string }
  | { readonly kind: "reload" };

export interface Edit {
  readonly kind: "edit";
  readonly cmd: EditCommand | null;
}

export interface Import {
  readonly kind: "import";
  readonly from: ImportFrom;
  readonly merge: boolean;
}

export interface Init {
  readonly kind: "init";
  readonly shell: InitShell;
  readonly noCmd: boolean;
  readonly cmd: string;
  readonly hook: InitHook;
}

export interface Query {
  readonly kind: "query";
  readonly keywords: readonly string[];
  readonly all: boolean;
  readonly interactive: boolean;
  readonly list: boolean;
  readonly score: boolean;
  readonly exclude: string | null;
  readonly baseDir: string | null;
}

export interface Remove {
  readonly kind: "remove";
  readonly paths: readonly string[];
}

export type Cmd = Add | Edit | Import | Init | Query | Remove;

// ─── Command tree ────────────────────────────────────────────────────────────

const MERGE: Arg = {
  id: "merge",
  long: "merge",
  help: "Merge into existing database",
  global: true,
};

function editLeaf(name: string, withPath: boolean): Command {
  return {
    name,
    displayName: `zoxide-edit-${name}`,
    version: VERSION,
    positionals: withPath
      ? [{ id: "path", valueName: "PATH", required: true, multiple: false }]
      : [],
  };
}

function importLeaf(name: ImportFrom, about: string): Command {
  return { name, displayName: `zoxide-import-${name}`, about, version: VERSION };
}

const ADD: Command = {
  name: "add",
  displayName: "zoxide-add",
  about: "Add a new directory or increment its rank",
  author: AUTHOR,
  version: VERSION,
  helpTemplate: HELP_TEMPLATE,
  args: [
    {
      id: "score",
      short: "s",
      long: "score",
      valueName: "SCORE",
      valueParser: "f64",
      help: "The rank to increment the entry if it exists or initialize it with if it doesn't",
    },
  ],
  positionals: [{ id: "paths", valueName: "PATHS", required: true, multiple: true }],
};

const EDIT: Command = {
  name: "edit",
  displayName: "zoxide-edit",
  about: "Edit the database",
  author: AUTHOR,
  version: VERSION,
  helpTemplate: HELP_TEMPLATE,
  hideSubcommands: true,
  subcommands: [
    editLeaf("decrement", true),
    editLeaf("delete", true),
    editLeaf("increment", true),
    editLeaf("reload", false),
  ],
};

const IMPORT: Command = {
  name: "import",
  displayName: "zoxide-import",
  about: "Import entries from another application",
  author: AUTHOR,
  version: VERSION,
  helpTemplate: HELP_TEMPLATE,
  args: [MERGE],
  subcommandRequired: true,
  argRequiredElseHelp: true,
  subcommands: [
    importLeaf(ImportFrom.Atuin, "Import from atuin"),
    importLeaf(ImportFrom.Autojump, "Import from autojump"),
    importLeaf(ImportFrom.Fasd, "Import from fasd"),
    importLeaf(ImportFrom.Z, "Import from z"),
    importLeaf(ImportFrom.ZLua, "Import from z.lua"),
    importLeaf(ImportFrom.ZshZ, "Import from zsh-z"),
  ],
};

const INIT: Command = {
  name: "init",
  displayName: "zoxide-init",
  about: "Generate shell configuration",
  author: AUTHOR,
  version: VERSION,
  helpTemplate: HELP_TEMPLATE,
  args: [
    {
      id: "no-cmd",
      long: "no-cmd",
      aliases: ["no-aliases"],
      help: "Prevents zoxide from defining the `z` and `zi` commands",
    },
    {
      id: "cmd",
      long: "cmd",
      valueName: "CMD",
      defaultValue: "z",
      help: "Changes the prefix of the `z` and `zi` commands",
    },
    {
      id: "hook",
      long: "hook",
      valueName: "HOOK",
      defaultValue: InitHook.Pwd,
      possibleValues: INIT_HOOKS,
      help: "Changes how often zoxide increments a directory's score",
    },
  ],
  positionals: [
    {
      id: "shell",
      valueName: "SHELL",
      required: true,
      multiple: false,
      possibleValues: INIT_SHELLS,
      valueAliases: { ksh: InitShell.Posix },
    },
  ],
};

const QUERY: Command = {
  name: "query",
  displayName: "zoxide-query",
  about: "Search for a directory in the database",
  author: AUTHOR,
  version: VERSION,
  helpTemplate: HELP_TEMPLATE,
  args: [
    { id: "all", short: "a", long: "all", help: "Show unavailable directories" },
    {
      id: "interactive",
      short: "i",
      long: "interactive",
      help: "Use interactive selection",
      conflictsWith: ["list"],
    },
    {
      id: "list",
      short: "l",
      long: "list",
      help: "List all matching directories",
      conflictsWith: ["interactive"],
    },
    { id: "score", short: "s", long: "score", help: "Print score with results" },
    {
      id: "exclude",
      long: "exclude",
      valueName: "path",
      help: "Exclude the current directory",
    },
    {
      id: "base-dir",
      long: "base-dir",
      valueName: "path",
      help: "Only search within this directory",
    },
  ],
  positionals: [{ id: "keywords", valueName: "KEYWORDS", required: false, multiple: true }],
};

const REMOVE: Command = {
  name: "remove",
  displayName: "zoxide-remove",
  about: "Remove a directory from the database",
  author: AUTHOR,
  version: VERSION,
  helpTemplate: HELP_TEMPLATE,
  positionals: [{ id: "paths", valueName: "PATHS", required: false, multiple: true }],
};

/** The root command, `Cmd` in the original. */
export const CMD: Command = {
  name: "zoxide",
  displayName: "zoxide",
  about: ABOUT,
  author: AUTHOR,
  version: VERSION,
  helpTemplate: HELP_TEMPLATE,
  subcommandRequired: true,
  argRequiredElseHelp: true,
  subcommands: [ADD, EDIT, IMPORT, INIT, QUERY, REMOVE],
};

// ─── Matches → typed command ─────────────────────────────────────────────────

function flag(matches: Matches, id: string): boolean {
  return matches.values.get(id) === true;
}

function text(matches: Matches, id: string): string | null {
  const value = matches.values.get(id);
  return typeof value === "string" ? value : null;
}

function list(matches: Matches, id: string): string[] {
  const value = matches.values.get(id);
  return Array.isArray(value) ? value : [];
}

/** Rust's `str::parse::<f64>` for the values clap has already validated. */
function parseFloatLikeRust(raw: string): number {
  if (/^[+-]?(?:inf|infinity)$/i.test(raw)) {
    return raw.startsWith("-") ? -Infinity : Infinity;
  }
  if (/^[+-]?nan$/i.test(raw)) {
    return NaN;
  }
  return Number(raw);
}

function editCommand(matches: Matches): EditCommand | null {
  const sub = matches.subcommand;
  if (sub === null) {
    return null;
  }
  const path = text(sub, "path") ?? "";
  switch (sub.command.name) {
    case "decrement":
      return { kind: "decrement", path };
    case "delete":
      return { kind: "delete", path };
    case "increment":
      return { kind: "increment", path };
    default:
      return { kind: "reload" };
  }
}

/** Turns clap's matches into the typed command the original's enum modelled. */
export function fromMatches(matches: Matches): Cmd {
  const sub = matches.subcommand;
  if (sub === null) {
    throw new Error("no subcommand matched");
  }

  switch (sub.command.name) {
    case "add": {
      const score = text(sub, "score");
      return { kind: "add", paths: list(sub, "paths"), score: score === null ? null : parseFloatLikeRust(score) };
    }
    case "edit":
      return { kind: "edit", cmd: editCommand(sub) };
    case "import": {
      const from = sub.subcommand?.command.name as ImportFrom;
      return { kind: "import", from, merge: flag(sub, "merge") || flag(sub.subcommand!, "merge") };
    }
    case "init":
      return {
        kind: "init",
        shell: (text(sub, "shell") ?? InitShell.Posix) as InitShell,
        noCmd: flag(sub, "no-cmd"),
        cmd: text(sub, "cmd") ?? "z",
        hook: (text(sub, "hook") ?? InitHook.Pwd) as InitHook,
      };
    case "query":
      return {
        kind: "query",
        keywords: list(sub, "keywords"),
        all: flag(sub, "all"),
        interactive: flag(sub, "interactive"),
        list: flag(sub, "list"),
        score: flag(sub, "score"),
        exclude: text(sub, "exclude"),
        baseDir: text(sub, "base-dir"),
      };
    default:
      return { kind: "remove", paths: list(sub, "paths") };
  }
}
