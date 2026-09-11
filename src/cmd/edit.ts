import { Database, display } from "../db/index.ts";
import { pipeExit } from "../error.ts";
import * as util from "../util.ts";
import { Fzf, type FzfChild } from "../util.ts";
import type { Edit } from "./cmd.ts";
import { writeStdout } from "./io.ts";

export async function run(cmd: Edit): Promise<void> {
  const now = util.currentTime();
  const db = Database.open();

  if (cmd.cmd === null) {
    db.sortByScore(now);
    db.save();
    await getFzf().wait();
    return;
  }

  switch (cmd.cmd.kind) {
    case "decrement":
      db.add(cmd.cmd.path, -1.0, now);
      break;
    case "delete":
      db.remove(cmd.cmd.path);
      break;
    case "increment":
      db.add(cmd.cmd.path, 1.0, now);
      break;
    case "reload":
      break;
  }
  db.save();

  for (let index = db.dirs.length - 1; index >= 0; index -= 1) {
    const rendered = display(db.dirs[index]!).withScore(now).withSeparator("\t");
    try {
      writeStdout(`${rendered.toString()}\0`);
    } catch (error) {
      pipeExit(error, "fzf");
    }
  }
}

function getFzf(): FzfChild {
  return Fzf.new()
    .args([
      // Search mode
      "--exact",
      // Search result
      "--no-sort",
      // Interface
      "--bind=" +
        "btab:up," +
        "ctrl-r:reload(zoxide edit reload)," +
        "ctrl-d:reload(zoxide edit delete {2..})," +
        "ctrl-w:reload(zoxide edit increment {2..})," +
        "ctrl-s:reload(zoxide edit decrement {2..})," +
        "ctrl-z:ignore," +
        "double-click:ignore," +
        "enter:abort," +
        "start:reload(zoxide edit reload)," +
        "tab:down",
      "--cycle",
      "--keep-right",
      // Layout
      "--border=sharp",
      "--border-label=  zoxide-edit  ",
      "--header=" +
        "ctrl-r:reload   \tctrl-d:delete\n" +
        "ctrl-w:increment\tctrl-s:decrement\n" +
        "\n" +
        " SCORE\tPATH",
      "--info=inline",
      "--layout=reverse",
      "--padding=1,0,0,0",
      // Display
      "--color=label:bold",
      "--tabstop=1",
    ])
    .enablePreview()
    .spawn();
}
