/**
 * `glob::Pattern` from the `glob` 0.3 crate, matching its default
 * `MatchOptions` (case sensitive, `*` crosses path separators, leading dots are
 * not special).
 *
 * zoxide exposes this to users through `_ZO_EXCLUDE_DIRS`, so both the matching
 * semantics and the `Pattern syntax error near position N: …` text are part of
 * the contract.
 */

import { sep as PATH_SEP } from "node:path";

const ERROR_WILDCARDS = "wildcards are either regular `*` or recursive `**`";
const ERROR_RECURSIVE_WILDCARDS = "recursive wildcards must form a single path component";

export class PatternError extends Error {
  readonly pos: number;
  readonly msg: string;

  constructor(pos: number, msg: string) {
    super(`Pattern syntax error near position ${pos}: ${msg}`);
    this.pos = pos;
    this.msg = msg;
  }
}

type CharSpecifier = { kind: "single"; char: string } | { kind: "range"; start: string; end: string };

type Token =
  | { kind: "char"; char: string }
  | { kind: "any-char" }
  | { kind: "any-sequence" }
  | { kind: "any-recursive-sequence" }
  | { kind: "any-within"; specifiers: CharSpecifier[] }
  | { kind: "any-except"; specifiers: CharSpecifier[] };

function isSeparator(char: string): boolean {
  return char === "/" || (PATH_SEP === "\\" && char === "\\");
}

function parseCharSpecifiers(chars: readonly string[]): CharSpecifier[] {
  const specifiers: CharSpecifier[] = [];
  let i = 0;
  while (i < chars.length) {
    if (i + 3 <= chars.length && chars[i + 1] === "-") {
      specifiers.push({ kind: "range", start: chars[i]!, end: chars[i + 2]! });
      i += 3;
    } else {
      specifiers.push({ kind: "single", char: chars[i]! });
      i += 1;
    }
  }
  return specifiers;
}

function inCharSpecifiers(specifiers: readonly CharSpecifier[], char: string): boolean {
  for (const specifier of specifiers) {
    if (specifier.kind === "single") {
      if (specifier.char === char) {
        return true;
      }
    } else if (specifier.start <= char && char <= specifier.end) {
      return true;
    }
  }
  return false;
}

export class Pattern {
  readonly original: string;
  readonly #tokens: Token[];

  private constructor(original: string, tokens: Token[]) {
    this.original = original;
    this.#tokens = tokens;
  }

  /** `Pattern::new`. */
  static new(pattern: string): Pattern {
    const chars = Array.from(pattern);
    const tokens: Token[] = [];
    let i = 0;

    while (i < chars.length) {
      const char = chars[i]!;
      if (char === "?") {
        tokens.push({ kind: "any-char" });
        i += 1;
      } else if (char === "*") {
        const old = i;
        while (i < chars.length && chars[i] === "*") {
          i += 1;
        }
        const count = i - old;
        if (count > 2) {
          throw new PatternError(old + 2, ERROR_WILDCARDS);
        } else if (count === 2) {
          // `**` may only be an entire path component: `a/**/b` is valid,
          // `a**/b` and `a/**b` are not.
          if (old !== 0 && chars[old - 1] !== "/") {
            throw new PatternError(old - 1, ERROR_RECURSIVE_WILDCARDS);
          }
          if (i < chars.length && chars[i] === "/") {
            // `**/` swallows its separator, so `a/**/b` also matches `a/b`.
            i += 1;
          } else if (i !== chars.length) {
            throw new PatternError(i, ERROR_RECURSIVE_WILDCARDS);
          }
          // Consecutive recursive wildcards collapse into one.
          if (tokens[tokens.length - 1]?.kind !== "any-recursive-sequence") {
            tokens.push({ kind: "any-recursive-sequence" });
          }
        } else {
          tokens.push({ kind: "any-sequence" });
        }
      } else if (char === "[") {
        if (i + 4 <= chars.length && chars[i + 1] === "!") {
          const j = chars.slice(i + 3).indexOf("]");
          if (j >= 0) {
            tokens.push({ kind: "any-except", specifiers: parseCharSpecifiers(chars.slice(i + 2, i + 3 + j)) });
            i += j + 4;
          } else {
            tokens.push({ kind: "char", char: "[" });
            i += 1;
          }
        } else if (i + 3 <= chars.length && chars[i + 1] !== "!") {
          const j = chars.slice(i + 2).indexOf("]");
          if (j >= 0) {
            tokens.push({ kind: "any-within", specifiers: parseCharSpecifiers(chars.slice(i + 1, i + 2 + j)) });
            i += j + 3;
          } else {
            tokens.push({ kind: "char", char: "[" });
            i += 1;
          }
        } else {
          tokens.push({ kind: "char", char: "[" });
          i += 1;
        }
      } else {
        tokens.push({ kind: "char", char });
        i += 1;
      }
    }

    return new Pattern(pattern, tokens);
  }

  /** `Pattern::escape` — wraps each of `?*[]` in a one-character class. */
  static escape(text: string): string {
    let escaped = "";
    for (const char of text) {
      escaped += char === "?" || char === "*" || char === "[" || char === "]" ? `[${char}]` : char;
    }
    return escaped;
  }

  /** `Pattern::matches` with the crate's default `MatchOptions`. */
  matches(text: string): boolean {
    return this.#matchesFrom(true, Array.from(text), 0, 0) === "match";
  }

  toString(): string {
    return this.original;
  }

  #matchesFrom(
    followsSeparator: boolean,
    chars: readonly string[],
    charIndex: number,
    tokenIndex: number,
  ): "match" | "sub-pattern-doesnt-match" | "entire-pattern-doesnt-match" {
    let follows = followsSeparator;
    let at = charIndex;

    for (let ti = tokenIndex; ti < this.#tokens.length; ti += 1) {
      const token = this.#tokens[ti]!;
      if (token.kind === "any-sequence" || token.kind === "any-recursive-sequence") {
        // Try the empty match first, then grow it one character at a time.
        const empty = this.#matchesFrom(follows, chars, at, ti + 1);
        if (empty !== "sub-pattern-doesnt-match") {
          return empty;
        }
        let cursor = at;
        let cursorFollows = follows;
        while (cursor < chars.length) {
          const char = chars[cursor]!;
          cursor += 1;
          cursorFollows = isSeparator(char);
          if (token.kind === "any-recursive-sequence" && !cursorFollows) {
            continue;
          }
          const result = this.#matchesFrom(cursorFollows, chars, cursor, ti + 1);
          if (result !== "sub-pattern-doesnt-match") {
            return result;
          }
        }
        return "sub-pattern-doesnt-match";
      }

      if (at >= chars.length) {
        return "entire-pattern-doesnt-match";
      }
      const char = chars[at]!;
      at += 1;

      let ok: boolean;
      switch (token.kind) {
        case "any-char":
          ok = true;
          break;
        case "any-within":
          ok = inCharSpecifiers(token.specifiers, char);
          break;
        case "any-except":
          ok = !inCharSpecifiers(token.specifiers, char);
          break;
        case "char":
          ok = char === token.char;
          break;
      }
      if (!ok) {
        return "sub-pattern-doesnt-match";
      }
      follows = isSeparator(char);
    }

    return at === chars.length ? "match" : "sub-pattern-doesnt-match";
  }
}
