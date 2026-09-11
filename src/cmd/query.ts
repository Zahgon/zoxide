import * as config from "../config.ts";
import { Database, display, type Epoch, Stream, StreamOptions } from "../db/index.ts";
import { pipeExit } from "../error.ts";
import * as util from "../util.ts";
import { Fzf, type FzfChild } from "../util.ts";
import type { Query } from "./cmd.ts";
import { writeStdout } from "./io.ts";

export async function run(cmd: Query): Promise<void> {
  const db = Database.open();
  // `self.query(&mut db).and(db.save())`: the database is saved either way, but
  // a query failure is what the caller sees.
  let failure: unknown = null;
  try {
    await query(cmd, db);
  } catch (error) {
    failure = error;
  }
  try {
    db.save();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== null) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw failure;
  }
}

async function query(cmd: Query, db: Database): Promise<void> {
  const now = util.currentTime();
  const stream = getStream(cmd, db, now);

  if (cmd.interactive) {
    await queryInteractive(cmd, stream, now);
  } else if (cmd.list) {
    queryList(cmd, stream, now);
  } else {
    queryFirst(cmd, stream, now);
  }
}

async function queryInteractive(cmd: Query, stream: Stream, now: Epoch): Promise<void> {
  const fzf = getFzf();
  let selection: string | null = null;

  for (;;) {
    const dir = stream.next();
    if (dir === null) {
      selection = await fzf.wait();
      break;
    }
    if (dir.path === cmd.exclude) {
      continue;
    }
    const chosen = await fzf.write(dir, now);
    if (chosen !== null) {
      selection = chosen;
      break;
    }
  }

  if (cmd.score) {
    writeStdout(selection);
  } else {
    if (selection.length < 7) {
      throw new Error("could not read selection from fzf");
    }
    writeStdout(selection.slice(7));
  }
}

function queryList(cmd: Query, stream: Stream, now: Epoch): void {
  for (;;) {
    const dir = stream.next();
    if (dir === null) {
      return;
    }
    if (dir.path === cmd.exclude) {
      continue;
    }
    const rendered = cmd.score ? display(dir).withScore(now) : display(dir);
    try {
      writeStdout(`${rendered.toString()}\n`);
    } catch (error) {
      pipeExit(error, "stdout");
    }
  }
}

function queryFirst(cmd: Query, stream: Stream, now: Epoch): void {
  let dir = stream.next();
  if (dir === null) {
    throw new Error("no match found");
  }
  while (dir.path === cmd.exclude) {
    dir = stream.next();
    if (dir === null) {
      throw new Error("you are already in the only match");
    }
  }

  const rendered = cmd.score ? display(dir).withScore(now) : display(dir);
  try {
    writeStdout(`${rendered.toString()}\n`);
  } catch (error) {
    pipeExit(error, "stdout");
  }
}

function getStream(cmd: Query, db: Database, now: Epoch): Stream {
  let options = new StreamOptions(now)
    .withKeywords(cmd.keywords)
    .withExclude(config.excludeDirs())
    .withBaseDir(cmd.baseDir);
  if (!cmd.all) {
    options = options.withExists(true).withResolveSymlinks(config.resolveSymlinks());
  }
  return new Stream(db, options);
}

function getFzf(): FzfChild {
  const fzf = Fzf.new();
  const fzfOpts = config.fzfOpts();
  if (fzfOpts !== undefined) {
    return fzf.env("FZF_DEFAULT_OPTS", fzfOpts).spawn();
  }
  return fzf
    .args([
      // Search mode
      "--exact",
      // Search result
      "--no-sort",
      // Interface
      "--bind=ctrl-z:ignore,btab:up,tab:down",
      "--cycle",
      "--keep-right",
      // Layout
      "--border=sharp", // rounded edges don't display correctly on some terminals
      "--height=45%",
      "--info=inline",
      "--layout=reverse",
      // Display
      "--tabstop=1",
      // Scripting
      "--exit-0",
    ])
    .enablePreview()
    .spawn();
}
