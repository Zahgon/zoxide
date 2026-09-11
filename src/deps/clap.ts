/**
 * The `clap` 4 surface zoxide exposes: parsing, help rendering, the wording and
 * layout of every parse error, and the exit codes that go with them.
 *
 * Everything here is observable — users read the help, shells embed the usage
 * strings, and scripts branch on the exit code — so this is a reimplementation
 * of clap's behaviour rather than a convenient argument parser. The command
 * tree itself lives in `src/cmd/cmd.ts`, which is the analogue of the original's
 * `#[derive(Parser)]` block.
 */

import { basename } from "node:path";

// ─── Command model ───────────────────────────────────────────────────────────

export interface Arg {
  /** Key the parsed value is stored under. */
  readonly id: string;
  readonly short?: string;
  readonly long: string;
  readonly aliases?: readonly string[];
  /** Present when the flag takes a value; rendered as `<valueName>`. */
  readonly valueName?: string;
  readonly help: string;
  readonly defaultValue?: string;
  readonly possibleValues?: readonly string[];
  /** Propagated to every subcommand, like clap's `global = true`. */
  readonly global?: boolean;
  readonly conflictsWith?: readonly string[];
  /** `f64` values are validated the way clap's `f64` parser reports failure. */
  readonly valueParser?: "string" | "f64";
}

export interface Positional {
  readonly id: string;
  readonly valueName: string;
  readonly required: boolean;
  readonly multiple: boolean;
  readonly possibleValues?: readonly string[];
  /** `#[clap(alias = "…")]` on a `ValueEnum` variant: extra spellings that map
   * onto a possible value without appearing in the help. */
  readonly valueAliases?: Readonly<Record<string, string>>;
  readonly help?: string;
}

export interface Command {
  /** Token typed on the command line. */
  readonly name: string;
  /** `{name}` in the help template and the `--version` line. */
  readonly displayName: string;
  readonly about?: string;
  readonly author?: string;
  readonly version: string;
  /** `help_template`; absent means clap's default template. */
  readonly helpTemplate?: string;
  readonly args?: readonly Arg[];
  readonly positionals?: readonly Positional[];
  readonly subcommands?: readonly Command[];
  readonly subcommandRequired?: boolean;
  /** clap sets this for a `Parser` with a required subcommand. */
  readonly argRequiredElseHelp?: boolean;
  /** `hide = true` on every subcommand keeps them out of help and usage. */
  readonly hideSubcommands?: boolean;
}

export type MatchedValue = string | boolean | string[];

