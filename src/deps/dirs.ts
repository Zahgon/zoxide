/**
 * The two lookups zoxide uses from the `dirs` 6 crate.
 *
 * `dirs` follows the XDG base-directory spec on Linux/BSD and Apple's Standard
 * Directories on macOS; the rules below are transcribed from it, including the
 * requirement that an XDG variable be an absolute path to be honoured.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** `dirs::home_dir()`. */
export function homeDir(): string | null {
  const fromEnv = process.env["HOME"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const fromOs = homedir();
  return fromOs === "" ? null : fromOs;
}

/** `dirs::data_local_dir()`. */
export function dataLocalDir(): string | null {
  if (process.platform === "darwin") {
    const home = homeDir();
    return home === null ? null : join(home, "Library", "Application Support");
  }
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"];
    return local !== undefined && local !== "" ? local : null;
  }
  return xdgDir("XDG_DATA_HOME", [".local", "share"]);
}

function xdgDir(variable: string, fallback: readonly string[]): string | null {
  const value = process.env[variable];
  if (value !== undefined && value !== "" && isAbsolute(value)) {
    return value;
  }
  const home = homeDir();
  return home === null ? null : join(home, ...fallback);
}
