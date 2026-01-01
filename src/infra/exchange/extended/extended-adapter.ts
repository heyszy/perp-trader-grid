import { createOrderRequest, type StarknetDomain, type Subscription } from "@shenzheyu/extended";
import type { schemas } from "@shenzheyu/extended";
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
  OrderUpdate,
} from "../../../core/exchange/models";
import { Decimal } from "../../../shared/number";
import type { ExtendedConfig } from "../../config/schema";
import { loadAccountInfo, loadFees, loadMarketInfo } from "./extended-context";
import { createExtendedClients, type ExtendedApiClients } from "./extended-client";
import { ExtendedOrderbookStream } from "./extended-orderbook";
import { BUILDER_FEE_CAP, BUILDER_ID, normalizeOrderStatus, roundToStep } from "./extended-utils";
import { extendedSymbolMapper } from "./extended-symbol-mapper";
import { extractRetryAfterMs, isRateLimitError, RateLimitGuard } from "./extended-rate-limit";

/**
 * Extended 交易所适配器实现。
 */
export class ExtendedGridExchangeAdapter implements GridExchangeAdapter {
  public readonly name = "extended";
  public readonly capabilities = {
    supportsMassCancel: true,
    supportsPostOnly: true,
    supportsOrderbook: true,
    supportsMarkPrice: true,
  };
  private readonly symbol: string;
  private readonly marketName: string;
  private readonly clients: ExtendedApiClients;
  private accountInfo: Awaited<ReturnType<typeof loadAccountInfo>> | null = null;
  private marketInfo: schemas.Market | null = null;
  private fees: schemas.Fees | null = null;
  private starknetDomain: StarknetDomain | null = null;
  private connectPromise: Promise<void> | null = null;
  // REST 请求全局限流守卫，避免 429 时继续高频打点。
  private readonly rateLimitGuard = new RateLimitGuard();

  constructor(config: ExtendedConfig, symbol: string) {
    this.symbol = symbol;
    this.marketName = extendedSymbolMapper.toExchangeSymbol(symbol);
    this.clients = createExtendedClients(config);
  }

  /**
   * 将统一交易对转换为交易所格式。
   */
  public resolveExchangeSymbol(symbol: string): string {
    return extendedSymbolMapper.toExchangeSymbol(symbol);
  }

  /**
   * 建立基础上下文（账户、市场、费率、签名域）。
   */
  public async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = (async () => {
      this.accountInfo = await this.withRateLimit(() =>
        loadAccountInfo(this.clients.privateClient)
      );
      this.marketInfo = await this.withRateLimit(() =>
        loadMarketInfo(this.clients.publicClient, this.marketName)
      );
      this.fees = await this.withRateLimit(() =>
        loadFees(this.clients.privateClient, this.marketName, BUILDER_ID)
      );
      this.starknetDomain = this.clients.endpoint.starknetDomain ?? null;
    })();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /**
   * 释放资源，清空缓存。
   */
  public async disconnect(): Promise<void> {
    this.accountInfo = null;
    this.marketInfo = null;
    this.fees = null;
    this.starknetDomain = null;
  }

  /**
   * 订阅订单簿与 mark 行情。
   */
  public subscribeOrderbook(params: OrderbookSubscribeParams): Unsubscribe {
    this.ensureSymbol(params.symbol);
    const stream = new ExtendedOrderbookStream(
      this.clients.streamClient,
      this.marketName,
      this.name
    );
    let unsubscribe: Unsubscribe = () => {
      // 占位，等待真正的订阅建立后替换
    };
    let stopped = false;
    void this.connect()
      .then(() => {
        if (stopped) {
          return;
        }
        unsubscribe = stream.subscribe(params.onQuote);
      })
      .catch((error) => {
        console.error("订阅行情失败", error);
      });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }

