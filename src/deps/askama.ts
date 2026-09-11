/**
 * The slice of Askama 0.16 that `templates/*.txt` actually uses.
 *
 * Askama is a compile-time engine, so the original's shell-integration source
 * is baked into the binary. The templates themselves are data and carry over
 * unchanged, which means the renderer has to move from build time to run time —
 * and has to agree with Askama byte-for-byte, because the result is shell
 * source the user `eval`s.
 *
 * Supported syntax, which is exactly what the nine templates contain:
 *
 * ```text
 * {{ expr }}                                 expression
 * {% let name = "literal" %}                 binding (assigns to an enclosing
 * {% decl name %}                            `decl` when one is visible)
 * {% if cond %} {% else if cond %} {% else %} {% endif %}
 * {% if let Some(name) = expr %}
 * {% match expr %} {% when <pattern> %} … {% endmatch %}
 * ```
 *
 * Whitespace control follows Askama's default `whitespace = "preserve"`: only
 * an explicit `-` suppresses adjacent whitespace, `{%-` before the tag and
 * `-%}` after it.
 *
 * `.txt` templates use Askama's `Text` escaper, i.e. no escaping at all.
 */

/** A value a template can hold: a string, an `Option<&str>`, a flag, or an enum. */
export type Value = string | boolean | null | { readonly enum: string; readonly variant: string };

export interface Scope {
  readonly vars: Map<string, Value>;
  readonly parent: Scope | null;
}

export class TemplateError extends Error {}

// ─── Lexing ──────────────────────────────────────────────────────────────────

interface Literal {
  readonly kind: "literal";
  text: string;
}

interface Tag {
  readonly kind: "tag" | "expr";
  readonly body: string;
  readonly trimBefore: boolean;
  readonly trimAfter: boolean;
}

type Item = Literal | Tag;

const WS_LEFT = /\s+$/;
const WS_RIGHT = /^\s+/;

/**
 * Finds the tag's closing delimiter, skipping over string literals — one of the
 * shell templates emits `{{ "${result:${#__zoxide_z_prefix}}" }}`, whose
 * literal contains the closing `}}`.
 */
function findClose(source: string, from: number, close: string): number {
  let inString = false;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i]!;
    if (inString) {
      if (char === "\\") {
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (source.startsWith(close, i)) {
      return i;
    }
  }
  return -1;
}

function lex(source: string): Item[] {
  const items: Item[] = [];
  let pending = "";
  let i = 0;

  const flush = (): void => {
    items.push({ kind: "literal", text: pending });
    pending = "";
  };

  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open === -1 || open + 1 >= source.length) {
      pending += source.slice(i);
      break;
    }
    const marker = source[open + 1];
    if (marker !== "%" && marker !== "{" && marker !== "#") {
      pending += source.slice(i, open + 1);
      i = open + 1;
      continue;
    }

    pending += source.slice(i, open);
    const close = marker === "%" ? "%}" : marker === "{" ? "}}" : "#}";
    const end = findClose(source, open + 2, close);
    if (end === -1) {
      throw new TemplateError(`unterminated tag at offset ${open}`);
    }

    let body = source.slice(open + 2, end);
    const trimBefore = body.startsWith("-");
    if (trimBefore) {
      body = body.slice(1);
    }
    const trimAfter = body.endsWith("-");
    if (trimAfter) {
      body = body.slice(0, -1);
    }

    if (trimBefore) {
      pending = pending.replace(WS_LEFT, "");
    }
    flush();
    if (marker !== "#") {
      items.push({ kind: marker === "%" ? "tag" : "expr", body: body.trim(), trimBefore, trimAfter });
    }
    i = end + close.length;

    if (trimAfter) {
      const next = source.slice(i).replace(WS_RIGHT, "");
      i = source.length - next.length;
    }
  }

  flush();
  return items;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

type Node =
  | { kind: "literal"; text: string }
  | { kind: "expr"; expr: string }
  | { kind: "decl"; name: string }
  | { kind: "let"; name: string; expr: string }
  | { kind: "if"; branches: { condition: string | null; body: Node[] }[] }
  | { kind: "match"; subject: string; arms: { pattern: string; body: Node[] }[] };

interface Cursor {
  index: number;
}

