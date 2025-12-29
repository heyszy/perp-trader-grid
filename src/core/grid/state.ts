import type { Decimal } from "../../shared/number";
import { isTerminalOrderStatus } from "../exchange/order-status";
import { buildLevelPrice, shiftCenterPrice } from "./spacing";
import type { GridLevel, GridOrderState, GridShiftResult, GridStateConfig } from "./types";

/**
 * GridState 负责维护网格档位与订单的内存状态。
 */
export class GridState {
  public readonly strategyId: string;
  public readonly symbol: string;
  public readonly levels: number;
  public readonly spacingMode: GridStateConfig["mode"];
  public readonly spacing: GridStateConfig["spacing"];
  public readonly spacingPercent: GridStateConfig["spacingPercent"];
  public readonly quantity: Decimal;
  public centerPrice: Decimal | null = null;
  public lastMark: Decimal | null = null;
  public lastQuoteAt: number | null = null;
  public lastRebuildAt: number | null = null;
  private levelMap: Map<number, GridLevel> = new Map();
  private orderMap: Map<string, GridOrderState> = new Map();

  constructor(config: GridStateConfig) {
    this.strategyId = config.strategyId;
    this.symbol = config.symbol;
    this.levels = config.levels;
    this.spacingMode = config.mode;
    this.spacing = config.spacing;
    this.spacingPercent = config.spacingPercent;
    this.quantity = config.quantity;
  }

  /**
   * 重建网格档位并清空订单状态。
   */
  public reset(centerPrice: Decimal): void {
    this.centerPrice = centerPrice;
    this.levelMap = this.buildLevels(centerPrice);
    this.orderMap.clear();
    this.lastRebuildAt = Date.now();
  }

  /**
   * 更新 mark 与行情时间戳。
   */
  public updateMark(mark: Decimal, quoteTs: number): void {
    this.lastMark = mark;
    this.lastQuoteAt = quoteTs;
  }

  /**
   * 获取档位列表（按索引排序）。
   */
  public getLevels(): GridLevel[] {
    return Array.from(this.levelMap.values()).sort((a, b) => a.index - b.index);
  }

  /**
   * 获取指定档位。
   */
  public getLevel(index: number): GridLevel | null {
    return this.levelMap.get(index) ?? null;
  }

  /**
   * 获取指定订单。
   */
  public getOrder(clientOrderId: string): GridOrderState | null {
    return this.orderMap.get(clientOrderId) ?? null;
  }

  /**
   * 获取全部订单。
   */
  public getOrders(): GridOrderState[] {
    return Array.from(this.orderMap.values());
  }

  /**
   * 保存或更新订单状态，并尝试绑定到对应档位。
   */
  public upsertOrder(order: GridOrderState): void {
    if (isTerminalOrderStatus(order.status)) {
      this.removeOrder(order.clientOrderId, order.levelIndex);
      return;
    }
    this.orderMap.set(order.clientOrderId, order);
    const level = this.levelMap.get(order.levelIndex);
    if (!level) {
      return;
    }
    if (level.targetSide && level.targetSide === order.side) {
      level.order = order;
      return;
    }
    if (level.order?.clientOrderId === order.clientOrderId) {
      level.order = undefined;
    }
  }

  /**
   * 移除订单状态，并清理档位引用。
   */
  public removeOrder(clientOrderId: string, levelIndex?: number): void {
    const existing = this.orderMap.get(clientOrderId);
    const resolvedLevelIndex = existing?.levelIndex ?? levelIndex;
    if (resolvedLevelIndex !== undefined) {
      const level = this.levelMap.get(resolvedLevelIndex);
      if (level?.order?.clientOrderId === clientOrderId) {
        level.order = undefined;
      }
    }
    this.orderMap.delete(clientOrderId);
  }

  /**
   * 网格中心价平移，返回需要撤单的订单列表。
   */
  public shiftCenter(steps: number): GridShiftResult {
    if (!this.centerPrice) {
      throw new Error("中心价为空，无法平移网格");
    }
    if (steps === 0) {
      return {
        centerPrice: this.centerPrice,
        steps,
        outOfRangeOrders: [],
      };
    }
    const newCenter = shiftCenterPrice(this.centerPrice, steps, {
      mode: this.spacingMode,
      spacing: this.spacing,
      spacingPercent: this.spacingPercent,
    });
    const newLevelMap = this.buildLevels(newCenter);
    const outOfRangeOrders: GridOrderState[] = [];
    const nextOrderMap = new Map<string, GridOrderState>();

    this.orderMap.forEach((order) => {
      const newIndex = order.levelIndex - steps;
      const updatedOrder: GridOrderState = {
        ...order,
        levelIndex: newIndex,
      };
      nextOrderMap.set(order.clientOrderId, updatedOrder);
      const level = newLevelMap.get(newIndex);
      if (!level || !level.targetSide || level.targetSide !== updatedOrder.side) {
        outOfRangeOrders.push(updatedOrder);
        return;
      }
      level.order = updatedOrder;
    });

    this.centerPrice = newCenter;
    this.levelMap = newLevelMap;
    this.orderMap = nextOrderMap;
    this.lastRebuildAt = Date.now();

    return {
      centerPrice: newCenter,
      steps,
      outOfRangeOrders,
    };
  }

  /**
   * 构建对称网格档位（中心上下各 levels 档）。
   */
  private buildLevels(centerPrice: Decimal): Map<number, GridLevel> {
    const map = new Map<number, GridLevel>();
    // 0 档位仅作为参考，不挂单
    map.set(0, {
      index: 0,
      targetSide: null,
      price: centerPrice,
    });
    for (let i = 1; i <= this.levels; i += 1) {
      map.set(-i, {
        index: -i,
        targetSide: "BUY",
        price: buildLevelPrice(centerPrice, -i, {
          mode: this.spacingMode,
          spacing: this.spacing,
          spacingPercent: this.spacingPercent,
        }),
      });
      map.set(i, {
        index: i,
        targetSide: "SELL",
        price: buildLevelPrice(centerPrice, i, {
          mode: this.spacingMode,
          spacing: this.spacing,
          spacingPercent: this.spacingPercent,
        }),
      });
    }
    return map;
  }
}
