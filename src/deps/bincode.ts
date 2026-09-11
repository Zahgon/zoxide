/**
 * The `bincode` 1.3 wire format, in the configuration zoxide uses.
 *
 * The original writes with the crate's free functions (`serialize_into`) and
 * reads with `bincode::options().with_fixint_encoding().with_limit(MAX_SIZE)`;
 * both are fixed-width integers, little-endian. That gives:
 *
 * - `u32` / `u64`  — 4 / 8 bytes, little-endian
 * - `f64`          — 8 bytes, IEEE-754 little-endian
 * - `String`       — `u64` byte length, then UTF-8 bytes
 * - `Vec<T>`       — `u64` element count, then the elements
 *
 * The format is persistent state shared with other zoxide installations, so
 * these are byte-level requirements, not implementation details.
 */

export class Serializer {
  readonly #chunks: Buffer[] = [];
  #length = 0;

  u32(value: number): void {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32LE(value, 0);
    this.#push(buffer);
  }

  u64(value: bigint): void {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeBigUInt64LE(value, 0);
    this.#push(buffer);
  }

  f64(value: number): void {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleLE(value, 0);
    this.#push(buffer);
  }

  str(value: string): void {
    const bytes = Buffer.from(value, "utf8");
    this.u64(BigInt(bytes.length));
    this.#push(bytes);
  }

  get length(): number {
    return this.#length;
  }

  finish(): Buffer {
    return Buffer.concat(this.#chunks, this.#length);
  }

  #push(buffer: Buffer): void {
    this.#chunks.push(buffer);
    this.#length += buffer.length;
  }
}

/**
 * `bincode::Error`. The wording matters: it reaches the user through
 * `zoxide: could not deserialize database\n\nCaused by: …`.
 */
export class DeserializeError extends Error {}

const UNEXPECTED_EOF = "io error: unexpected end of file";
const SIZE_LIMIT_REACHED = "the size limit has been reached";

export class Deserializer {
  readonly #bytes: Buffer;
  #offset = 0;
  #budget: number;

  /** `budget` is `with_limit(…)`: a byte allowance, not a buffer length. */
  constructor(bytes: Buffer, budget = Number.POSITIVE_INFINITY) {
    this.#bytes = bytes;
    this.#budget = budget;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  u32(): number {
    this.#take(4);
    const value = this.#bytes.readUInt32LE(this.#offset);
    this.#offset += 4;
    return value;
  }

  u64(): bigint {
    this.#take(8);
    const value = this.#bytes.readBigUInt64LE(this.#offset);
    this.#offset += 8;
    return value;
  }

  f64(): number {
    this.#take(8);
    const value = this.#bytes.readDoubleLE(this.#offset);
    this.#offset += 8;
    return value;
  }

  /** A `String`: a `u64` byte length, then validated UTF-8. */
  str(): string {
    const length = this.#length();
    this.#take(length);
    const slice = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    const text = slice.toString("utf8");
    if (Buffer.byteLength(text, "utf8") !== slice.length) {
      throw new DeserializeError("invalid utf-8 sequence");
    }
    return text;
  }

  /**
   * The `u64` element count that prefixes a sequence. It is deliberately not
   * validated against the buffer: bincode reads elements until the input runs
   * out, so a corrupt count surfaces as an unexpected end of file, exactly as
   * the original reports it.
   */
  seqLength(): bigint {
    return this.u64();
  }

  #length(): number {
    const raw = this.u64();
    // A length no buffer could satisfy is an end-of-file, not its own error.
    return raw > BigInt(this.remaining) ? this.remaining + 1 : Number(raw);
  }

  #take(count: number): void {
    if (count > this.#budget) {
      throw new DeserializeError(SIZE_LIMIT_REACHED);
    }
    if (count > this.remaining) {
      throw new DeserializeError(UNEXPECTED_EOF);
    }
    this.#budget -= count;
  }
}

/** `bincode::serialized_size` for the values zoxide serializes. */
export const SIZE_U32 = 4;