function parseBlock(items: readonly Item[], cursor: Cursor, terminators: readonly string[]): { body: Node[]; terminator: string } {
  const body: Node[] = [];

  while (cursor.index < items.length) {
    const item = items[cursor.index]!;
    if (item.kind === "literal") {
      cursor.index += 1;
      if (item.text !== "") {
        body.push({ kind: "literal", text: item.text });
      }
      continue;
    }
    if (item.kind === "expr") {
      cursor.index += 1;
      body.push({ kind: "expr", expr: item.body });
      continue;
    }

    const keyword = item.body.split(/\s/, 1)[0] ?? "";
    if (terminators.includes(keyword)) {
      cursor.index += 1;
      return { body, terminator: item.body };
    }

    cursor.index += 1;
    switch (keyword) {
      case "decl":
        body.push({ kind: "decl", name: item.body.slice("decl".length).trim() });
        break;
      case "let": {
        const rest = item.body.slice("let".length).trim();
        const eq = rest.indexOf("=");
        if (eq === -1) {
          body.push({ kind: "decl", name: rest });
        } else {
          body.push({ kind: "let", name: rest.slice(0, eq).trim(), expr: rest.slice(eq + 1).trim() });
        }
        break;
      }
      case "if": {
        const branches: { condition: string | null; body: Node[] }[] = [];
        let condition: string | null = item.body.slice("if".length).trim();
        for (;;) {
          const block = parseBlock(items, cursor, ["else", "endif"]);
          branches.push({ condition, body: block.body });
          if (block.terminator === "endif") {
            break;
          }
          const elseRest = block.terminator.slice("else".length).trim();
          condition = elseRest.startsWith("if") ? elseRest.slice("if".length).trim() : null;
        }
        body.push({ kind: "if", branches });
        break;
      }
      case "match": {
        const subject = item.body.slice("match".length).trim();
        const arms: { pattern: string; body: Node[] }[] = [];
        // Anything between `match` and the first `when` is discarded, as
        // Askama discards it.
        let head = parseBlock(items, cursor, ["when", "endmatch"]);
        while (head.terminator !== "endmatch") {
          const pattern = head.terminator.slice("when".length).trim();
          head = parseBlock(items, cursor, ["when", "endmatch"]);
          arms.push({ pattern, body: head.body });
        }
        body.push({ kind: "match", subject, arms });
        break;
      }
      default:
        throw new TemplateError(`unsupported template tag: {% ${item.body} %}`);
    }
  }

  if (terminators.length > 0) {
    // Askama rejects an unclosed block at compile time; so does this.
    throw new TemplateError(`unterminated block, expected one of: ${terminators.join(", ")}`);
  }
  return { body, terminator: "" };
}

// ─── Expressions ─────────────────────────────────────────────────────────────

const STRING_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["0", "\0"],
  ["\\", "\\"],
  ['"', '"'],
  ["'", "'"],
]);

function parseStringLiteral(text: string): string {
  let out = "";
  for (let i = 1; i < text.length - 1; i += 1) {
    const char = text[i]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    i += 1;
    const escape = text[i]!;
    const mapped = STRING_ESCAPES.get(escape);
    if (mapped === undefined) {
      throw new TemplateError(`unsupported escape \\${escape} in string literal`);
    }
    out += mapped;
  }
  return out;
}

function lookup(scope: Scope, name: string): { scope: Scope; value: Value } | null {
  for (let current: Scope | null = scope; current !== null; current = current.parent) {
    const value = current.vars.get(name);
    if (value !== undefined || current.vars.has(name)) {
      return { scope: current, value: value ?? null };
    }
  }
  return null;
}

