import { addDecimals, removeDecimals, type BigDecimalish } from "@nadohq/client";
import { Decimal } from "../../../shared/number";

/**
 * 将 Nado SDK 的数值类型统一转换为内部 Decimal。
 */
export function toDecimal(value: BigDecimalish): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  return Decimal(value.toString());
}

/**
 * 将 x18 精度的数值转换为内部 Decimal。
 */
export function fromX18(value: BigDecimalish): Decimal {
  return toDecimal(removeDecimals(value));
}

/**
 * 将内部 Decimal 转为 x18 精度（订单数量等字段使用）。
 */
export function toX18(value: Decimal): BigDecimalish {
  return addDecimals(value);
}

/**
 * 将毫秒时间戳转换为秒级时间戳。
 */
export function toSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/**
 * 订阅时间戳统一转换为毫秒，兼容秒级/毫秒级返回。
 */
export function normalizeTimestampMs(value: string): number {
  if (/^\d+$/.test(value)) {
    const raw = BigInt(value);
    const digits = value.length;
    // 统一按位数判断时间精度：秒(10) / 毫秒(13) / 微秒(16) / 纳秒(19)。
    if (digits >= 19) {
      return Number(raw / 1_000_000n);
    }
    if (digits >= 16) {
      return Number(raw / 1_000n);
    }
    if (digits >= 13) {
      return Number(raw);
    }
    return Number(raw * 1000n);
  }
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return Date.now();
  }
  // 兜底路径：兼容小数或异常格式的时间戳。
  if (raw > 1_000_000_000_000_000_000) {
    return Math.floor(raw / 1_000_000);
  }
  if (raw > 1_000_000_000_000_000) {
    return Math.floor(raw / 1_000);
  }
  return raw > 1_000_000_000_000 ? Math.floor(raw) : Math.floor(raw * 1000);
}
