import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 订单状态枚举，与统一订单状态保持一致。
 */
export const orderStatusEnum = [
  "PENDING_SEND",
  "SENT",
  "ACKED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "UNKNOWN",
] as const;

/**
 * 订单方向枚举。
 */
export const orderSideEnum = ["BUY", "SELL"] as const;

/**
 * 下单类型枚举。
 */
export const orderTypeEnum = ["LIMIT", "MARKET"] as const;

/**
 * 有效期类型枚举。
 */
export const timeInForceEnum = ["GTT", "IOC", "FOK", "GTC"] as const;

/**
 * 订单记录表，存储网格订单全生命周期状态。
 */
export const orders = sqliteTable(
  "orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    strategyId: text("strategy_id").notNull(),
    exchange: text("exchange").notNull(),
    accountId: text("account_id"),
    symbol: text("symbol").notNull(),
    exchangeSymbol: text("exchange_symbol").notNull(),
    clientOrderId: text("client_order_id").notNull(),
    // 客户端自定义的数值订单号，用于事件回传关联
    clientOrderNum: integer("client_order_num"),
    exchangeOrderId: text("exchange_order_id"),
    side: text("side", { enum: orderSideEnum }).notNull(),
    orderType: text("order_type", { enum: orderTypeEnum }).notNull(),
    timeInForce: text("time_in_force", { enum: timeInForceEnum }),
    postOnly: integer("post_only", { mode: "boolean" }).notNull().default(false),
    reduceOnly: integer("reduce_only", { mode: "boolean" }).notNull().default(false),
    price: text("price").notNull(),
    quantity: text("quantity").notNull(),
    filledQuantity: text("filled_quantity"),
    avgFillPrice: text("avg_fill_price"),
    status: text("status", { enum: orderStatusEnum }).notNull(),
    exchangeStatus: text("exchange_status"),
    statusReason: text("status_reason"),
    gridLevelIndex: integer("grid_level_index"),
    placedAt: integer("placed_at").notNull(),
    exchangeUpdatedAt: integer("exchange_updated_at").notNull(),
    recordCreatedAt: integer("record_created_at").notNull(),
    recordUpdatedAt: integer("record_updated_at").notNull(),
  },
  (table) => ({
    exchangeClientOrderId: uniqueIndex("orders_exchange_client_order_id").on(
      table.exchange,
      table.clientOrderId
    ),
    exchangeExchangeOrderId: index("orders_exchange_exchange_order_id").on(
      table.exchange,
      table.exchangeOrderId
    ),
    strategyStatus: index("orders_strategy_status").on(table.strategyId, table.status),
    exchangeSymbolStatus: index("orders_exchange_symbol_status").on(
      table.exchange,
      table.symbol,
      table.status
    ),
  })
);
