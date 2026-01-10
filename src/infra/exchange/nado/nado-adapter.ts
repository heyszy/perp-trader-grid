import {
  ENGINE_WS_CLIENT_ENDPOINTS,
  ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS,
  EngineServerFailureError,
  ProductEngineType,
  subaccountToHex,
  type EngineOrder,
  type EngineServerSubscriptionFillEvent,
  type EngineServerSubscriptionOrderUpdateEvent,
  type EngineServerSubscriptionPositionChangeEvent,
  type IndexerOrder,
  type NadoClient,
} from "@nadohq/client";
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
import type { NadoConfig } from "../../config/schema";
import { createNadoClients } from "./nado-client";
import { loadNadoMarketContext, roundToStep, type NadoMarketContext } from "./nado-context";
import { NadoOrderbookStream } from "./nado-orderbook";
import { buildNadoOrderParams, NadoOrderIdStore } from "./nado-order";
import { nadoSymbolMapper } from "./nado-symbol-mapper";
import { fromX18, normalizeTimestampMs, toDecimal } from "./nado-utils";
import { NadoWsManager } from "./nado-ws";
import { extractRetryAfterMs, isRateLimitError, RateLimitGuard } from "../rate-limit";

/**
 * Nado 交易所适配器实现。
 */
export class NadoGridExchangeAdapter implements GridExchangeAdapter {
  public readonly name = "nado";
  public readonly capabilities = {
    supportsMassCancel: true,
    supportsPostOnly: true,
    supportsOrderbook: true,
    supportsMarkPrice: true,
  };

  private readonly symbol: string;
  private readonly exchangeSymbol: string;
  private readonly client: NadoClient;
  private readonly subaccountOwner: string;
  private readonly subaccountNames: string[];
  private readonly orderIds = new NadoOrderIdStore();
  private readonly wsManager: NadoWsManager;
  private marketContext: NadoMarketContext | null = null;
  private connectPromise: Promise<void> | null = null;
  // REST 请求全局限流守卫，避免 429 时继续高频打点。
  private readonly rateLimitGuard = new RateLimitGuard();

  constructor(config: NadoConfig, symbol: string) {
    this.symbol = symbol;
    this.exchangeSymbol = nadoSymbolMapper.toExchangeSymbol(symbol);
    const { client } = createNadoClients(config);
    this.client = client;
    const walletClient = this.client.context.walletClient;
    if (!walletClient) {
      throw new Error("Nado 未配置 walletClient");
    }
    this.subaccountOwner = walletClient.account.address;
    this.subaccountNames = config.subaccountNames;
    this.wsManager = new NadoWsManager({
      client: this.client,
      wsUrl: ENGINE_WS_CLIENT_ENDPOINTS.inkMainnet,
      subscriptionUrl: ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS.inkMainnet,
    });
  }

  /**
   * 将统一交易对转换为交易所格式。
   */
  public resolveExchangeSymbol(symbol: string): string {
    return nadoSymbolMapper.toExchangeSymbol(symbol);
  }

