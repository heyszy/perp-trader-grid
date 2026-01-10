import type {
  AccountSubscribeParams,
  GridExchangeAdapter,
  OrderHistoryQuery,
  OrderbookSubscribeParams,
  PlaceOrderRequest,
  PlaceOrderResult,
  Unsubscribe,
} from "../../../core/exchange/adapter";
import type {
  ExchangeOrder,
  ExchangePosition,
  MarketTradingConfig,
  OrderStatus,
  OrderUpdate,
} from "../../../core/exchange/models";
import { Decimal } from "../../../shared/number";
import type { HyperliquidConfig } from "../../config/schema";
import { createHyperliquidClients, type HyperliquidClients } from "./hyperliquid-client";
import { loadHyperliquidMarketContext, type HyperliquidMarketContext } from "./hyperliquid-context";
import { HyperliquidOrderbookStream } from "./hyperliquid-orderbook";
import { HyperliquidOrderIdStore } from "./hyperliquid-order";
import { hyperliquidSymbolMapper } from "./hyperliquid-symbol-mapper";
import {
  formatHyperliquidPrice,
  formatHyperliquidSize,
  isHyperliquidMinNotionalError,
  normalizeHyperliquidOrderStatus,
  normalizeHyperliquidSide,
  parseHyperliquidMinNotional,
} from "./hyperliquid-utils";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";
import { ApiRequestError } from "@nktkas/hyperliquid/api/exchange";
import { extractRetryAfterMs, isRateLimitError, RateLimitGuard } from "../rate-limit";
import type {
  ClearinghouseStateResponse,
  HistoricalOrdersResponse,
  OpenOrdersResponse,
  OrderStatusResponse,
} from "@nktkas/hyperliquid/api/info";

/**
 * Hyperliquid 交易所适配器实现。
 */
export class HyperliquidGridExchangeAdapter implements GridExchangeAdapter {
  public readonly name = "hyperliquid";
  public readonly capabilities = {
    supportsMassCancel: true,
    supportsPostOnly: true,
    supportsOrderbook: true,
    supportsMarkPrice: true,
  };

  private readonly symbol: string;
  private readonly exchangeSymbol: string;
  private readonly config: HyperliquidConfig;
  private readonly clients: HyperliquidClients;
  private readonly orderIds = new HyperliquidOrderIdStore();
  // Info 端点与账户订阅使用的用户地址，agent key 场景需显式配置真实账户地址。
  private readonly userAddress: string;
  // 当前交易对最小下单金额（USD），会在运行时根据报错动态调整。
  private minNotional: Decimal;
  // REST 请求全局限流守卫，避免 429 时继续高频打点。
  private readonly rateLimitGuard = new RateLimitGuard();

  private marketContext: HyperliquidMarketContext | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(config: HyperliquidConfig, symbol: string) {
    this.config = config;
    this.symbol = symbol;
    this.exchangeSymbol = hyperliquidSymbolMapper.toExchangeSymbol(symbol, config.dex);
    this.clients = createHyperliquidClients(config);
    // 未配置时回退到签名钱包地址，保持默认行为。
    this.userAddress = config.userAddress ?? this.clients.accountAddress;
    this.minNotional = config.minNotional ?? Decimal(10);
  }

  /**
   * 将统一交易对转换为交易所格式。
   */
  public resolveExchangeSymbol(symbol: string): string {
    return hyperliquidSymbolMapper.toExchangeSymbol(symbol, this.config.dex);
  }

