/**
 * Rust's UTF-8 validation, reproduced so that a malformed import record reports
 * the same reason the original prints:
 *
 *   `invalid utf-8 sequence of 1 bytes from index 3`
 *   `incomplete utf-8 byte sequence from index 5`
 *
 * `Buffer.toString("utf8")` cannot be used to detect this — it silently
 * substitutes U+FFFD.
 */

export class Utf8Error extends Error {
  readonly validUpTo: number;
  readonly errorLen: number | null;

  constructor(validUpTo: number, errorLen: number | null) {
    super(
      errorLen === null
        ? `incomplete utf-8 byte sequence from index ${validUpTo}`
        : `invalid utf-8 sequence of ${errorLen} bytes from index ${validUpTo}`,
    );
    this.validUpTo = validUpTo;
    this.errorLen = errorLen;
  }
}

function charWidth(byte: number): number {
  if (byte < 0x80) {
    return 1;
  }
  if (byte >= 0xc2 && byte <= 0xdf) {
    return 2;
  }
  if (byte >= 0xe0 && byte <= 0xef) {
    return 3;
  }
  if (byte >= 0xf0 && byte <= 0xf4) {
    return 4;
  }
  return 0;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

/** `str::from_utf8` — decodes, or throws the error Rust would have produced. */
export function decodeUtf8(bytes: Uint8Array): string {
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i]!;
    const width = charWidth(lead);
    if (width === 0) {
      throw new Utf8Error(i, 1);
    }
    if (width === 1) {
      i += 1;
      continue;
    }

    const second = bytes[i + 1];
    if (second === undefined) {
      throw new Utf8Error(i, null);
    }
    const secondOk =
      width === 2
        ? isContinuation(second)
        : width === 3
          ? (lead === 0xe0 && second >= 0xa0 && second <= 0xbf) ||
            (lead >= 0xe1 && lead <= 0xec && isContinuation(second)) ||
            (lead === 0xed && second >= 0x80 && second <= 0x9f) ||
            (lead >= 0xee && lead <= 0xef && isContinuation(second))
          : (lead === 0xf0 && second >= 0x90 && second <= 0xbf) ||
            (lead >= 0xf1 && lead <= 0xf3 && isContinuation(second)) ||
            (lead === 0xf4 && second >= 0x80 && second <= 0x8f);
    if (!secondOk) {
      throw new Utf8Error(i, 1);
    }

    for (let offset = 2; offset < width; offset += 1) {
      const next = bytes[i + offset];
      if (next === undefined) {
        throw new Utf8Error(i, null);
      }
      if (!isContinuation(next)) {
        throw new Utf8Error(i, offset);
      }
    }
    i += width;
  }

  return Buffer.from(bytes).toString("utf8");
}

/** Rust's `Debug` rendering of a `Path`, which is what `{path:?}` prints. */
export function debugPath(target: string): string {
  let out = '"';
  for (const char of target) {
    if (char === '"' || char === "\\") {
      out += `\\${char}`;
    } else if (char === "\n") {
      out += "\\n";
    } else if (char === "\r") {
      out += "\\r";
    } else if (char === "\t") {
      out += "\\t";
    } else {
      out += char;
    }
  }
  return `${out}"`;
}
