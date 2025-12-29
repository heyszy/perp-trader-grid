import type { Decimal } from "../../shared/number";
import type { OrderSide } from "../exchange/models";

/**
 * 最大仓位风控输入，用于评估下一笔订单是否会超限。
 */
export interface MaxPositionCheckInput {
  side: OrderSide;
  netPosition: Decimal;
  pendingBuy: Decimal;
  pendingSell: Decimal;
  orderQuantity: Decimal;
  maxPosition: Decimal;
}

/**
 * 判断在最坏情况下是否会突破最大仓位限制。
 * 规则：同向挂单 + 当前净仓位 + 新订单数量 不得超过 maxPosition。
 */
export function canPlaceByMaxPosition(input: MaxPositionCheckInput): boolean {
  if (input.side === "BUY") {
    return input.netPosition
      .plus(input.pendingBuy)
      .plus(input.orderQuantity)
      .lte(input.maxPosition);
  }
  return input.netPosition
    .minus(input.pendingSell)
    .minus(input.orderQuantity)
    .gte(input.maxPosition.negated());
}