  /**
   * 初始化市场元数据与费率信息。
   */
  public async connect(): Promise<void> {
    if (this.marketContext) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = (async () => {
      const symbolConverter = await this.withRateLimit(() =>
        SymbolConverter.create({
          transport: this.clients.httpTransport,
          dexs: this.config.dex ? [this.config.dex] : undefined,
        })
      );
      this.marketContext = await this.withRateLimit(() =>
        loadHyperliquidMarketContext({
          infoClient: this.clients.infoClient,
          symbol: this.symbol,
          userAddress: this.userAddress,
          symbolConverter,
          dex: this.config.dex,
        })
      );
    })();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /**
   * 释放连接资源并清空缓存。
   */
  public async disconnect(): Promise<void> {
    this.clients.wsTransport.socket.close();
    this.marketContext = null;
  }

  /**
   * 订阅订单簿与 mark 价格。
   */
  public subscribeOrderbook(params: OrderbookSubscribeParams): Unsubscribe {
    this.ensureSymbol(params.symbol);
    let unsubscribe: Unsubscribe = () => {
      // 占位，等待订阅建立后替换
    };
    let stopped = false;
    void this.connect()
      .then(async () => {
        if (stopped) {
          return;
        }
        const context = this.getMarketContext();
        const stream = new HyperliquidOrderbookStream({
          subscriptionClient: this.clients.subscriptionClient,
          exchange: this.name,
          symbol: this.exchangeSymbol,
          assetId: context.assetId,
          dex: this.config.dex,
        });
        unsubscribe = await stream.subscribe(params.onQuote);
      })
      .catch((error) => {
        console.error("Hyperliquid 行情订阅失败", error);
      });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }

  /**
   * 订阅订单更新与仓位快照。
   */
  public subscribeAccount(params: AccountSubscribeParams): Unsubscribe {
    let stopped = false;
    const unsubscribes: Unsubscribe[] = [];

    const start = async () => {
      await this.connect();
      if (stopped) {
        return;
      }
      const orderSub = await this.clients.subscriptionClient.orderUpdates(
        { user: this.userAddress },
        (event) => this.handleOrderUpdates(event, params)
      );
      unsubscribes.push(() => void orderSub.unsubscribe());

      if (params.onPositionUpdates) {
        const positionSub = await this.clients.subscriptionClient.clearinghouseState(
          { user: this.userAddress, dex: this.config.dex },
          (event) => this.handlePositionUpdate(event.clearinghouseState, params)
        );
        unsubscribes.push(() => void positionSub.unsubscribe());
      }
    };

    void start().catch((error) => {
      console.error("Hyperliquid 账户订阅失败", error);
    });

    return () => {
      stopped = true;
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }

  /**
   * 获取市场交易配置。
   */
  public async getMarketConfig(symbol: string): Promise<MarketTradingConfig> {
    this.ensureSymbol(symbol);
    await this.connect();
    return this.getMarketContext().tradingConfig;
  }

  /**
   * 获取净仓位（多为正，空为负）。
   */
  public async getNetPosition(symbol: string): Promise<Decimal> {
    this.ensureSymbol(symbol);
    await this.connect();
    const state = await this.withRateLimit(() =>
      this.clients.infoClient.clearinghouseState({
        user: this.userAddress,
        dex: this.config.dex,
      })
    );
    const position = this.findPosition(state);
    if (!position) {
      return Decimal(0);
    }
    return Decimal(position.position.szi);
  }

  /**
   * 根据 clientOrderId 获取订单状态。
   */
  public async getOrderByClientOrderId(clientOrderId: string): Promise<ExchangeOrder | null> {
    await this.connect();
    const cloid = this.orderIds.ensureCloid(clientOrderId);
    const response = await this.withRateLimit(() =>
      this.clients.infoClient.orderStatus({
        user: this.userAddress,
        oid: cloid,
      })
    );
    if (response.status === "unknownOid") {
      return null;
    }
    return this.mapOrderStatus(response);
  }

  /**
   * 获取当前挂单。
   */
  public async getOpenOrders(symbol: string): Promise<ExchangeOrder[]> {
    this.ensureSymbol(symbol);
    await this.connect();
    const openOrders = await this.withRateLimit(() =>
      this.clients.infoClient.openOrders({
        user: this.userAddress,
        dex: this.config.dex,
      })
    );
    return openOrders
      .map((order) => this.mapOpenOrder(order))
      .filter((order): order is ExchangeOrder => order !== null);
  }

  /**
   * 获取历史订单。
   */
  public async getOrdersHistory(query: OrderHistoryQuery): Promise<ExchangeOrder[]> {
    this.ensureSymbol(query.symbol);
    await this.connect();
    const history = await this.withRateLimit(() =>
      this.clients.infoClient.historicalOrders({
        user: this.userAddress,
      })
    );
    return history
      .filter((item) => item.order.coin === this.exchangeSymbol)
      .filter((item) => item.statusTimestamp >= query.sinceMs)
      .map((item) => this.mapHistoricalOrder(item))
      .filter((order): order is ExchangeOrder => order !== null);
  }

  /**
   * 下单。
   */
  public async placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    this.ensureSymbol(request.symbol);
    await this.connect();
    const context = this.getMarketContext();
    const notional = request.price.times(request.quantity);
    if (notional.lt(this.minNotional)) {
      return {
        status: "REJECTED",
        accountId: this.userAddress,
        exchangeOrderId: undefined,
        statusReason: "minNotionalPrecheck",
        errorCode: "MIN_NOTIONAL_PRECHECK",
        errorMessage: `notional=${notional.toString()} min=${this.minNotional.toString()}`,
        updatedAt: Date.now(),
      };
    }
    const cloid = this.orderIds.ensureCloid(request.clientOrderId);
    const formattedPrice = formatHyperliquidPrice(request.price, context.szDecimals);
    const formattedSize = formatHyperliquidSize(request.quantity, context.szDecimals);
    const tif = this.resolveTimeInForce(request);
    try {
      const result = await this.withRateLimit(() =>
        this.clients.exchangeClient.order({
          orders: [
            {
              a: context.assetId,
              b: request.side === "BUY",
              p: formattedPrice,
              s: formattedSize,
              r: request.reduceOnly ?? false,
              t: { limit: { tif } },
              c: cloid,
            },
          ],
          grouping: "na",
        })
      );
      const status = result.response.data.statuses[0];
      return this.mapPlaceOrderResult(status);
    } catch (error) {
      if (!(error instanceof ApiRequestError)) {
        throw error;
      }
      const message = error.message;
      const parsedMinNotional = parseHyperliquidMinNotional(message);
      if (parsedMinNotional) {
        this.minNotional = parsedMinNotional;
      }
      const isMinNotional = isHyperliquidMinNotionalError(message);
      return {
        status: "REJECTED",
        accountId: this.userAddress,
        exchangeOrderId: undefined,
        statusReason: message,
        errorCode: isMinNotional ? "MIN_NOTIONAL_REJECTED" : "EXCHANGE_REJECTED",
        errorMessage: message,
        updatedAt: Date.now(),
      };
    }
  }

  /**
   * 通过 clientOrderId 撤单。
   */
  public async cancelOrderByExternalId(externalId: string): Promise<void> {
    await this.connect();
    const context = this.getMarketContext();
    const cloid = this.orderIds.ensureCloid(externalId);
    await this.clients.exchangeClient.cancelByCloid({
      cancels: [
        {
          asset: context.assetId,
          cloid,
        },
      ],
    });
  }

  /**
   * 批量撤销挂单（按当前交易对）。
   */
  public async massCancel(symbol: string): Promise<void> {
    this.ensureSymbol(symbol);
    await this.connect();
    const context = this.getMarketContext();
    const openOrders = await this.withRateLimit(() =>
      this.clients.infoClient.openOrders({
        user: this.userAddress,
        dex: this.config.dex,
      })
    );
    const cancels = openOrders
      .filter((order) => order.coin === this.exchangeSymbol)
      .map((order) => ({ a: context.assetId, o: order.oid }));
    if (cancels.length === 0) {
      return;
    }
    await this.clients.exchangeClient.cancel({ cancels });
  }

  private ensureSymbol(symbol: string): void {
    if (!hyperliquidSymbolMapper.isSameMarket(symbol, this.exchangeSymbol, this.config.dex)) {
      throw new Error(`交易对不匹配: ${symbol} vs ${this.symbol}`);
    }
  }

  private getMarketContext(): HyperliquidMarketContext {
    if (!this.marketContext) {
      throw new Error("Hyperliquid 市场信息未初始化");
    }
    return this.marketContext;
  }

  /**
   * 统一封装 REST 调用，遇到 429 时自动进入退避窗口。
   */
  private async withRateLimit<T>(action: () => Promise<T>): Promise<T> {
    await this.rateLimitGuard.wait();
    try {
      const result = await action();
      this.rateLimitGuard.onSuccess();
      return result;
    } catch (error) {
      if (isRateLimitError(error)) {
        this.rateLimitGuard.onRateLimit(extractRetryAfterMs(error));
      }
      throw error;
    }
  }

  /**
   * 处理订单更新回报。
   */
  private handleOrderUpdates(
    event: Array<{ order: OpenOrdersResponse[number]; status: string; statusTimestamp: number }>,
    params: AccountSubscribeParams
  ): void {
    const updates = event
      .map((item) => this.mapOrderUpdate(item))
      .filter((update): update is OrderUpdate => update !== null);
    if (updates.length === 0) {
      return;
    }
    params.onOrderUpdates(updates);
  }

  /**
   * 处理仓位快照。
   */
  private handlePositionUpdate(
    state: ClearinghouseStateResponse,
    params: AccountSubscribeParams
  ): void {
    if (!params.onPositionUpdates) {
      return;
    }
    const position = this.findPosition(state);
    if (!position) {
      params.onPositionUpdates([]);
      return;
    }
    const size = Decimal(position.position.szi);
    if (size.isZero()) {
      params.onPositionUpdates([]);
      return;
    }
    const mapped: ExchangePosition = {
      symbol: this.symbol,
      side: size.isNegative() ? "SHORT" : "LONG",
      size: size.abs(),
      updatedAt: state.time,
    };
    params.onPositionUpdates([mapped]);
  }

  private findPosition(state: ClearinghouseStateResponse) {
    return state.assetPositions.find((item) => item.position.coin === this.exchangeSymbol);
  }

  /**
   * 映射订单状态查询结果。
   */
  private mapOrderStatus(
    response: Extract<OrderStatusResponse, { status: "order" }>
  ): ExchangeOrder | null {
    return this.buildExchangeOrder({
      order: response.order.order,
      status: response.order.status,
      statusTimestamp: response.order.statusTimestamp,
    });
  }

  /**
   * 映射挂单快照。
   */
  private mapOpenOrder(order: OpenOrdersResponse[number]): ExchangeOrder | null {
    return this.buildExchangeOrder({
      order,
      status: "open",
      statusTimestamp: order.timestamp,
    });
  }

  /**
   * 映射历史订单。
   */
  private mapHistoricalOrder(item: HistoricalOrdersResponse[number]): ExchangeOrder | null {
    return this.buildExchangeOrder({
      order: item.order,
      status: item.status,
      statusTimestamp: item.statusTimestamp,
    });
  }

  /**
   * 映射订单更新事件。
   */
  private mapOrderUpdate(item: {
    order: OpenOrdersResponse[number];
    status: string;
    statusTimestamp: number;
  }): OrderUpdate | null {
    const clientOrderId = this.orderIds.resolveClientOrderId(item.order.cloid);
    if (!clientOrderId) {
      return null;
    }
    const normalizedStatus = normalizeHyperliquidOrderStatus(item.status);
    return {
      accountId: this.userAddress,
      clientOrderId,
      exchangeOrderId: String(item.order.oid),
      status: normalizedStatus,
      statusReason: this.pickStatusReason(normalizedStatus, item.status),
      exchangeStatus: item.status,
      filledQuantity: this.resolveFilledQuantity(item.order.origSz, item.order.sz),
      updatedAt: item.statusTimestamp,
    };
  }

  /**
   * 统一订单结构构造。
   */
  private buildExchangeOrder(params: {
    order: {
      coin: string;
      side: "B" | "A";
      limitPx: string;
      sz: string;
      oid: number;
      timestamp: number;
      origSz: string;
      cloid?: string | null;
      reduceOnly?: boolean;
    };
    status: string;
    statusTimestamp: number;
  }): ExchangeOrder | null {
    if (params.order.coin !== this.exchangeSymbol) {
      return null;
    }
    const clientOrderId = this.orderIds.resolveClientOrderId(params.order.cloid);
    if (!clientOrderId) {
      return null;
    }
    const normalizedStatus = normalizeHyperliquidOrderStatus(params.status);
    return {
      accountId: this.userAddress,
      clientOrderId,
      exchangeOrderId: String(params.order.oid),
      status: normalizedStatus,
      statusReason: this.pickStatusReason(normalizedStatus, params.status),
      exchangeStatus: params.status,
      side: normalizeHyperliquidSide(params.order.side),
      price: Decimal(params.order.limitPx),
      quantity: Decimal(params.order.origSz),
      filledQuantity: this.resolveFilledQuantity(params.order.origSz, params.order.sz),
      updatedAt: params.statusTimestamp,
    };
  }

  /**
   * 解析成交数量（若无法判断则返回 undefined）。
   */
  private resolveFilledQuantity(origSz: string, remainingSz: string): Decimal | undefined {
    const original = Decimal(origSz);
    const remaining = Decimal(remainingSz);
    if (original.lte(remaining)) {
      return undefined;
    }
    return original.minus(remaining);
  }

  /**
   * 提取状态原因，仅在拒绝/撤销时写入。
   */
  private pickStatusReason(status: OrderStatus, rawStatus: string): string | undefined {
    if (status === "CANCELLED" || status === "REJECTED") {
      return rawStatus;
    }
    return undefined;
  }

  /**
   * 根据请求参数推导 Hyperliquid time-in-force。
   */
  private resolveTimeInForce(request: PlaceOrderRequest): "Gtc" | "Ioc" | "Alo" {
    if (request.postOnly) {
      return "Alo";
    }
    if (request.timeInForce === "IOC" || request.timeInForce === "FOK") {
      return "Ioc";
    }
    return "Gtc";
  }

  /**
   * 解析下单结果。
   */
  private mapPlaceOrderResult(status: HyperliquidOrderStatus): PlaceOrderResult {
    if (typeof status === "string") {
      return {
        status: "ACKED",
        accountId: this.userAddress,
        exchangeOrderId: undefined,
        statusReason: status,
        updatedAt: Date.now(),
      };
    }
    if ("error" in status) {
      return {
        status: "REJECTED",
        accountId: this.userAddress,
        exchangeOrderId: undefined,
        statusReason: status.error,
        errorMessage: status.error,
        updatedAt: Date.now(),
      };
    }
    if ("filled" in status) {
      return {
        status: "FILLED",
        accountId: this.userAddress,
        exchangeOrderId: String(status.filled.oid),
        updatedAt: Date.now(),
      };
    }
    if ("resting" in status) {
      return {
        status: "ACKED",
        accountId: this.userAddress,
        exchangeOrderId: String(status.resting.oid),
        updatedAt: Date.now(),
      };
    }
    return {
      status: "ACKED",
      accountId: this.userAddress,
      exchangeOrderId: undefined,
      statusReason: undefined,
      updatedAt: Date.now(),
    };
  }
}

type HyperliquidOrderStatus =
  | { resting: { oid: number; cloid?: string } }
  | { filled: { totalSz: string; avgPx: string; oid: number; cloid?: string } }
  | { error: string }
  | "waitingForFill"
  | "waitingForTrigger";