  /**
   * 订阅账户订单回报。
   */
  public subscribeAccount(params: AccountSubscribeParams): Unsubscribe {
    let stopped = false;
    let subscription: Subscription | null = null;
    let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;

    const handleMessage = (message: schemas.AccountUpdateMessage) => {
      if (message.type === "ORDER") {
        const updates = message.data.orders.map((order) => this.mapOrderUpdate(order));
        if (updates.length === 0) {
          return;
        }
        params.onOrderUpdates(updates);
        return;
      }

      if (message.type === "POSITION") {
        if (!params.onPositionUpdates) {
          return;
        }
        const positions = message.data.positions
          .filter((position) => position.market === this.marketName)
          .map((position) => this.mapExchangePosition(position));
        if (positions.length === 0) {
          return;
        }
        params.onPositionUpdates(positions);
      }
    };

    const clearResubscribeTimer = () => {
      if (resubscribeTimer) {
        clearTimeout(resubscribeTimer);
        resubscribeTimer = null;
      }
    };

    const unsubscribeCurrent = async () => {
      if (!subscription) {
        return;
      }
      try {
        await subscription.unsubscribe();
      } catch (error) {
        console.warn("取消账户订阅失败", error);
      } finally {
        subscription = null;
      }
    };

    const scheduleResubscribe = (reason: string, error?: unknown) => {
      if (stopped || resubscribeTimer) {
        return;
      }
      console.warn(`账户订阅即将重试: ${reason}`, error);
      resubscribeTimer = setTimeout(() => {
        resubscribeTimer = null;
        void start();
      }, 1000);
    };

    const start = async () => {
      if (stopped) {
        return;
      }
      await this.connect();
      await unsubscribeCurrent();
      try {
        subscription = await this.clients.streamClient.stream.accountUpdates(handleMessage);
        subscription.failureSignal.addEventListener("abort", () => {
          scheduleResubscribe("账户订阅中断");
        });
      } catch (error) {
        scheduleResubscribe("账户订阅失败", error);
      }
    };

    void start();

    return () => {
      stopped = true;
      clearResubscribeTimer();
      void unsubscribeCurrent();
    };
  }

  /**
   * 获取市场交易配置。
   */
  public async getMarketConfig(symbol: string): Promise<MarketTradingConfig> {
    this.ensureSymbol(symbol);
    await this.connect();
    if (!this.marketInfo || !this.fees) {
      throw new Error("市场信息未初始化");
    }
    return {
      minPriceChange: Decimal(this.marketInfo.tradingConfig.minPriceChange),
      minOrderSizeChange: Decimal(this.marketInfo.tradingConfig.minOrderSizeChange),
      makerFee: Decimal(this.fees.makerFeeRate),
      takerFee: Decimal(this.fees.takerFeeRate),
    };
  }

  /**
   * 获取当前市场净仓位（多为正，空为负）。
   */
  public async getNetPosition(symbol: string): Promise<Decimal> {
    this.ensureSymbol(symbol);
    await this.connect();
    const positions = await this.withRateLimit(() =>
      this.clients.privateClient.account.getPositions({
        market: [this.marketName],
      })
    );
    const position = positions.find((item) => item.market === this.marketName);
    if (!position) {
      return Decimal(0);
    }
    const size = Decimal(position.size);
    if (size.isZero()) {
      return Decimal(0);
    }
    return position.side === "LONG" ? size : size.negated();
  }

  /**
   * 根据 clientOrderId 获取订单最新状态。
   */
  public async getOrderByClientOrderId(clientOrderId: string): Promise<ExchangeOrder | null> {
    await this.connect();
    const orders = await this.withRateLimit(() =>
      this.clients.privateClient.orders.getOrdersByExternalId(clientOrderId)
    );
    const matches = orders.filter((order) => order.market === this.marketName);
    if (matches.length === 0) {
      return null;
    }
    const latest = matches.reduce((acc, current) =>
      current.updatedTime > acc.updatedTime ? current : acc
    );
    return this.mapExchangeOrder(latest);
  }

  /**
   * 获取未成交订单列表。
   */
  public async getOpenOrders(symbol: string): Promise<ExchangeOrder[]> {
    this.ensureSymbol(symbol);
    await this.connect();
    const orders = await this.withRateLimit(() =>
      this.clients.privateClient.orders.getOpenOrders({
        market: [this.marketName],
      })
    );
    return orders.map((order) => this.mapExchangeOrder(order));
  }

  /**
   * 获取历史订单列表（按时间过滤）。
   */
  public async getOrdersHistory(query: OrderHistoryQuery): Promise<ExchangeOrder[]> {
    this.ensureSymbol(query.symbol);
    await this.connect();
    const result = await this.withRateLimit(() =>
      this.clients.privateClient.orders.getOrdersHistory({
        market: [this.marketName],
        limit: 100,
      })
    );
    const cutoff = query.sinceMs;
    return result.data
      .filter((order) => order.updatedTime >= cutoff)
      .map((order) => this.mapExchangeOrder(order));
  }

