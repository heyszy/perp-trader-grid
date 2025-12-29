import type { GridExchangeAdapter } from "../core/exchange/adapter";
import type { AppConfig } from "../infra/config/schema";
import { createExchangeAdapter } from "../infra/exchange/factory";
import { GridOrderManager } from "../services/grid/grid-order-manager";
import type { OrderRecorder } from "../services/recorder/order-recorder";
import { MarketDataService } from "../services/market-data/market-data-service";

/**
 * 网格运行时，负责装配交易所、行情服务与订单管理器。
 */
export class GridRuntime {
  private readonly exchange: GridExchangeAdapter;
  private readonly marketData: MarketDataService;
  private readonly orderManager: GridOrderManager;

  constructor(
    exchange: GridExchangeAdapter,
    marketData: MarketDataService,
    orderManager: GridOrderManager
  ) {
    this.exchange = exchange;
    this.marketData = marketData;
    this.orderManager = orderManager;
  }

  /**
   * 启动运行时：连接交易所、启动行情订阅。
   */
  public async start(): Promise<void> {
    await this.exchange.connect();
    this.marketData.start();
    await this.orderManager.start();
  }

  /**
   * 停止运行时：停止行情订阅并断开交易所。
   */
  public async stop(): Promise<void> {
    await this.orderManager.stop();
    this.marketData.stop();
    await this.exchange.disconnect();
  }

  /**
   * 暴露交易所实例，供上层服务使用。
   */
  public getExchange(): GridExchangeAdapter {
    return this.exchange;
  }

  /**
   * 暴露行情服务，供上层服务订阅。
   */
  public getMarketData(): MarketDataService {
    return this.marketData;
  }

  /**
   * 暴露订单管理器，供编排层驱动维护与对账。
   */
  public getOrderManager(): GridOrderManager {
    return this.orderManager;
  }
}

/**
 * 创建网格运行时，并检查交易所能力要求。
 */
export function createGridRuntime(config: AppConfig, orderRecorder?: OrderRecorder): GridRuntime {
  const exchange = createExchangeAdapter(config);
  if (!exchange.capabilities.supportsMarkPrice) {
    throw new Error("交易所不支持 mark 价格，无法启动网格");
  }
  if (!exchange.capabilities.supportsOrderbook) {
    throw new Error("交易所不支持订单簿行情，无法启动网格");
  }

  const marketData = new MarketDataService([
    {
      exchange: exchange.name,
      subscribe: (listener) =>
        exchange.subscribeOrderbook({
          symbol: config.grid.symbol,
          onQuote: listener,
        }),
    },
  ]);

  const orderManager = new GridOrderManager(exchange, marketData, config.grid, orderRecorder);

  return new GridRuntime(exchange, marketData, orderManager);
}
