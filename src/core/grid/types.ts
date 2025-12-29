import type { Decimal } from "../../shared/number";
import type { OrderSide, OrderStatus } from "../exchange/models";

/**
 * 网格间距模式：绝对价差或几何百分比。
 */
export type GridSpacingMode = "ABS" | "PERCENT";

/**
 * 网格间距配置。
 */
export interface GridSpacingConfig {
  mode: GridSpacingMode;
  spacing?: Decimal;
  spacingPercent?: Decimal;
}

/**
 * 网格策略配置。
 */
export interface GridStrategyConfig extends GridSpacingConfig {
  levels: number;
}

/**
 * 网格状态初始化配置。
 */
export interface GridStateConfig extends GridSpacingConfig {
  strategyId: string;
  symbol: string;
  levels: number;
  quantity: Decimal;
}

/**
 * 网格档位信息。
 */
export interface GridLevel {
  index: number;
  targetSide: OrderSide | null;
  price: Decimal;
  order?: GridOrderState;
}

/**
 * 网格订单状态。
 */
export interface GridOrderState {
  clientOrderId: string;
  exchangeOrderId?: string;
  status: OrderStatus;
  side: OrderSide;
  price: Decimal;
  quantity: Decimal;
  levelIndex: number;
  placedAt: number;
  updatedAt: number;
}

/**
 * 网格平移结果，包含需要撤单的订单。
 */
export interface GridShiftResult {
  centerPrice: Decimal;
  steps: number;
  outOfRangeOrders: GridOrderState[];
}