function evaluate(expr: string, scope: Scope): Value {
  const text = expr.trim();

  if (text.startsWith('"')) {
    return parseStringLiteral(text);
  }
  if (text === "cfg!(windows)") {
    return process.platform === "win32";
  }

  const unwrapOr = /^([A-Za-z_][A-Za-z0-9_]*)\.unwrap_or\((".*")\)$/.exec(text);
  if (unwrapOr !== null) {
    const value = evaluate(unwrapOr[1]!, scope);
    return value === null ? parseStringLiteral(unwrapOr[2]!) : value;
  }

  const enumPath = /^([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  if (enumPath !== null) {
    return { enum: enumPath[1]!, variant: enumPath[2]! };
  }

  const comparison = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(text);
  if (comparison !== null) {
    const left = evaluate(comparison[1]!, scope);
    const right = evaluate(comparison[3]!, scope);
    return comparison[2] === "==" ? valueEquals(left, right) : !valueEquals(left, right);
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    const found = lookup(scope, text);
    if (found === null) {
      throw new TemplateError(`unknown template variable: ${text}`);
    }
    return found.value;
  }

  throw new TemplateError(`unsupported template expression: ${text}`);
}

function valueEquals(left: Value, right: Value): boolean {
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    return left.enum === right.enum && left.variant === right.variant;
  }
  return left === right;
}

function display(value: Value): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  throw new TemplateError("cannot display this value");
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function child(parent: Scope): Scope {
  return { vars: new Map(), parent };
}

function renderNodes(nodes: readonly Node[], scope: Scope, declared: Set<string>): string {
  let out = "";

  for (const node of nodes) {
    switch (node.kind) {
      case "literal":
        out += node.text;
        break;
      case "expr":
        out += display(evaluate(node.expr, scope));
        break;
      case "decl":
        declared.add(node.name);
        scope.vars.set(node.name, null);
        break;
      case "let": {
        const value = evaluate(node.expr, scope);
        const existing = declared.has(node.name) ? lookup(scope, node.name) : null;
        // A `let` on a name an enclosing `decl` introduced assigns to it, which
        // is how the templates set `pwd` inside an `if` and read it after.
        (existing?.scope ?? scope).vars.set(node.name, value);
        break;
      }
      case "if": {
        for (const branch of node.branches) {
          if (branch.condition === null || conditionHolds(branch.condition, scope)) {
            const inner = child(scope);
            if (branch.condition !== null) {
              bindIfLet(branch.condition, scope, inner);
            }
            out += renderNodes(branch.body, inner, declared);
            break;
          }
        }
        break;
      }
      case "match": {
        const subject = evaluate(node.subject, scope);
        for (const arm of node.arms) {
          const inner = child(scope);
          if (matchesPattern(arm.pattern, subject, inner)) {
            out += renderNodes(arm.body, inner, declared);
            break;
          }
        }
        break;
      }
    }
  }

  return out;
}

const IF_LET = /^let\s+Some\(([A-Za-z_][A-Za-z0-9_]*)\)\s*=\s*(.+)$/;

function conditionHolds(condition: string, scope: Scope): boolean {
  const ifLet = IF_LET.exec(condition);
  if (ifLet !== null) {
    return evaluate(ifLet[2]!, scope) !== null;
  }
  const value = evaluate(condition, scope);
  if (typeof value !== "boolean") {
    throw new TemplateError(`condition is not a boolean: ${condition}`);
  }
  return value;
}

function bindIfLet(condition: string, scope: Scope, inner: Scope): void {
  const ifLet = IF_LET.exec(condition);
  if (ifLet !== null) {
    inner.vars.set(ifLet[1]!, evaluate(ifLet[2]!, scope));
  }
}

const WHEN_SOME = /^Some\s+with\s*\(([A-Za-z_][A-Za-z0-9_]*)\)$/;

function matchesPattern(pattern: string, subject: Value, inner: Scope): boolean {
  if (pattern === "_") {
    return true;
  }
  if (pattern === "None") {
    return subject === null;
  }
  const some = WHEN_SOME.exec(pattern);
  if (some !== null) {
    if (subject === null) {
      return false;
    }
    inner.vars.set(some[1]!, subject);
    return true;
  }
  const enumPath = /^([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/.exec(pattern);
  if (enumPath !== null) {
    return valueEquals(subject, { enum: enumPath[1]!, variant: enumPath[2]! });
  }
  throw new TemplateError(`unsupported match pattern: ${pattern}`);
}

/**
 * Renders `source` with `vars` as the root scope.
 *
 * Askama drops the single trailing newline a template file ends with, so the
 * `writeln!` in `zoxide init` supplies the only one the output has.
 */
export function render(source: string, vars: ReadonlyMap<string, Value>): string {
  const items = lex(source.endsWith("\n") ? source.slice(0, -1) : source);
  const { body } = parseBlock(items, { index: 0 }, []);
  const scope: Scope = { vars: new Map(vars), parent: null };
  return renderNodes(body, scope, new Set());
}
