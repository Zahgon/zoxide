/**
 * A reimplementation of the observable surface of the `anyhow` crate.
 *
 * Only two things about `anyhow` are visible to a zoxide user, and both are
 * reproduced here exactly:
 *
 * - `{:?}` (`Debug`) — used by `main` to print a failed command. It renders the
 *   top-level message, then, when the error has sources, a `Caused by:` block:
 *   a single source is indented by four spaces, several sources are numbered
 *   `{: >5}: ` with seven-space continuation.
 * - `{:#}` (alternate `Display`) — used by the importers to print one bad
 *   record per line. It joins the whole chain with `": "`.
 *
 * Backtraces are deliberately absent: `main` clears `RUST_BACKTRACE` and
 * `RUST_LIB_BACKTRACE` before doing anything else, so the original never
 * renders one either.
 */

/** Wraps `error` with an additional layer of context, like `Context::context`. */
export function context(error: unknown, message: string): Error {
  return new Error(message, { cause: toError(error) });
}

/** Coerces an unknown thrown value into an `Error`, like `anyhow!`. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The error and each of its transitive causes, outermost first. */
export function chain(error: unknown): Error[] {
  const errors: Error[] = [];
  let current: unknown = toError(error);
  while (current instanceof Error) {
    errors.push(current);
    current = current.cause;
  }
  return errors;
}

/** `format!("{:#}", err)` — the whole chain joined with `": "`. */
export function formatAlternate(error: unknown): string {
  return chain(error)
    .map((e) => e.message)
    .join(": ");
}

/** `format!("{:?}", err)` with backtraces disabled. */
export function formatDebug(error: unknown): string {
  const errors = chain(error);
  const [head, ...causes] = errors;
  let out = head === undefined ? "" : head.message;
  if (causes.length === 0) {
    return out;
  }

  out += "\n\nCaused by:";
  const numbered = causes.length > 1;
  for (const [index, cause] of causes.entries()) {
    out += "\n" + indent(cause.message, numbered ? index : null);
  }
  return out;
}

/**
 * `anyhow`'s `Indented` writer: an unnumbered entry is prefixed with four
 * spaces, a numbered one with the index right-aligned in five columns followed
 * by `": "`. Continuation lines line up under the text either way.
 */
function indent(text: string, number: number | null): string {
  const first = number === null ? "    " : `${String(number).padStart(5, " ")}: `;
  const rest = number === null ? "    " : "       ";
  const lines = text.split("\n");
  return lines
    .map((line, index) => (index === 0 ? first : rest) + line)
    .join("\n");
}
