import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { orders } from "./schema";
import type * as schema from "./schema";

/**
 * 订单表写入结构。
 */
export type OrderInsert = typeof orders.$inferInsert;

/**
 * 订单仓储，封装 upsert 逻辑。
 */
export class OrderRepository {
  private readonly db: BetterSQLite3Database<typeof schema>;

  constructor(db: BetterSQLite3Database<typeof schema>) {
    this.db = db;
  }

  /**
   * 以 exchange + clientOrderId 为唯一键更新订单记录。
   */
  public async upsertOrder(values: OrderInsert): Promise<void> {
    const updateSet = this.buildUpdateSet(values);
    this.db
      .insert(orders)
      .values(values)
      .onConflictDoUpdate({
        target: [orders.exchange, orders.clientOrderId],
        set: updateSet,
      })
      .run();
  }

  /**
   * 构建更新字段，避免覆盖 recordCreatedAt 等不可变字段。
   */
  private buildUpdateSet(values: OrderInsert): SQLiteUpdateSetSource<typeof orders> {
    const updateSet: Record<string, unknown> = {};
    const entries = Object.entries(values) as Array<[string, unknown]>;
    for (const [key, value] of entries) {
      if (value === undefined) {
        continue;
      }
      if (key === "recordCreatedAt") {
        continue;
      }
      updateSet[key] = value;
    }
    return updateSet as SQLiteUpdateSetSource<typeof orders>;
  }
}
