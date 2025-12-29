import type { schemas } from "@shenzheyu/extended";
import { Decimal } from "../../../shared/number";
import type { OrderStatus } from "../../../core/exchange/models";

/**
 * Extended builder 配置，按需求固定。
 */
export const BUILDER_ID = 153539;
export const BUILDER_FEE_CAP = Decimal("0.0001");

/**
 * 将交易所订单状态映射为内部统一状态。
 */
export function normalizeOrderStatus(status: schemas.OrderStatus): OrderStatus {
  if (status === "NEW" || status === "UNTRIGGERED" || status === "TRIGGERED") {
    return "ACKED";
  }
  if (status === "PARTIALLY_FILLED") {
    return "PARTIALLY_FILLED";
  }
  if (status === "FILLED") {
    return "FILLED";
  }
  if (status === "CANCELLED") {
    return "CANCELLED";
  }
  if (status === "REJECTED") {
    return "REJECTED";
  }
  if (status === "EXPIRED") {
    return "EXPIRED";
  }
  return "UNKNOWN";
}

/**
 * 按最小步长向下取整，避免下单被拒。
 */
export function roundToStep(value: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) {
    throw new Error("步长必须大于 0");
  }
  return value.dividedBy(step).integerValue(Decimal.ROUND_DOWN).multipliedBy(step);
}
