import type { Decimal } from "../../shared/number";

/**
 * 订单方向。
 */
export type OrderSide = "BUY" | "SELL";

/**
 * 订单状态枚举，覆盖网格所需的全流程状态。
 */
export type OrderStatus =
  | "PENDING_SEND"
  | "SENT"
  | "ACKED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED"
  | "UNKNOWN";

/**
 * 仓位方向。
 */
export type PositionSide = "LONG" | "SHORT";

/**
 * 统一输出的行情快照，mark 价格用于网格中心价。
 */
export interface ExchangeQuote {
  exchange: string;
  bid: Decimal;
  ask: Decimal;
  mark: Decimal;
  ts: number;
}

/**
 * 交易市场的最小步长与费率配置。
 */
export interface MarketTradingConfig {
  minPriceChange: Decimal;
  minOrderSizeChange: Decimal;
  makerFee: Decimal;
  takerFee: Decimal;
}

/**
 * 交易所仓位快照。
 */
export interface ExchangePosition {
  symbol: string;
  side: PositionSide;
  size: Decimal;
  updatedAt: number;
}

/**
 * 交易所订单快照，供对账与状态同步使用。
 */
export interface ExchangeOrder {
  /** 交易所账户标识，便于多账户对账 */
  accountId?: string;
  clientOrderId: string;
  exchangeOrderId?: string;
  status: OrderStatus;
  statusReason?: string;
  /** 交易所原始状态，保留用于排查 */
  exchangeStatus?: string;
  side: OrderSide;
  price: Decimal;
  quantity: Decimal;
  filledQuantity?: Decimal;
  /** 平均成交价，部分成交或成交完成后可用 */
  avgFillPrice?: Decimal;
  updatedAt: number;
}

/**
 * 订单状态更新事件，字段尽量保持精简。
 */
export interface OrderUpdate {
  /** 交易所账户标识，便于多账户对账 */
  accountId?: string;
  clientOrderId: string;
  exchangeOrderId?: string;
  status: OrderStatus;
  statusReason?: string;
  /** 交易所原始状态，保留用于排查 */
  exchangeStatus?: string;
  filledQuantity?: Decimal;
  /** 平均成交价，部分成交或成交完成后可用 */
  avgFillPrice?: Decimal;
  updatedAt: number;
}
