import { Decimal } from "../../shared/number";
import type { GridSpacingConfig } from "./types";

/**
 * 校验并获取绝对价差配置。
 */
function requireAbsSpacing(config: GridSpacingConfig): Decimal {
  if (!config.spacing) {
    throw new Error("缺少绝对价差配置 spacing");
  }
  if (config.spacing.lte(0)) {
    throw new Error("绝对价差必须大于 0");
  }
  return config.spacing;
}

/**
 * 校验并获取百分比间距配置。
 */
function requirePercentSpacing(config: GridSpacingConfig): Decimal {
  if (!config.spacingPercent) {
    throw new Error("缺少百分比间距配置 spacingPercent");
  }
  if (config.spacingPercent.lte(0)) {
    throw new Error("百分比间距必须大于 0");
  }
  return config.spacingPercent;
}

/**
 * 计算百分比网格的倍率基数。
 */
function getPercentBase(config: GridSpacingConfig): Decimal {
  const spacingPercent = requirePercentSpacing(config);
  const base = Decimal(1).plus(spacingPercent);
  if (base.lte(1)) {
    throw new Error("百分比间距需保证倍率基数大于 1");
  }
  return base;
}

/**
 * 计算指定档位价格。
 */
export function buildLevelPrice(
  center: Decimal,
  index: number,
  config: GridSpacingConfig
): Decimal {
  if (index === 0) {
    return center;
  }
  if (config.mode === "ABS") {
    const spacing = requireAbsSpacing(config);
    return center.plus(spacing.multipliedBy(index));
  }
  const base = getPercentBase(config);
  const exponent = Math.abs(index);
  const factor = base.pow(exponent);
  return index > 0 ? center.multipliedBy(factor) : center.dividedBy(factor);
}

/**
 * 根据平移步数计算新的中心价。
 */
export function shiftCenterPrice(
  center: Decimal,
  steps: number,
  config: GridSpacingConfig
): Decimal {
  if (steps === 0) {
    return center;
  }
  if (config.mode === "ABS") {
    const spacing = requireAbsSpacing(config);
    return center.plus(spacing.multipliedBy(steps));
  }
  const base = getPercentBase(config);
  const exponent = Math.abs(steps);
  const factor = base.pow(exponent);
  return steps > 0 ? center.multipliedBy(factor) : center.dividedBy(factor);
}

/**
 * 计算跨档步数，使用 mark 相对中心价的距离判断。
 */
export function calculateShiftSteps(
  center: Decimal,
  mark: Decimal,
  config: GridSpacingConfig
): number {
  if (center.lte(0) || mark.lte(0)) {
    throw new Error("中心价与 mark 价格必须大于 0");
  }
  if (config.mode === "ABS") {
    const spacing = requireAbsSpacing(config);
    const diff = mark.minus(center);
    if (diff.isZero()) {
      return 0;
    }
    const distance = diff.isNegative() ? diff.negated() : diff;
    const steps = distance.dividedBy(spacing).integerValue(Decimal.ROUND_FLOOR).toNumber();
    return diff.isNegative() ? -steps : steps;
  }

  const base = getPercentBase(config).toNumber();
  const ratio = mark.dividedBy(center).toNumber();
  if (ratio === 1) {
    return 0;
  }
  // 使用浮点 log 计算步数，仅用于整数档位判定
  if (ratio > 1) {
    return Math.floor(Math.log(ratio) / Math.log(base));
  }
  return -Math.floor(Math.log(1 / ratio) / Math.log(base));
}
