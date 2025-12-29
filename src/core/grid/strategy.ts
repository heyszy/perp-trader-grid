import type { Decimal } from "../../shared/number";
import type { GridStrategyConfig } from "./types";
import { buildLevelPrice, calculateShiftSteps, shiftCenterPrice } from "./spacing";

/**
 * 网格策略仅负责价格计算与跨档判断。
 */
export class GridStrategy {
  private readonly config: GridStrategyConfig;

  constructor(config: GridStrategyConfig) {
    this.config = config;
  }

  /**
   * 计算指定档位价格。
   */
  public getLevelPrice(center: Decimal, index: number): Decimal {
    return buildLevelPrice(center, index, this.config);
  }

  /**
   * 计算跨档步数，steps 为 0 表示无需平移。
   */
  public calculateShiftSteps(center: Decimal, mark: Decimal): number {
    return calculateShiftSteps(center, mark, this.config);
  }

  /**
   * 根据步数计算平移后的中心价。
   */
  public shiftCenterPrice(center: Decimal, steps: number): Decimal {
    return shiftCenterPrice(center, steps, this.config);
  }
}
