import { loadAppConfig } from "../infra/config/env";
import type { AppConfig } from "../infra/config/schema";
import { createGridRuntime } from "../app/grid-runtime";
import { GridOrchestrator } from "../app/grid-orchestrator";
import { createDbClient, type DbClient } from "../infra/db";
import { OrderRepository } from "../infra/db/order-repo";
import { DbOrderRecorder } from "../services/recorder/order-recorder";

/**
 * 脱敏输出配置，避免日志泄露敏感信息。
 */
function maskConfig(config: AppConfig): AppConfig {
  if (config.exchange.name !== "extended" || !config.exchange.extended) {
    return config;
  }
  return {
    ...config,
    exchange: {
      ...config.exchange,
      extended: {
        ...config.exchange.extended,
        apiKey: "***",
        l2PrivateKey: "***",
      },
    },
  };
}

/**
 * 启动网格应用，负责配置加载与运行时装配。
 */
export async function startGridApp(): Promise<void> {
  const config = loadAppConfig();
  const safeConfig = maskConfig(config);
  console.info("配置加载成功", safeConfig);
  const dbClient = createDbClient(config.db);
  const orderRepository = new OrderRepository(dbClient.db);
  const orderRecorder = new DbOrderRecorder(orderRepository);
  const runtime = createGridRuntime(config, orderRecorder);
  const orchestrator = new GridOrchestrator(runtime);
  await orchestrator.start();
  console.info("交易所接入完成", {
    exchange: runtime.getExchange().name,
    symbol: config.grid.symbol,
  });
  registerProcessHooks(async (reason) => {
    await shutdownApp(orchestrator, dbClient, reason);
  });
}

/**
 * 统一处理进程退出流程，确保资源释放与日志输出。
 */
async function shutdownApp(
  orchestrator: GridOrchestrator,
  dbClient: DbClient,
  reason: ShutdownReason
): Promise<void> {
  if (reason.error) {
    console.error("运行异常，即将退出", reason.error);
  } else {
    console.info("收到退出信号，准备退出", { reason: reason.reason });
  }
  try {
    await orchestrator.stop();
  } catch (error) {
    console.error("停止运行编排失败", error);
  }
  try {
    dbClient.sqlite.close();
  } catch (error) {
    console.warn("关闭数据库失败", error);
  }
  console.info("退出流程完成");
  process.exit(reason.error ? 1 : 0);
}

/**
 * 注册进程信号与异常处理入口。
 */
function registerProcessHooks(onShutdown: (reason: ShutdownReason) => Promise<void>): void {
  let shuttingDown = false;
  const runOnce = (reason: ShutdownReason) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void onShutdown(reason);
  };
  process.once("SIGINT", () => runOnce({ reason: "SIGINT" }));
  process.once("SIGTERM", () => runOnce({ reason: "SIGTERM" }));
  process.once("uncaughtException", (error) => runOnce({ reason: "uncaughtException", error }));
  process.once("unhandledRejection", (error) => runOnce({ reason: "unhandledRejection", error }));
}

/**
 * 退出原因描述，便于统一日志输出。
 */
type ShutdownReason = {
  reason: string;
  error?: unknown;
};
