import type { Cmd } from "./cmd.ts";
import * as add from "./add.ts";
import * as edit from "./edit.ts";
import * as importCmd from "./import.ts";
import * as init from "./init.ts";
import * as query from "./query.ts";
import * as remove from "./remove.ts";

export * from "./cmd.ts";

/** The `Run` trait: dispatch a parsed command to its implementation. */
export async function run(cmd: Cmd): Promise<void> {
  switch (cmd.kind) {
    case "add":
      return add.run(cmd);
    case "edit":
      return edit.run(cmd);
    case "import":
      return importCmd.run(cmd);
    case "init":
      return init.run(cmd);
    case "query":
      return query.run(cmd);
    case "remove":
      return remove.run(cmd);
  }
}