export interface Matches {
  readonly command: Command;
  readonly values: ReadonlyMap<string, MatchedValue>;
  readonly subcommand: Matches | null;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ClapError extends Error {
  readonly blocks: readonly string[];
  readonly exitCode: number;
  readonly useStderr: boolean;

  constructor(blocks: readonly string[], exitCode: number, useStderr: boolean) {
    super(blocks.join("\n\n"));
    this.blocks = blocks;
    this.exitCode = exitCode;
    this.useStderr = useStderr;
  }

  /** The exact bytes clap writes, trailing newline included. */
  override toString(): string {
    return `${this.blocks.join("\n\n")}\n`;
  }
}

const TRY_HELP = "For more information, try '--help'.";

function parseError(message: string, tip: string | null, usage: string | null): ClapError {
  const blocks = [`error: ${message}`];
  if (tip !== null) {
    blocks.push(`  tip: ${tip}`);
  }
  if (usage !== null) {
    blocks.push(`Usage: ${usage}`);
  }
  blocks.push(TRY_HELP);
  return new ClapError(blocks, 2, true);
}

// ─── Suggestions ─────────────────────────────────────────────────────────────

/** `strsim::jaro`, as used by clap. */
export function jaro(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const searchRange = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const consumed = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  let transpositions = 0;
  let matchIndex = 0;

  for (let i = 0; i < a.length; i += 1) {
    const min = i > searchRange ? i - searchRange : 0;
    const max = Math.min(b.length - 1, i + searchRange);
    if (min > max) {
      continue;
    }
    for (let j = 0; j < b.length; j += 1) {
      if (min <= j && j <= max && a[i] === b[j] && !consumed[j]) {
        consumed[j] = true;
        matches += 1;
        if (j < matchIndex) {
          transpositions += 1;
        }
        matchIndex = j;
        break;
      }
    }
  }

  if (matches === 0) {
    return 0;
  }
  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

/** `strsim::jaro_winkler` — note that the prefix bonus is uncapped. */
export function jaroWinkler(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const similarity = jaro(a, b);
  if (similarity <= 0.7) {
    return similarity;
  }
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  return similarity + 0.1 * prefix * (1 - similarity);
}

/**
 * clap's `did_you_mean`: everything above 0.7 confidence, sorted ascending by
 * confidence — clap does not reverse, so the closest match is listed last.
 */
export function didYouMean(value: string, candidates: Iterable<string>): string[] {
  const scored: { confidence: number; candidate: string }[] = [];
  for (const candidate of candidates) {
    const confidence = jaroWinkler(value, candidate);
    if (confidence > 0.7) {
      scored.push({ confidence, candidate });
    }
  }
  scored.sort((a, b) => a.confidence - b.confidence);
  return scored.map((entry) => entry.candidate);
}

function suggestionTip(subject: "subcommand" | "argument" | "value", matches: readonly string[]): string | null {
  if (matches.length === 0) {
    return null;
  }
  const quoted = matches.map((m) => `'${m}'`).join(", ");
  return matches.length === 1
    ? `a similar ${subject} exists: ${quoted}`
    : `some similar ${subject}s exist: ${quoted}`;
}

// ─── Help rendering ──────────────────────────────────────────────────────────

const HELP_ARG: Arg = { id: "help", short: "h", long: "help", help: "Print help" };
const VERSION_ARG: Arg = { id: "version", short: "V", long: "version", help: "Print version" };

/** Every arg a command accepts, including the ones inherited from its parents. */
function argsOf(command: Command, inherited: readonly Arg[]): Arg[] {
  return [...(command.args ?? []), ...inherited];
}

function visibleSubcommands(command: Command): readonly Command[] {
  return command.hideSubcommands === true ? [] : (command.subcommands ?? []);
}

function flagColumn(arg: Arg): string {
  const head = arg.short === undefined ? "    " : `-${arg.short}, `;
  const value = arg.valueName === undefined ? "" : ` <${arg.valueName}>`;
  return `${head}--${arg.long}${value}`;
}

function positionalColumn(positional: Positional): string {
  const inner = positional.required ? `<${positional.valueName}>` : `[${positional.valueName}]`;
  return positional.multiple ? `${inner}...` : inner;
}

function annotatedHelp(help: string, defaultValue: string | undefined, possibleValues: readonly string[] | undefined): string {
  let text = help;
  if (defaultValue !== undefined) {
    text += `${text === "" ? "" : " "}[default: ${defaultValue}]`;
  }
  if (possibleValues !== undefined) {
    text += `${text === "" ? "" : " "}[possible values: ${possibleValues.join(", ")}]`;
  }
  return text;
}

/** One help section: a two-column list padded to its own widest entry. */
function section(title: string, entries: readonly { column: string; help: string }[]): string | null {
  if (entries.length === 0) {
    return null;
  }
  const width = Math.max(...entries.map((entry) => entry.column.length)) + 2;
  const lines = entries.map((entry) => `  ${entry.column.padEnd(width, " ")}${entry.help}`);
  return `${title}:\n${lines.join("\n")}`;
}

function allArgs(command: Command, inherited: readonly Arg[]): string {
  const sections: string[] = [];

  const commands = section(
    "Commands",
    visibleSubcommands(command).map((sub) => ({ column: sub.name, help: sub.about ?? "" })),
  );
  if (commands !== null) {
    sections.push(commands);
  }

  const argumentEntries = (command.positionals ?? []).map((positional) => ({
    column: positionalColumn(positional),
    help: annotatedHelp(positional.help ?? "", undefined, positional.possibleValues),
  }));
  const argumentSection = section("Arguments", argumentEntries);
  if (argumentSection !== null) {
    sections.push(argumentSection);
  }

  const options = [...argsOf(command, inherited), HELP_ARG, VERSION_ARG].map((arg) => ({
    column: flagColumn(arg),
    help: annotatedHelp(arg.help, arg.defaultValue, arg.possibleValues),
  }));
  const optionSection = section("Options", options);
  if (optionSection !== null) {
    sections.push(optionSection);
  }

  return sections.join("\n\n");
}

/** The full `Usage:` line: everything the command accepts. */
export function fullUsage(command: Command, binPath: string, inherited: readonly Arg[]): string {
  const parts = [binPath];
  if (argsOf(command, inherited).length > 0) {
    parts.push("[OPTIONS]");
  }
  for (const positional of command.positionals ?? []) {
    parts.push(positionalColumn(positional));
  }
  const subcommands = visibleSubcommands(command);
  if (subcommands.length > 0) {
    parts.push(command.subcommandRequired === true ? "<COMMAND>" : "[COMMAND]");
  }
  return parts.join(" ");
}

const DEFAULT_TEMPLATE = "{before-help}{about-with-newline}{usage-heading} {usage}\n\n{all-args}{after-help}";

/** Renders `--help` for `command`. clap appends the trailing newline itself. */
export function renderHelp(command: Command, binPath: string, inherited: readonly Arg[]): string {
  const template = command.helpTemplate ?? DEFAULT_TEMPLATE;
  const about = command.about ?? "";
  const substitutions: ReadonlyMap<string, string> = new Map([
    ["before-help", ""],
    ["after-help", ""],
    ["name", command.displayName],
    ["version", command.version],
    ["author", command.author ?? ""],
    ["about", about],
    ["about-with-newline", about === "" ? "" : `${about}\n\n`],
    ["usage-heading", "Usage:"],
    ["usage", fullUsage(command, binPath, inherited)],
    ["all-args", allArgs(command, inherited)],
    ["tab", "  "],
  ]);

  return `${template.replace(/\{([a-z-]+)\}/g, (whole, key: string) => substitutions.get(key) ?? whole)}\n`;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

interface Frame {
  readonly command: Command;
  readonly binPath: string;
  readonly inherited: readonly Arg[];
}

/**
 * The parser's running record of what it has seen, which is what clap turns
 * into the `Usage:` line of an error. Flags are listed in the order they were
 * given; a positional that was supplied is rendered `<LIKE_THIS>` even when it
 * is optional.
 */
interface Seen {
  readonly args: Arg[];
  readonly positionals: Set<string>;
}

function findLong(args: readonly Arg[], name: string): Arg | undefined {
  return args.find((arg) => arg.long === name || (arg.aliases ?? []).includes(name));
}

function findShort(args: readonly Arg[], name: string): Arg | undefined {
  return args.find((arg) => arg.short === name);
}

/** Whether a dash-leading token names a flag this command would accept. */
function looksKnown(token: string, available: readonly Arg[]): boolean {
  if (token.startsWith("--")) {
    const name = token.slice(2).split("=", 1)[0]!;
    return name === "help" || name === "version" || findLong(available, name) !== undefined;
  }
  const letter = token[1];
  return letter === "h" || letter === "V" || (letter !== undefined && findShort(available, letter) !== undefined);
}

function argUsage(arg: Arg): string {
  return arg.valueName === undefined ? `--${arg.long}` : `--${arg.long} <${arg.valueName}>`;
}

/** clap's "smart" usage: the args seen so far, the positionals, then `<COMMAND>`. */
function smartUsage(frame: Frame, seen: Seen): string {
  const parts = [frame.binPath, ...seen.args.map(argUsage)];
  for (const positional of frame.command.positionals ?? []) {
    const required = positional.required || seen.positionals.has(positional.id);
    const inner = required ? `<${positional.valueName}>` : `[${positional.valueName}]`;
    parts.push(positional.multiple ? `${inner}...` : inner);
  }
  if (visibleSubcommands(frame.command).length > 0 && frame.command.subcommandRequired === true) {
    parts.push("<COMMAND>");
  }
  return parts.join(" ");
}

function possibleValuesNote(possibleValues: readonly string[] | undefined): string {
  return possibleValues === undefined ? "" : `\n  [possible values: ${possibleValues.join(", ")}]`;
}

function invalidValue(value: string, forWhat: string, possibleValues: readonly string[]): ClapError {
  // clap keeps only the closest possible value, so this tip is always singular.
  const matches = didYouMean(value, possibleValues);
  const closest = matches[matches.length - 1];
  return parseError(
    `invalid value '${value}' for '${forWhat}'${possibleValuesNote(possibleValues)}`,
    suggestionTip("value", closest === undefined ? [] : [closest]),
    null,
  );
}

/**
 * Parses `argv` (without the program name) against `command`.
 *
 * `--help` and `--version` are modelled as errors that short-circuit parsing,
 * exactly as clap models them.
 */
export function parse(command: Command, argv: readonly string[], binName: string): Matches {
  return parseFrame({ command, binPath: binName, inherited: [] }, argv);
}

function parseFrame(frame: Frame, argv: readonly string[]): Matches {
  const { command } = frame;
  const available = argsOf(command, frame.inherited);
  const positionals = command.positionals ?? [];
  const subcommands = command.subcommands ?? [];

  const values = new Map<string, MatchedValue>();
  const seen: Seen = { args: [], positionals: new Set() };
  const positionalValues: string[] = [];
  let subcommand: Matches | null = null;
  let endOfFlags = false;

  const markUsed = (arg: Arg): void => {
    if (!seen.args.includes(arg)) {
      seen.args.push(arg);
    }
  };

  const missingValue = (arg: Arg): ClapError =>
    parseError(
      `a value is required for '${argUsage(arg)}' but none was supplied${possibleValuesNote(arg.possibleValues)}`,
      null,
      null,
    );

  const takeValue = (arg: Arg, attached: string | null, index: number): { value: string; next: number } => {
    if (attached !== null) {
      return { value: attached, next: index + 1 };
    }
    const candidate = argv[index + 1];
    if (candidate === undefined) {
      throw missingValue(arg);
    }
    // clap never consumes a detached value that looks like a flag; a bare `-`
    // is fine. A recognised flag reports the missing value, an unrecognised one
    // is reported as the unexpected argument it is.
    if (candidate.startsWith("-") && candidate !== "-") {
      throw looksKnown(candidate, available)
        ? missingValue(arg)
        : unknownArgument(frame, seen, candidate, available, subcommands);
    }
    return { value: candidate, next: index + 2 };
  };

  const storeValue = (arg: Arg, raw: string): void => {
    if (arg.possibleValues !== undefined && !arg.possibleValues.includes(raw)) {
      throw invalidValue(raw, argUsage(arg), arg.possibleValues);
    }
    if (arg.valueParser === "f64" && !isRustFloat(raw)) {
      throw parseError(`invalid value '${raw}' for '${argUsage(arg)}': invalid float literal`, null, null);
    }
    values.set(arg.id, raw);
    markUsed(arg);
  };

  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;

    if (!endOfFlags && token === "--") {
      endOfFlags = true;
      i += 1;
      continue;
    }

    if (!endOfFlags && token.startsWith("--") && token.length > 2) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const attached = eq === -1 ? null : body.slice(eq + 1);

      if (name === "help" || name === "version") {
        const arg = name === "help" ? HELP_ARG : VERSION_ARG;
        if (attached !== null) {
          markUsed(arg);
          throw parseError(
            `unexpected value '${attached}' for '--${name}' found; no more were expected`,
            null,
            smartUsage(frame, seen),
          );
        }
        throw name === "help" ? displayHelp(frame) : displayVersion(command);
      }

      const arg = findLong(available, name);
      if (arg === undefined) {
        throw unknownArgument(frame, seen, token, available, subcommands);
      }
      if (arg.valueName === undefined) {
        values.set(arg.id, true);
        markUsed(arg);
        i += 1;
      } else {
        const { value, next } = takeValue(arg, attached, i);
        storeValue(arg, value);
        i = next;
      }
      continue;
    }

    if (!endOfFlags && token.length > 1 && token.startsWith("-")) {
      const letters = Array.from(token.slice(1));
      let next = i + 1;
      for (const [offset, letter] of letters.entries()) {
        if (letter === "h") {
          throw displayHelp(frame);
        }
        if (letter === "V") {
          throw displayVersion(command);
        }
        const arg = findShort(available, letter);
        if (arg === undefined) {
          throw unknownArgument(frame, seen, `-${letter}`, available, subcommands);
        }
        if (arg.valueName === undefined) {
          values.set(arg.id, true);
          markUsed(arg);
            continue;
        }
        // A short option swallows the rest of its token as the value.
        const tail = letters.slice(offset + 1).join("");
        const attached = tail === "" ? null : tail.startsWith("=") ? tail.slice(1) : tail;
        const taken = takeValue(arg, attached, i);
        storeValue(arg, taken.value);
        next = taken.next;
        break;
      }
      i = next;
      continue;
    }

    // A bare token: a subcommand where the command has any, else a positional.
    // After `--` nothing is a subcommand any more.
    if (!endOfFlags && subcommands.length > 0 && positionals.length === 0) {
      const match = subcommands.find((sub) => sub.name === token);
      if (match === undefined) {
        throw parseError(
          `unrecognized subcommand '${token}'`,
          suggestionTip("subcommand", didYouMean(token, subcommands.map((sub) => sub.name))),
          fullUsage(command, frame.binPath, frame.inherited),
        );
      }
      subcommand = parseFrame(
        {
          command: match,
          binPath: `${frame.binPath} ${match.name}`,
          inherited: available.filter((arg) => arg.global === true),
        },
        argv.slice(i + 1),
      );
      i = argv.length;
      break;
    }

    positionalValues.push(token);
    i += 1;
  }

  if (subcommand !== null) {
    return { command, values, subcommand };
  }

  assignPositionals(frame, seen, positionals, positionalValues, values, subcommands);
  checkConflicts(frame, seen, available, values);

  // `arg_required_else_help`, which clap derive sets on a command whose
  // subcommand is mandatory. A lone `--` does not count as an argument.
  if (command.argRequiredElseHelp === true && argv.every((token) => token === "--")) {
    throw displayHelpOnMissing(frame);
  }

  if (subcommands.length > 0 && command.subcommandRequired === true) {
    throw parseError(
      `'${frame.binPath}' requires a subcommand but one was not provided\n  [subcommands: ${subcommands.map((sub) => sub.name).join(", ")}]`,
      null,
      fullUsage(command, frame.binPath, frame.inherited),
    );
  }

  const missing = positionals.filter((positional) => positional.required && !values.has(positional.id));
  if (missing.length > 0) {
    throw parseError(
      `the following required arguments were not provided:\n${missing.map((p) => `  ${positionalColumn(p)}`).join("\n")}`,
      null,
      smartUsage(frame, seen),
    );
  }

  for (const arg of available) {
    if (arg.defaultValue !== undefined && !values.has(arg.id)) {
      values.set(arg.id, arg.defaultValue);
    }
  }

  return { command, values, subcommand: null };
}

function assignPositionals(
  frame: Frame,
  seen: Seen,
  positionals: readonly Positional[],
  provided: readonly string[],
  values: Map<string, MatchedValue>,
  subcommands: readonly Command[],
): void {
  let index = 0;
  for (const positional of positionals) {
    if (positional.multiple) {
      const rest = provided.slice(index);
      index = provided.length;
      if (rest.length > 0) {
        values.set(positional.id, rest);
        seen.positionals.add(positional.id);
      }
      continue;
    }
    const value = provided[index];
    if (value === undefined) {
      continue;
    }
    index += 1;
    const canonical = positional.valueAliases?.[value] ?? value;
    if (positional.possibleValues !== undefined && !positional.possibleValues.includes(canonical)) {
      throw invalidValue(value, `<${positional.valueName}>`, positional.possibleValues);
    }
    values.set(positional.id, canonical);
    seen.positionals.add(positional.id);
  }

  const extra = provided[index];
  if (extra !== undefined) {
    const isSubcommand = subcommands.some((sub) => sub.name === extra);
    throw parseError(
      `unexpected argument '${extra}' found`,
      isSubcommand ? `subcommand '${extra}' exists; to use it, remove the '--' before it` : null,
      fullUsage(frame.command, frame.binPath, frame.inherited),
    );
  }
}

/**
 * clap validates conflicts once parsing is done, walking the args in the order
 * they were given, so `-i -l` blames `--interactive` and `-l -i` blames
 * `--list`.
 */
function checkConflicts(
  frame: Frame,
  seen: Seen,
  available: readonly Arg[],
  values: ReadonlyMap<string, MatchedValue>,
): void {
  for (const arg of seen.args) {
    for (const otherId of arg.conflictsWith ?? []) {
      if (otherId === arg.id || !values.has(otherId)) {
        continue;
      }
      const other = available.find((candidate) => candidate.id === otherId);
      if (other === undefined) {
        continue;
      }
      throw parseError(
        `the argument '--${arg.long}' cannot be used with '--${other.long}'`,
        null,
        smartUsage(frame, { args: [arg], positionals: seen.positionals }),
      );
    }
  }
}

/**
 * `unexpected argument …`. clap adds the suggested flag to the usage line, so a
 * near miss reports the usage the user probably meant; with nothing seen at all
 * it falls back to the command's full usage.
 */
function unknownArgument(
  frame: Frame,
  seen: Seen,
  token: string,
  available: readonly Arg[],
  subcommands: readonly Command[],
): ClapError {
  const bare = token.replace(/^--?/, "");
  const longs = [...available.map((arg) => arg.long), "help", "version"];
  const suggestions = token.startsWith("--") ? didYouMean(bare, longs) : [];
  const suggestion = suggestions[suggestions.length - 1];

  let tip: string | null = null;
  if (suggestion !== undefined) {
    tip = suggestionTip("argument", [`--${suggestion}`]);
  } else if (subcommands.some((sub) => sub.name === token)) {
    tip = `subcommand '${token}' exists; to use it, remove the '--' before it`;
  } else if ((frame.command.positionals ?? []).length > 0) {
    tip = `to pass '${token}' as a value, use '-- ${token}'`;
  }

  const used = { args: [...seen.args], positionals: seen.positionals };
  const suggested = suggestion === undefined ? undefined : available.find((arg) => arg.long === suggestion);
  if (suggested !== undefined && !used.args.includes(suggested)) {
    used.args.push(suggested);
  }

  const usage =
    used.args.length === 0 && used.positionals.size === 0
      ? fullUsage(frame.command, frame.binPath, frame.inherited)
      : smartUsage(frame, used);
  return parseError(`unexpected argument '${token}' found`, tip, usage);
}

function displayHelp(frame: Frame): ClapError {
  return new ClapError([renderHelp(frame.command, frame.binPath, frame.inherited).replace(/\n$/, "")], 0, false);
}

function displayHelpOnMissing(frame: Frame): ClapError {
  return new ClapError([renderHelp(frame.command, frame.binPath, frame.inherited).replace(/\n$/, "")], 2, true);
}

function displayVersion(command: Command): ClapError {
  return new ClapError([`${command.displayName} ${command.version}`], 0, false);
}

/**
 * clap's `f64` value parser is Rust's `str::parse::<f64>`, which is stricter
 * than `Number()`: no surrounding whitespace, no hex, no separators. `inf`,
 * `infinity` and `nan` are accepted in any case, with an optional sign.
 */
export function isRustFloat(text: string): boolean {
  return (
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ||
    /^[+-]?(?:inf|infinity|nan)$/i.test(text)
  );
}

/** clap's `bin_name`: the file name the program was invoked under. */
export function binNameFrom(argv0: string): string {
  return basename(argv0).replace(/\.(?:ts|mts|cts|js|mjs|cjs)$/, "");
}
