import { createHash } from "node:crypto";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { Decimal } from "../../../shared/number";
import type { OrderSide, OrderStatus } from "../../../core/exchange/models";

/**
 * Hyperliquid 订单状态映射到统一枚举。
 */
const CANCELLED_STATUSES = new Set([
  "canceled",
  "marginCanceled",
  "vaultWithdrawalCanceled",
  "openInterestCapCanceled",
  "selfTradeCanceled",
  "reduceOnlyCanceled",
  "siblingFilledCanceled",
  "delistedCanceled",
  "liquidatedCanceled",
  "scheduledCancel",
]);

const REJECTED_STATUSES = new Set([
  "rejected",
  "tickRejected",
  "minTradeNtlRejected",
  "perpMarginRejected",
  "reduceOnlyRejected",
  "badAloPxRejected",
  "iocCancelRejected",
  "badTriggerPxRejected",
  "marketOrderNoLiquidityRejected",
  "positionIncreaseAtOpenInterestCapRejected",
  "positionFlipAtOpenInterestCapRejected",
  "tooAggressiveAtOpenInterestCapRejected",
  "openInterestIncreaseRejected",
  "insufficientSpotBalanceRejected",
  "oracleRejected",
  "perpMaxPositionRejected",
]);

/**
 * 生成 Hyperliquid 所需的 cloid（0x + 32 hex）。
 * 使用稳定哈希，确保同一 clientOrderId 可复现。
 */
export function buildCloid(clientOrderId: string): `0x${string}` {
  const digest = createHash("sha256").update(clientOrderId).digest("hex");
  return `0x${digest.slice(0, 32)}` as `0x${string}`;
}

/**
 * 将 Hyperliquid 原始状态映射为内部订单状态。
 */
export function normalizeHyperliquidOrderStatus(status: string): OrderStatus {
  if (status === "open" || status === "triggered") {
    return "ACKED";
  }
  if (status === "filled") {
    return "FILLED";
  }
  if (CANCELLED_STATUSES.has(status)) {
    return "CANCELLED";
  }
  if (REJECTED_STATUSES.has(status)) {
    return "REJECTED";
  }
  return "UNKNOWN";
}

/**
 * 统一订单方向映射（B=买，A=卖）。
 */
export function normalizeHyperliquidSide(side: "B" | "A"): OrderSide {
  return side === "B" ? "BUY" : "SELL";
}

/**
 * 按 Hyperliquid tick/lot 规则格式化价格。
 */
export function formatHyperliquidPrice(price: Decimal, szDecimals: number): string {
  return formatPrice(price.toString(), szDecimals, "perp");
}

/**
 * 按 Hyperliquid lot 规则格式化数量。
 */
export function formatHyperliquidSize(size: Decimal, szDecimals: number): string {
  return formatSize(size.toString(), szDecimals);
}

/**
 * 判断是否为最小下单金额不足的错误。
 */
export function isHyperliquidMinNotionalError(message: string): boolean {
  return (
    message.toLowerCase().includes("mintradentlrejected") || /minimum value of \$\d+/i.test(message)
  );
}

/**
 * 从错误信息中提取最小下单金额（USD）。
 */
export function parseHyperliquidMinNotional(message: string): Decimal | null {
  const match = message.match(/minimum value of \$(\d+(?:\.\d+)?)/i);
  if (!match) {
    return null;
  }
  const parsed = Decimal(match[1]);
  if (parsed.isNaN()) {
    return null;
  }
  return parsed;
}
