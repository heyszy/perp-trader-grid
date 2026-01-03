import type Database from "better-sqlite3";

/**
 * 初始化数据库表结构，避免首次运行缺表。
 */
export function ensureDbSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id TEXT NOT NULL,
      exchange TEXT NOT NULL,
      account_id TEXT,
      symbol TEXT NOT NULL,
      exchange_symbol TEXT NOT NULL,
      client_order_id TEXT NOT NULL,
      client_order_num INTEGER,
      exchange_order_id TEXT,
      side TEXT NOT NULL,
      order_type TEXT NOT NULL,
      time_in_force TEXT,
      post_only INTEGER NOT NULL DEFAULT 0,
      reduce_only INTEGER NOT NULL DEFAULT 0,
      price TEXT NOT NULL,
      quantity TEXT NOT NULL,
      filled_quantity TEXT,
      avg_fill_price TEXT,
      status TEXT NOT NULL,
      exchange_status TEXT,
      status_reason TEXT,
      grid_level_index INTEGER,
      placed_at INTEGER NOT NULL,
      exchange_updated_at INTEGER NOT NULL,
      record_created_at INTEGER NOT NULL,
      record_updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS orders_exchange_client_order_id
      ON orders (exchange, client_order_id);

    CREATE INDEX IF NOT EXISTS orders_exchange_exchange_order_id
      ON orders (exchange, exchange_order_id);

    CREATE INDEX IF NOT EXISTS orders_strategy_status
      ON orders (strategy_id, status);

    CREATE INDEX IF NOT EXISTS orders_exchange_symbol_status
      ON orders (exchange, symbol, status);
  `);

  // 兼容旧表结构，补齐 client_order_num 字段
  const columns = sqlite.prepare("PRAGMA table_info(orders)").all() as Array<{
    name: string;
  }>;
  const hasClientOrderNum = columns.some((column) => column.name === "client_order_num");
  if (!hasClientOrderNum) {
    sqlite.exec("ALTER TABLE orders ADD COLUMN client_order_num INTEGER");
  }
}
