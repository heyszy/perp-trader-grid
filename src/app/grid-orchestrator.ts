import { GridHealthChecker } from "./health/grid-health-checker";
import { TickDriver } from "./schedulers/tick-driver";
import type { GridRuntime } from "./grid-runtime";

/**
 * 运行编排配置项。
 */
export interface GridOrchestratorOptions {
  /** 健康检查间隔（毫秒） */
  healthCheckIntervalMs: number;
}

const DEFAULT_OPTIONS: GridOrchestratorOptions = {
  healthCheckIntervalMs: 10000,
};

/**
 * 网格运行编排器，负责生命周期、健康检查与定时任务调度。
 */
export class GridOrchestrator {
  private readonly runtime: GridRuntime;
  private readonly healthChecker: GridHealthChecker;
  private readonly tickDriver: TickDriver;
  private started = false;

  constructor(runtime: GridRuntime, options?: Partial<GridOrchestratorOptions>) {
    this.runtime = runtime;
    const orderManager = runtime.getOrderManager();
    const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };

    this.healthChecker = new GridHealthChecker(runtime, {
      maintenanceStaleMs: orderManager.getMaintenanceIntervalMs() * 3,
      reconcileStaleMs: orderManager.getReconcileIntervalMs() * 3,
    });

    this.tickDriver = new TickDriver([
      {
        name: "order-maintenance",
        intervalMs: orderManager.getMaintenanceIntervalMs(),
        run: () => orderManager.runMaintenance(),
        runOnStart: true,
      },
      {
        name: "health-check",
        intervalMs: resolvedOptions.healthCheckIntervalMs,
        run: () => this.reportHealth(),
        runOnStart: true,
      },
    ]);
  }

  /**
   * 启动运行时并开启调度器。
   */
  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.runtime.start();
    this.tickDriver.start();
    this.started = true;
  }

  /**
   * 停止调度器并关闭运行时。
   */
  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.tickDriver.stop();
    await this.runtime.stop();
    this.started = false;
  }

  /**
   * 输出健康检查结果，异常时升级为 warn。
   */
  private reportHealth(): void {
    const report = this.healthChecker.check();
    if (report.ok) {
      return;
    }
    const payload = {
      market: report.market,
      order: report.order,
      warnings: report.warnings,
    };
    console.warn("健康检查异常", payload);
  }
}
