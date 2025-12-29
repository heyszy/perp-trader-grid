import type { Decimal } from "../../shared/number";
import type { OrderSide, OrderStatus } from "../../core/exchange/models";
import type { OrderRepository } from "../../infra/db/order-repo";

/**
 * 订单记录输入，统一为网格系统内的抽象格式。
 */
export interface OrderRecordInput {
  strategyId: string;
  exchange: string;
  accountId?: string;
  symbol: string;
  exchangeSymbol: string;
  clientOrderId: string;
  exchangeOrderId?: string;
  side: OrderSide;
  orderType: "LIMIT" | "MARKET";
  timeInForce?: "GTT" | "IOC" | "FOK" | "GTC";
  postOnly?: boolean;
  reduceOnly?: boolean;
  price: Decimal;
  quantity: Decimal;
  filledQuantity?: Decimal;
  avgFillPrice?: Decimal;
  status: OrderStatus;
  exchangeStatus?: string;
  statusReason?: string;
  gridLevelIndex?: number;
  placedAt: number;
  exchangeUpdatedAt: number;
}

/**
 * 订单记录器接口。
 */
export interface OrderRecorder {
  recordOrder(input: OrderRecordInput): Promise<void>;
}

/**
 * 基于 SQLite 的订单记录实现。
 */
export class DbOrderRecorder implements OrderRecorder {
  private readonly repo: OrderRepository;

  constructor(repo: OrderRepository) {
    this.repo = repo;
  }

  /**
   * 订单写入入口，按唯一键进行 upsert。
   */
  public async recordOrder(input: OrderRecordInput): Promise<void> {
    const now = Date.now();
    await this.repo.upsertOrder({
      strategyId: input.strategyId,
      exchange: input.exchange,
      accountId: input.accountId,
      symbol: input.symbol,
      exchangeSymbol: input.exchangeSymbol,
      clientOrderId: input.clientOrderId,
      exchangeOrderId: input.exchangeOrderId,
      side: input.side,
      orderType: input.orderType,
      timeInForce: input.timeInForce,
      postOnly: input.postOnly ?? false,
      reduceOnly: input.reduceOnly ?? false,
      price: input.price.toString(),
      quantity: input.quantity.toString(),
      filledQuantity: input.filledQuantity?.toString(),
      avgFillPrice: input.avgFillPrice?.toString(),
      status: input.status,
      exchangeStatus: input.exchangeStatus,
      statusReason: input.statusReason,
      gridLevelIndex: input.gridLevelIndex,
      placedAt: input.placedAt,
      exchangeUpdatedAt: input.exchangeUpdatedAt,
      recordCreatedAt: now,
      recordUpdatedAt: now,
    });
  }
}