  /**
   * 提交订单。
   */
  public async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    this.ensureSymbol(req.symbol);
    await this.connect();
    if (!this.marketInfo || !this.fees || !this.starknetDomain || !this.accountInfo) {
      throw new Error("Extended 上下文未准备好");
    }
    const normalizedPrice = roundToStep(
      Decimal(req.price),
      Decimal(this.marketInfo.tradingConfig.minPriceChange)
    );
    const normalizedQty = roundToStep(
      Decimal(req.quantity),
      Decimal(this.marketInfo.tradingConfig.minOrderSizeChange)
    );
    if (normalizedPrice.lte(0) || normalizedQty.lte(0)) {
      throw new Error("下单价格或数量无效，可能小于最小步长");
    }

    const isPostOnly = req.type === "LIMIT" && req.postOnly === true;
    const selectedFeeRate = isPostOnly
      ? Decimal(this.fees.makerFeeRate)
      : Decimal(this.fees.takerFeeRate);
    const feesForOrder: schemas.Fees = {
      ...this.fees,
      makerFeeRate: selectedFeeRate,
      takerFeeRate: selectedFeeRate,
    };

    const builderFee = Decimal.min(Decimal(this.fees.builderFeeRate), BUILDER_FEE_CAP);

    const timeInForce = req.timeInForce === "GTC" ? "GTT" : req.timeInForce;
    const orderRequest = await createOrderRequest({
      id: req.clientOrderId,
      market: this.marketInfo,
      fees: feesForOrder,
      signer: this.clients.signer,
      vaultId: this.accountInfo.l2Vault,
      side: req.side,
      qty: normalizedQty,
      price: normalizedPrice,
      type: req.type,
      timeInForce: timeInForce ?? (req.type === "MARKET" ? "IOC" : "GTT"),
      expiryTime: req.expireTimeMs,
      reduceOnly: req.reduceOnly,
      postOnly: req.type === "MARKET" ? false : req.postOnly,
      builderId: BUILDER_ID,
      builderFee,
      starknetDomain: this.starknetDomain,
    });

    const result = await this.withRateLimit(() =>
      this.clients.privateClient.orders.placeOrder(orderRequest)
    );
    return {
      status: "ACKED",
      exchangeOrderId: String(result.id),
      updatedAt: Date.now(),
    };
  }

  /**
   * 通过 externalId 撤单。
   */
  public async cancelOrderByExternalId(externalId: string): Promise<void> {
    await this.connect();
    await this.withRateLimit(() =>
      this.clients.privateClient.orders.cancelOrderByExternalId(externalId)
    );
  }

  /**
   * 批量撤单。
   */
  public async massCancel(symbol: string): Promise<void> {
    this.ensureSymbol(symbol);
    await this.connect();
    await this.withRateLimit(() =>
      this.clients.privateClient.orders.massCancel({
        markets: [this.marketName],
      })
    );
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

  private ensureSymbol(symbol: string): void {
    if (!extendedSymbolMapper.isSameMarket(symbol, this.marketName)) {
      throw new Error(`交易对不匹配: ${symbol} vs ${this.symbol}`);
    }
  }

  private mapExchangeOrder(order: schemas.UserOrder): ExchangeOrder {
    return {
      accountId: order.accountId ? String(order.accountId) : undefined,
      clientOrderId: order.externalId,
      exchangeOrderId: order.id?.toString(),
      status: normalizeOrderStatus(order.status),
      statusReason: order.statusReason,
      exchangeStatus: order.status,
      side: order.side,
      price: Decimal(order.price ?? order.averagePrice ?? 0),
      quantity: Decimal(order.qty),
      filledQuantity: order.filledQty ? Decimal(order.filledQty) : undefined,
      avgFillPrice: order.averagePrice ? Decimal(order.averagePrice) : undefined,
      updatedAt: order.updatedTime,
    };
  }

  private mapOrderUpdate(order: schemas.UserOrder): OrderUpdate {
    return {
      accountId: order.accountId ? String(order.accountId) : undefined,
      clientOrderId: order.externalId,
      exchangeOrderId: order.id?.toString(),
      status: normalizeOrderStatus(order.status),
      statusReason: order.statusReason,
      exchangeStatus: order.status,
      filledQuantity: order.filledQty ? Decimal(order.filledQty) : undefined,
      avgFillPrice: order.averagePrice ? Decimal(order.averagePrice) : undefined,
      updatedAt: order.updatedTime,
    };
  }

  private mapExchangePosition(
    position: Extract<
      schemas.AccountUpdateMessage,
      { type: "POSITION" }
    >["data"]["positions"][number]
  ): ExchangePosition {
    return {
      symbol: this.symbol,
      side: position.side,
      size: Decimal(position.size),
      updatedAt: position.updatedAt,
    };
  }
}
