import { Database } from "bun:sqlite";
import { nativeDatabase } from "../../sqlite";

const decode = (value: unknown) => {
  if (value && typeof value === "object" && "blob" in value) return new Uint8Array((value as { blob: number[] }).blob);
  if (value && typeof value === "object" && "integer" in value) return BigInt((value as { integer: string }).integer);
  return value;
};

export function sqliteDatabase(path: string) {
  const connection = new Database(path, { create: true });
  connection.exec("PRAGMA journal_mode = WAL");
  connection.exec("PRAGMA synchronous = NORMAL");
  connection.exec("PRAGMA busy_timeout = 5000");
  connection.exec("PRAGMA foreign_keys = ON");
  return nativeDatabase(async (op, sql, params) => {
    if (op === "close") {
      try { connection.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
      finally { connection.close(); }
      return null;
    }
    if (op === "exec") { connection.exec(sql); return null; }
    const statement = connection.query(sql);
    const bindings = params.map(decode) as never[];
    if (op === "run") { statement.run(...bindings); return null; }
    return op === "get" ? statement.get(...bindings) ?? null : statement.all(...bindings);
  });
}
