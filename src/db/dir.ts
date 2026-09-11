import { formatFixedRightAligned } from "../deps/fmt.ts";
import { DAY, HOUR, WEEK } from "../util.ts";

/** `Rank` is `f64` in the original. */
export type Rank = number;

/** `Epoch` is `u64` seconds since the Unix epoch. */
export type Epoch = number;

export interface Dir {
  path: string;
  rank: Rank;
  lastAccessed: Epoch;
}

/** `Dir::score` — the older the entry, the less it counts. */
export function score(dir: Dir, now: Epoch): Rank {
  const duration = Math.max(0, now - dir.lastAccessed);
  if (duration < HOUR) {
    return dir.rank * 4.0;
  }
  if (duration < DAY) {
    return dir.rank * 2.0;
  }
  if (duration < WEEK) {
    return dir.rank * 0.5;
  }
  return dir.rank * 0.25;
}

/**
 * `Dir::display` — a builder, because the same entry is printed three ways:
 * bare for `query`, with a space-separated score for `query --score`, and with
 * a tab-separated score for everything piped into fzf.
 */
export class DirDisplay {
  readonly #dir: Dir;
  #now: Epoch | null = null;
  #separator = " ";

  constructor(dir: Dir) {
    this.#dir = dir;
  }

  withScore(now: Epoch): DirDisplay {
    this.#now = now;
    return this;
  }

  withSeparator(separator: string): DirDisplay {
    this.#separator = separator;
    return this;
  }

  toString(): string {
    if (this.#now === null) {
      return this.#dir.path;
    }
    const clamped = Math.min(Math.max(score(this.#dir, this.#now), 0.0), 9999.0);
    return `${formatFixedRightAligned(clamped, 6, 1)}${this.#separator}${this.#dir.path}`;
  }
}

export function display(dir: Dir): DirDisplay {
  return new DirDisplay(dir);
}

/**
 * `f64::total_cmp` — a total order over every double, including the sign of
 * zero and NaN. `a - b` is not a substitute.
 */
export function totalCmp(left: number, right: number): number {
  const view = new DataView(new ArrayBuffer(16));
  view.setFloat64(0, left);
  view.setFloat64(8, right);
  let a = BigInt.asIntN(64, view.getBigUint64(0));
  let b = BigInt.asIntN(64, view.getBigUint64(8));
  a ^= (a >> 63n) >> 1n;
  b ^= (b >> 63n) >> 1n;
  return a < b ? -1 : a > b ? 1 : 0;
}
