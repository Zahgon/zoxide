/**
 * Rust's `format!("{:.N}")` for `f64`.
 *
 * `Number.prototype.toFixed` is not a substitute: it resolves an exact tie by
 * rounding away from zero, while Rust rounds half to even. `format!("{:.1}",
 * 0.25)` is `0.2`; `(0.25).toFixed(1)` is `0.3`. The score column that
 * `zoxide query --score` and the fzf feed both print is exactly one decimal
 * place wide, so the difference is user-visible.
 *
 * The digits are produced from the double's own bits with `BigInt`, so no
 * intermediate rounding is introduced by the conversion itself.
 */

const MANTISSA_BITS = 52n;
const EXPONENT_MASK = 0x7ffn;

/** Decomposes a finite double into an exact `mantissa * 2 ** exponent`. */
function decompose(value: number): { mantissa: bigint; exponent: bigint } {
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value);
  const bits = buffer.getBigUint64(0);
  const rawExponent = (bits >> MANTISSA_BITS) & EXPONENT_MASK;
  const rawMantissa = bits & ((1n << MANTISSA_BITS) - 1n);

  return rawExponent === 0n
    ? { mantissa: rawMantissa, exponent: -1074n }
    : { mantissa: rawMantissa | (1n << MANTISSA_BITS), exponent: rawExponent - 1075n };
}

/** `format!("{:.decimals$}", value)` for a finite, non-negative-zero-agnostic `f64`. */
export function formatFixed(value: number, decimals: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "inf" : "-inf";
  }

  const negative = value < 0 || Object.is(value, -0);
  const { mantissa, exponent } = decompose(Math.abs(value));
  const scale = 10n ** BigInt(decimals);

  // `|value| * 10 ** decimals` as an exact fraction, then round half to even.
  let numerator = mantissa * scale;
  let denominator = 1n;
  if (exponent >= 0n) {
    numerator <<= exponent;
  } else {
    denominator = 1n << -exponent;
  }

  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) {
    quotient += 1n;
  }

  const digits = quotient.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** `format!("{:>width$.decimals$}", value)` — right-aligned, space padded. */
export function formatFixedRightAligned(value: number, width: number, decimals: number): string {
  return formatFixed(value, decimals).padStart(width, " ");
}
