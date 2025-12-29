/**
 * 统一的定时调度器，负责按固定间隔驱动异步任务。
 * 重点保证同一任务不会并发执行，避免状态被重复修改。
 */
export interface TickTask {
  /** 任务名称，用于日志与并发控制 */
  name: string;
  /** 任务间隔（毫秒） */
  intervalMs: number;
  /** 任务执行函数，支持同步或异步 */
  run: () => Promise<void> | void;
  /** 是否在启动时立即执行一次 */
  runOnStart?: boolean;
}

/**
 * 基于 setInterval 的轻量调度器。
 */
export class TickDriver {
  private readonly tasks: TickTask[];
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly running = new Set<string>();
  private started = false;

  constructor(tasks: TickTask[]) {
    this.tasks = tasks;
  }

  /**
   * 启动所有任务调度，重复调用不会产生副作用。
   */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const task of this.tasks) {
      if (task.runOnStart) {
        this.trigger(task);
      }
      const timer = setInterval(() => {
        this.trigger(task);
      }, task.intervalMs);
      this.timers.set(task.name, timer);
    }
  }

  /**
   * 停止所有任务调度并清理定时器。
   */
  public stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.running.clear();
    this.started = false;
  }

  /**
   * 触发指定任务执行，自动跳过并发重入。
   */
  private trigger(task: TickTask): void {
    if (this.running.has(task.name)) {
      return;
    }
    this.running.add(task.name);
    Promise.resolve(task.run())
      .catch((error) => {
        console.warn(`调度任务执行失败: ${task.name}`, error);
      })
      .finally(() => {
        this.running.delete(task.name);
      });
  }
}
