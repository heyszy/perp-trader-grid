import BigNumber from "bignumber.js";

/**
 * 统一使用 BigNumber 表示高精度数值，避免浮点误差。
 */
export const Decimal = BigNumber;

export type Decimal = BigNumber;
export type RoundingMode = BigNumber.RoundingMode;
