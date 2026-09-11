import { Database } from "../db/index.ts";
import * as importer from "../import.ts";
import { ImportFrom, type Import } from "./cmd.ts";

const IMPORTERS: Readonly<Record<ImportFrom, () => importer.Importer>> = {
  [ImportFrom.Atuin]: () => new importer.Atuin(),
  [ImportFrom.Autojump]: () => new importer.Autojump(),
  [ImportFrom.Fasd]: () => new importer.Fasd(),
  [ImportFrom.Z]: () => new importer.Z(),
  [ImportFrom.ZLua]: () => new importer.ZLua(),
  [ImportFrom.ZshZ]: () => new importer.ZshZ(),
};

export function run(cmd: Import): void {
  const db = Database.open();
  if (!cmd.merge && db.dirs.length > 0) {
    throw new Error("current database is not empty, specify --merge to continue anyway");
  }

  importer.run(IMPORTERS[cmd.from](), db);
  db.save();
}
