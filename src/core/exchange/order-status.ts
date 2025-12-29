import type { OrderStatus } from "./models";

/**
 * 判断订单是否已进入终态。
 * 终态订单不再占用网格档位，可被新订单替换。
 */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return (
    status === "FILLED" || status === "CANCELLED" || status === "REJECTED" || status === "EXPIRED"
  );
}
