import { readFileSync } from "node:fs";

import { render, type Value } from "./deps/askama.ts";
import { type InitHook, type InitShell } from "./cmd/cmd.ts";

export interface Opts {
  readonly cmd: string | null;
  readonly hook: InitHook;
  readonly echo: boolean;
  readonly resolveSymlinks: boolean;
}

/**
 * The templates ship beside the source, exactly as the original's
 * `#[template(path = "…")]` reads them from `templates/`.
 */
const TEMPLATE_DIR = new URL("../templates/", import.meta.url);

const HOOK_VARIANT: Readonly<Record<InitHook, string>> = {
  none: "None",
  prompt: "Prompt",
  pwd: "Pwd",
};

function variables(opts: Opts): Map<string, Value> {
  return new Map<string, Value>([
    ["cmd", opts.cmd],
    ["hook", { enum: "InitHook", variant: HOOK_VARIANT[opts.hook] }],
    ["echo", opts.echo],
    ["resolve_symlinks", opts.resolveSymlinks],
  ]);
}

function template(name: string): string {
  return readFileSync(new URL(`${name}.txt`, TEMPLATE_DIR), "utf8");
}

function renderShell(name: InitShell, opts: Opts): string {
  return render(template(name), variables(opts));
}

export const bash = (opts: Opts): string => renderShell("bash", opts);
export const elvish = (opts: Opts): string => renderShell("elvish", opts);
export const fish = (opts: Opts): string => renderShell("fish", opts);
export const nushell = (opts: Opts): string => renderShell("nushell", opts);
export const posix = (opts: Opts): string => renderShell("posix", opts);
export const powershell = (opts: Opts): string => renderShell("powershell", opts);
export const tcsh = (opts: Opts): string => renderShell("tcsh", opts);
export const xonsh = (opts: Opts): string => renderShell("xonsh", opts);
export const zsh = (opts: Opts): string => renderShell("zsh", opts);

/** Every shell's renderer, keyed by the value `zoxide init` accepts. */
export const SHELL_TEMPLATES: Readonly<Record<InitShell, (opts: Opts) => string>> = {
  bash,
  elvish,
  fish,
  nushell,
  posix,
  powershell,
  tcsh,
  xonsh,
  zsh,
};
