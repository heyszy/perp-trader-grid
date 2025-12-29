import type { GridRuntime } from "../grid-runtime";

/**
 * 健康检查阈值配置。
 */
export interface GridHealthThresholds {
  /** 行情过期阈值 */
  marketStaleMs: number;
  /** 仓位更新过期阈值 */
  positionStaleMs: number;
  /** 维护任务过期阈值 */
  maintenanceStaleMs: number;
  /** 对账任务过期阈值 */
  reconcileStaleMs: number;
}

/**
 * 健康检查输出结构。
 */
export interface GridHealthReport {
  ok: boolean;
  now: number;
  warnings: string[];
  market: {
    exchange: string | null;
    lastQuoteAt: number | null;
    quoteAgeMs: number | null;
  };
  order: {
    centerPrice: string | null;
    lastOrderUpdateAt: number | null;
    orderUpdateAgeMs: number | null;
    lastPositionUpdateAt: number | null;
    positionAgeMs: number | null;
    lastMaintenanceAt: number | null;
    maintenanceAgeMs: number | null;
    lastReconcileAt: number | null;
    reconcileAgeMs: number | null;
  };
}

const DEFAULT_THRESHOLDS: GridHealthThresholds = {
  marketStaleMs: 15000,
  positionStaleMs: 60000,
  maintenanceStaleMs: 5000,
  reconcileStaleMs: 15000,
};

/**
 * 网格运行健康检查器，输出关键状态与告警提示。
 */
export class GridHealthChecker {
  private readonly runtime: GridRuntime;
  private readonly thresholds: GridHealthThresholds;

  constructor(runtime: GridRuntime, thresholds?: Partial<GridHealthThresholds>) {
    this.runtime = runtime;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * 获取当前健康检查报告。
   */
  public check(): GridHealthReport {
    const now = Date.now();
    const snapshot = this.runtime.getMarketData().getLatestSnapshot();
    const orderStatus = this.runtime.getOrderManager().getStatus();

    const lastQuoteAt = snapshot?.source.ts ?? null;
    const quoteAgeMs = ageFrom(now, lastQuoteAt);
    const orderUpdateAgeMs = ageFrom(now, orderStatus.lastOrderUpdateAt);
    const positionAgeMs = ageFrom(now, orderStatus.lastPositionUpdateAt);
    const maintenanceAgeMs = ageFrom(now, orderStatus.lastMaintenanceAt);
    const reconcileAgeMs = ageFrom(now, orderStatus.lastReconcileAt);

    const warnings: string[] = [];
    if (quoteAgeMs === null) {
      warnings.push("暂无行情更新");
    } else if (quoteAgeMs > this.thresholds.marketStaleMs) {
      warnings.push(`行情更新过期: ${quoteAgeMs}ms`);
    }
    if (positionAgeMs !== null && positionAgeMs > this.thresholds.positionStaleMs) {
      warnings.push(`仓位更新过期: ${positionAgeMs}ms`);
    }
    if (maintenanceAgeMs !== null && maintenanceAgeMs > this.thresholds.maintenanceStaleMs) {
      warnings.push(`维护任务延迟: ${maintenanceAgeMs}ms`);
    }
    if (reconcileAgeMs !== null && reconcileAgeMs > this.thresholds.reconcileStaleMs) {
      warnings.push(`对账任务延迟: ${reconcileAgeMs}ms`);
    }

    return {
      ok: warnings.length === 0,
      now,
      warnings,
      market: {
        exchange: snapshot?.source.exchange ?? null,
        lastQuoteAt,
        quoteAgeMs,
      },
      order: {
        centerPrice: orderStatus.centerPrice?.toString() ?? null,
        lastOrderUpdateAt: orderStatus.lastOrderUpdateAt,
        orderUpdateAgeMs,
        lastPositionUpdateAt: orderStatus.lastPositionUpdateAt,
        positionAgeMs,
        lastMaintenanceAt: orderStatus.lastMaintenanceAt,
        maintenanceAgeMs,
        lastReconcileAt: orderStatus.lastReconcileAt,
        reconcileAgeMs,
      },
    };
  }
}

/**
 * 统一计算时间差，缺失时返回 null。
 */
function ageFrom(now: number, ts: number | null): number | null {
  if (ts === null) {
    return null;
  }
  return Math.max(0, now - ts);
}
