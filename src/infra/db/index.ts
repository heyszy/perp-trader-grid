import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { DbConfig } from "../config/schema";
import { ensureDbSchema } from "./init";
import * as schema from "./schema";

/**
 * 数据库客户端封装，便于统一管理连接与类型。
 */
export interface DbClient {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
}

/**
 * 创建 SQLite 数据库连接，并启用基础运行参数。
 */
export function createDbClient(config: DbConfig): DbClient {
  const dbPath = path.resolve(process.cwd(), config.path);
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  ensureDbSchema(sqlite);

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