  /**
   * 初始化市场上下文。
   */
  public async connect(): Promise<void> {
    if (this.marketContext) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = (async () => {
      this.marketContext = await this.withRateLimit(() =>
        loadNadoMarketContext(this.client, this.symbol)
      );
    })();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /**
   * 释放连接资源。
   */
  public async disconnect(): Promise<void> {
    this.wsManager.close();
    this.marketContext = null;
  }

  /**
   * 订阅行情。
   */
  public subscribeOrderbook(params: OrderbookSubscribeParams): Unsubscribe {
    this.ensureSymbol(params.symbol);
    let unsubscribe: Unsubscribe = () => {
      // 等待连接完成后替换
    };
    let stopped = false;
    void this.connect()
      .then(() => {
        if (stopped) {
          return;
        }
        const stream = new NadoOrderbookStream(this.wsManager, this.getProductId(), this.name);
        unsubscribe = stream.subscribe(params.onQuote);
      })
      .catch((error) => {
        console.error("Nado 行情订阅失败", error);
      });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }

  /**
   * 订阅订单与仓位更新。
   */
  public subscribeAccount(params: AccountSubscribeParams): Unsubscribe {
    let stopped = false;
    const unsubscribes: Unsubscribe[] = [];

    const start = async () => {
      await this.connect();
      if (stopped) {
        return;
      }
      const productId = this.getProductId();
      for (const subaccountName of this.subaccountNames) {
        const subaccountHex = subaccountToHex({
          subaccountOwner: this.subaccountOwner,
          subaccountName,
        });
        unsubscribes.push(
          this.wsManager.subscribe(
            "order_update",
            {
              product_id: productId,
              subaccount: subaccountHex,
            },
            (event) => this.handleOrderUpdate(event, subaccountName, params)
          )
        );
        unsubscribes.push(
          this.wsManager.subscribe(
            "fill",
            {
              product_id: productId,
              subaccount: subaccountHex,
            },
            (event) => this.handleFill(event, subaccountName, params)
          )
        );
        unsubscribes.push(
          this.wsManager.subscribe(
            "position_change",
            {
              product_id: productId,
              subaccount: subaccountHex,
            },
            (event) => this.handlePositionChange(event, subaccountName, params)
          )
        );
      }
    };

    void start().catch((error) => {
      console.error("Nado 账户订阅启动失败", error);
    });

    return () => {
      stopped = true;
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }

  /**
   * 获取市场配置。
   */
  public async getMarketConfig(symbol: string): Promise<MarketTradingConfig> {
    this.ensureSymbol(symbol);
    await this.connect();
    return this.getMarketContext().tradingConfig;
  }

  /**
   * 获取净仓位（跨子账户求和）。
   */
  public async getNetPosition(symbol: string): Promise<Decimal> {
    this.ensureSymbol(symbol);
    await this.connect();
    const productId = this.getProductId();
    const summaries = [];
    for (const name of this.subaccountNames) {
      const summary = await this.withRateLimit(() =>
        this.client.subaccount.getSubaccountSummary({
          subaccountOwner: this.subaccountOwner,
          subaccountName: name,
        })
      );
      summaries.push(summary);
    }
    let net = Decimal(0);
    for (const summary of summaries) {
      const balance = summary.balances.find(
        (item) => item.productId === productId && item.type === ProductEngineType.PERP
      );
      if (!balance) {
        continue;
      }
      net = net.plus(toDecimal(balance.amount));
    }
    return net;
  }

  /**
   * 根据 clientOrderId 查询订单。
   */
  public async getOrderByClientOrderId(clientOrderId: string): Promise<ExchangeOrder | null> {
    await this.connect();
    const digest = this.orderIds.resolveDigest(clientOrderId);
    if (!digest) {
      return null;
    }
    try {
      const order = await this.withRateLimit(() =>
        this.client.context.engineClient.getOrder({
          productId: this.getProductId(),
          digest,
        })
      );
      return this.mapEngineOrder(order, clientOrderId);
    } catch (error) {
      // 2020: digest 不存在（已撤单或已完全成交并被清理），视为无订单。
      if (error instanceof EngineServerFailureError && error.responseData.error_code === 2020) {
        return null;
      }
      throw error;
    }
  }

  /**
   * 获取当前子账户的挂单列表。
   */
  public async getOpenOrders(symbol: string): Promise<ExchangeOrder[]> {
    this.ensureSymbol(symbol);
    await this.connect();
    const productId = this.getProductId();
    const orders = [];
    for (const name of this.subaccountNames) {
      const response = await this.withRateLimit(() =>
        this.client.market.getOpenSubaccountOrders({
          productId,
          subaccountOwner: this.subaccountOwner,
          subaccountName: name,
        })
      );
      orders.push(response);
    }
    return orders.flatMap((response) => response.orders.map((order) => this.mapEngineOrder(order)));
  }

  /**
   * 查询历史订单。
   */
  public async getOrdersHistory(query: OrderHistoryQuery): Promise<ExchangeOrder[]> {
    this.ensureSymbol(query.symbol);
    await this.connect();
    const productId = this.getProductId();
    const orders = await this.withRateLimit(() =>
      this.client.market.getHistoricalOrders({
        productIds: [productId],
        subaccounts: this.subaccountNames.map((name) => ({
          subaccountOwner: this.subaccountOwner,
          subaccountName: name,
        })),
      })
    );
    const cutoff = query.sinceMs;
    return orders
      .filter((order) => order.recvTimeSeconds * 1000 >= cutoff)
      .map((order) => this.mapIndexerOrder(order));
  }

  /**
   * 下单。
   */
  public async placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    this.ensureSymbol(request.symbol);
    await this.connect();
    const context = this.getMarketContext();
    const normalizedPrice = roundToStep(request.price, context.tradingConfig.minPriceChange);
    const normalizedQty = roundToStep(request.quantity, context.tradingConfig.minOrderSizeChange);
    if (normalizedPrice.lte(0) || normalizedQty.lte(0)) {
      // 提供详细的步长与数值信息，便于定位配置与交易所最小步长不匹配的问题。
      const detail = [
        `symbol=${context.exchangeSymbol}`,
        `price=${request.price.toString()}`,
        `minPriceChange=${context.tradingConfig.minPriceChange.toString()}`,
        `normalizedPrice=${normalizedPrice.toString()}`,
        `quantity=${request.quantity.toString()}`,
        `minOrderSizeChange=${context.tradingConfig.minOrderSizeChange.toString()}`,
        `normalizedQty=${normalizedQty.toString()}`,
      ].join(", ");
      throw new Error(`下单价格或数量无效，可能小于最小步长: ${detail}`);
    }
    const subaccountName = this.getDefaultSubaccountName();
    const clientOrderNum = this.orderIds.registerClientOrder(request.clientOrderId, subaccountName);
    const orderParams = buildNadoOrderParams(
      {
        ...request,
        price: normalizedPrice,
        quantity: normalizedQty,
      },
      subaccountName,
      this.subaccountOwner
    );
    const result = await this.withRateLimit(() =>
      this.client.market.placeOrder({
        id: clientOrderNum,
        productId: context.productId,
        order: orderParams,
      })
    );
    if (result.data.error) {
      throw new Error(`Nado 下单失败: ${result.data.error}`);
    }
    this.orderIds.recordDigest(request.clientOrderId, result.data.digest);
    return {
      status: "ACKED",
      accountId: subaccountName,
      exchangeOrderId: result.data.digest,
      clientOrderNum,
      updatedAt: Date.now(),
    };
  }

  /**
   * 通过 clientOrderId 撤单。
   */
  public async cancelOrderByExternalId(externalId: string): Promise<void> {
    await this.connect();
    const digest = this.orderIds.resolveDigest(externalId);
    if (!digest) {
      throw new Error(`未找到订单 digest: ${externalId}`);
    }
    const subaccountName =
      this.orderIds.resolveSubaccountName(externalId) ?? this.getDefaultSubaccountName();
    await this.withRateLimit(() =>
      this.client.market.cancelOrders({
        productIds: [this.getProductId()],
        digests: [digest],
        subaccountOwner: this.subaccountOwner,
        subaccountName,
      })
    );
  }

  /**
   * 批量撤销指定产品的挂单。
   */
  public async massCancel(symbol: string): Promise<void> {
    this.ensureSymbol(symbol);
    await this.connect();
    const productId = this.getProductId();
    for (const name of this.subaccountNames) {
      await this.withRateLimit(() =>
        this.client.market.cancelProductOrders({
          productIds: [productId],
          subaccountOwner: this.subaccountOwner,
          subaccountName: name,
        })
      );
    }
  }

  private getMarketContext(): NadoMarketContext {
    if (!this.marketContext) {
      throw new Error("Nado 市场信息未初始化");
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

  private getProductId(): number {
    return this.getMarketContext().productId;
  }

  private getDefaultSubaccountName(): string {
    return this.subaccountNames[0] ?? "default";
  }

  private ensureSymbol(symbol: string): void {
    if (!nadoSymbolMapper.isSameMarket(symbol, this.exchangeSymbol)) {
      throw new Error(`交易对不匹配: ${symbol} -> ${this.exchangeSymbol}`);
    }
  }

  private handleOrderUpdate(
    event: EngineServerSubscriptionOrderUpdateEvent,
    subaccountName: string,
    params: AccountSubscribeParams
  ): void {
    const clientOrderNum = this.readClientOrderNum(event);
    const clientOrderId = this.orderIds.resolveClientOrderId({
      clientOrderNum,
      digest: event.digest,
    });
    if (!clientOrderId) {
      return;
    }
    const update: OrderUpdate = {
      accountId: subaccountName,
      clientOrderId,
      clientOrderNum,
      exchangeOrderId: event.digest,
      status: mapOrderUpdateStatus(event.reason),
      exchangeStatus: event.reason,
      updatedAt: normalizeTimestampMs(event.timestamp),
    };
    params.onOrderUpdates([update]);
  }

  private handleFill(
    event: EngineServerSubscriptionFillEvent,
    subaccountName: string,
    params: AccountSubscribeParams
  ): void {
    const clientOrderNum = this.readClientOrderNum(event);
    const digest = event.order_digest;
    const clientOrderId = this.orderIds.resolveClientOrderId({
      clientOrderNum,
      digest,
    });
    if (!clientOrderId) {
      return;
    }
    const original = fromX18(event.original_qty);
    const remaining = fromX18(event.remaining_qty);
    const filled = original.minus(remaining);
    const price = fromX18(event.price);
    const status: OrderStatus = remaining.gt(0) ? "PARTIALLY_FILLED" : "FILLED";
    const update: OrderUpdate = {
      accountId: subaccountName,
      clientOrderId,
      clientOrderNum,
      exchangeOrderId: digest,
      status,
      exchangeStatus: status,
      filledQuantity: filled,
      avgFillPrice: filled.gt(0) ? price : undefined,
      updatedAt: normalizeTimestampMs(event.timestamp),
    };
    params.onOrderUpdates([update]);
  }

  private handlePositionChange(
    event: EngineServerSubscriptionPositionChangeEvent,
    _subaccountName: string,
    params: AccountSubscribeParams
  ): void {
    if (!params.onPositionUpdates) {
      return;
    }
    if (event.product_id !== this.getProductId()) {
      return;
    }
    const amount = fromX18(event.amount);
    const side = amount.gte(0) ? "LONG" : "SHORT";
    const position: ExchangePosition = {
      symbol: this.symbol,
      side,
      size: amount.abs(),
      updatedAt: normalizeTimestampMs(event.timestamp),
    };
    params.onPositionUpdates([position]);
  }

  private mapEngineOrder(order: EngineOrder, clientOrderId?: string): ExchangeOrder {
    const totalAmount = fromX18(order.totalAmount);
    const unfilledAmount = fromX18(order.unfilledAmount);
    const filledQuantity = totalAmount.minus(unfilledAmount);
    const status: OrderStatus =
      unfilledAmount.eq(totalAmount) && filledQuantity.eq(0)
        ? "ACKED"
        : unfilledAmount.gt(0)
          ? "PARTIALLY_FILLED"
          : "FILLED";
    const digest = order.digest;
    const resolvedClientOrderId =
      clientOrderId ?? this.orderIds.resolveClientOrderId({ digest }) ?? digest;
    return {
      accountId: order.subaccountName,
      clientOrderId: resolvedClientOrderId,
      clientOrderNum: this.orderIds.resolveClientOrderNumByDigest(digest) ?? undefined,
      exchangeOrderId: digest,
      status,
      exchangeStatus: status,
      side: totalAmount.gte(0) ? "BUY" : "SELL",
      price: toDecimal(order.price),
      quantity: totalAmount.abs(),
      filledQuantity: filledQuantity.abs(),
      avgFillPrice: filledQuantity.gt(0) ? toDecimal(order.price) : undefined,
      updatedAt: normalizeTimestampMs(String(order.placementTime)),
    };
  }

  private mapIndexerOrder(order: IndexerOrder): ExchangeOrder {
    const amount = fromX18(order.amount);
    const filledQuantity = fromX18(order.baseFilled);
    const avgFillPrice =
      filledQuantity.gt(0) && order.quoteFilled
        ? fromX18(order.quoteFilled).dividedBy(filledQuantity)
        : undefined;
    const status: OrderStatus = filledQuantity.eq(0)
      ? "UNKNOWN"
      : filledQuantity.gte(amount.abs())
        ? "FILLED"
        : "PARTIALLY_FILLED";
    const digest = order.digest;
    const clientOrderId = this.orderIds.resolveClientOrderId({ digest }) ?? digest;
    return {
      accountId: order.subaccount,
      clientOrderId,
      clientOrderNum: this.orderIds.resolveClientOrderNumByDigest(digest) ?? undefined,
      exchangeOrderId: digest,
      status,
      exchangeStatus: status,
      side: amount.gte(0) ? "BUY" : "SELL",
      price: toDecimal(order.price),
      quantity: amount.abs(),
      filledQuantity: filledQuantity.abs(),
      avgFillPrice,
      updatedAt: order.recvTimeSeconds * 1000,
    };
  }

  private readClientOrderNum(payload: unknown): number | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    if (!("id" in payload)) {
      return undefined;
    }
    const idValue = (payload as { id?: unknown }).id;
    if (typeof idValue === "number" && Number.isFinite(idValue)) {
      return idValue;
    }
    if (typeof idValue === "string") {
      const parsed = Number(idValue);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }
}

function mapOrderUpdateStatus(
  reason: EngineServerSubscriptionOrderUpdateEvent["reason"]
): OrderStatus {
  switch (reason) {
    case "placed":
      return "ACKED";
    case "filled":
      return "FILLED";
    case "cancelled":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}
