import type { GridExchangeAdapter, Unsubscribe } from "../../core/exchange/adapter";
import type {
  ExchangeOrder,
  ExchangePosition,
  ExchangeQuote,
  OrderUpdate,
} from "../../core/exchange/models";
import { isTerminalOrderStatus } from "../../core/exchange/order-status";
import { canPlaceByMaxPosition } from "../../core/risk/position-guard";
import { GridState } from "../../core/grid/state";
import { GridStrategy } from "../../core/grid/strategy";
import type { GridLevel, GridOrderState } from "../../core/grid/types";
import type { GridConfig } from "../../infra/config/schema";
import type { OrderRecordInput, OrderRecorder } from "../recorder/order-recorder";
import { Decimal } from "../../shared/number";
import type { MarketDataService } from "../market-data/market-data-service";

/**
 * 网格订单管理器负责将行情快照转化为下单/撤单行为。
 * 当前实现聚焦对称滑动网格的核心流程。
 */
export class GridOrderManager {
  private readonly exchange: GridExchangeAdapter;
  private readonly marketData: MarketDataService;
  private readonly config: GridConfig;
  private readonly recorder?: OrderRecorder;
  private readonly strategy: GridStrategy;
  private readonly state: GridState;
  private readonly orderIdPrefix: string;
  private readonly exchangeSymbol: string;
  private quoteUnsubscribe: Unsubscribe | null = null;
  private accountUnsubscribe: Unsubscribe | null = null;
  private maintenanceInProgress = false;
  private pendingQuote: ExchangeQuote | null = null;
  private pendingFillShiftSteps: number[] = [];
  private processing = false;
  private orderSequence = 0;
  private pendingCancels = new Set<string>();
  private cachedNetPosition: Decimal | null = null;
  // 最近一次订单回报更新时间，用于健康检查
  private lastOrderUpdateAt: number | null = null;
  // 首次仓位快照到达前不触发补单，避免基于未知仓位下单
  private positionSnapshotReady = false;
  private lastPositionUpdateAt: number | null = null;
  private lastPositionRefreshAt: number | null = null;
  // WS 长时间无更新时触发 REST 刷新
  private readonly positionStaleMs = 15000;
  // REST 刷新节流，避免行情高频触发
  private readonly positionRefreshIntervalMs = 2000;
  // mark 跨档确认时间，避免小幅抖动触发平移
  private readonly markShiftConfirmMs = 2000;
  private pendingMarkShiftStartedAt: number | null = null;
  private pendingMarkShiftSign: 1 | -1 | null = null;
  // 定时维护节奏：撤单超时检查与对账修复
  private readonly maintenanceIntervalMs = 1000;
  private readonly reconcileIntervalMs = 5000;
  // 最近一次维护任务执行时间
  private lastMaintenanceAt: number | null = null;
  // 最近一次对账执行时间
  private lastReconcileAt: number | null = null;

  constructor(
    exchange: GridExchangeAdapter,
    marketData: MarketDataService,
    config: GridConfig,
    recorder?: OrderRecorder
  ) {
    this.exchange = exchange;
    this.marketData = marketData;
    this.config = config;
    this.recorder = recorder;
    this.strategy = new GridStrategy({
      mode: config.spacingMode,
      spacing: config.spacing,
      spacingPercent: config.spacingPercent,
      levels: config.levels,
    });
    this.state = new GridState({
      mode: config.spacingMode,
      spacing: config.spacing,
      spacingPercent: config.spacingPercent,
      levels: config.levels,
      quantity: config.quantity,
      strategyId: config.strategyId,
      symbol: config.symbol,
    });
    this.orderIdPrefix = `${config.strategyId}-${config.symbol}-`;
    this.exchangeSymbol = this.exchange.resolveExchangeSymbol(this.config.symbol);
  }

  /**
   * 启动订单管理器：订阅行情与账户更新。
   */
  public async start(): Promise<void> {
    if (this.quoteUnsubscribe || this.accountUnsubscribe) {
      return;
    }
    this.accountUnsubscribe = this.exchange.subscribeAccount({
      onOrderUpdates: (updates) => this.handleOrderUpdates(updates),
      onPositionUpdates: (positions) => this.handlePositionUpdates(positions),
    });
    this.quoteUnsubscribe = this.marketData.subscribe([this.exchange.name], (snapshot) => {
      const quote = snapshot.latest[this.exchange.name] ?? snapshot.source;
      if (quote.exchange !== this.exchange.name) {
        return;
      }
      this.enqueueQuote(quote);
    });
    await this.refreshNetPosition("启动初始化");
  }

  /**
   * 停止订单管理器，释放订阅资源。
   */
  public async stop(): Promise<void> {
    this.quoteUnsubscribe?.();
    this.accountUnsubscribe?.();
    this.quoteUnsubscribe = null;
    this.accountUnsubscribe = null;
    this.pendingQuote = null;
  }

  /**
   * 获取维护调度间隔，供编排层使用。
   */
  public getMaintenanceIntervalMs(): number {
    return this.maintenanceIntervalMs;
  }

  /**
   * 获取对账间隔，供编排层与健康检查使用。
   */
  public getReconcileIntervalMs(): number {
    return this.reconcileIntervalMs;
  }

  /**
   * 获取运行状态快照，用于健康检查与监控。
   */
  public getStatus(): GridOrderManagerStatus {
    return {
      centerPrice: this.state.centerPrice ?? null,
      lastOrderUpdateAt: this.lastOrderUpdateAt,
      lastPositionUpdateAt: this.lastPositionUpdateAt,
      lastMaintenanceAt: this.lastMaintenanceAt,
      lastReconcileAt: this.lastReconcileAt,
    };
  }

  /**
   * 处理账户侧订单更新，仅关注当前策略生成的订单。
   */
  private handleOrderUpdates(updates: OrderUpdate[]): void {
    this.lastOrderUpdateAt = Date.now();
    for (const update of updates) {
      if (!this.isManagedOrder(update.clientOrderId)) {
        continue;
      }
      const existing = this.state.getOrder(update.clientOrderId);
      if (!existing) {
        continue;
      }
      const filledLevelIndex = update.status === "FILLED" ? existing.levelIndex : null;
      const nextOrder: GridOrderState = {
        ...existing,
        status: update.status,
        exchangeOrderId: update.exchangeOrderId ?? existing.exchangeOrderId,
        updatedAt: update.updatedAt,
      };
      this.upsertOrderState(nextOrder, this.buildRecordExtraFromUpdate(update));
      if (filledLevelIndex !== null && filledLevelIndex !== 0) {
        this.enqueueFilledShift(filledLevelIndex);
      }
      if (update.status === "FILLED" || update.status === "PARTIALLY_FILLED") {
        this.invalidatePositionCache();
      }
    }
  }

  /**
   * 处理仓位更新，用于刷新本地净仓位缓存。
   */
  private handlePositionUpdates(positions: ExchangePosition[]): void {
    const now = Date.now();
    const isFirstSnapshot = !this.positionSnapshotReady;
    if (isFirstSnapshot) {
      this.positionSnapshotReady = true;
    }
    const position = positions.find((item) => item.symbol === this.config.symbol);
    if (position) {
      const netPosition = position.side === "LONG" ? position.size : position.size.negated();
      this.cachedNetPosition = netPosition;
      this.lastPositionUpdateAt = now;
      return;
    }
    if (isFirstSnapshot) {
      this.cachedNetPosition = Decimal(0);
      this.lastPositionUpdateAt = now;
    }
  }

  /**
   * 行情更新进入队列，确保下单/撤单串行执行。
   */
  private enqueueQuote(quote: ExchangeQuote): void {
    this.pendingQuote = quote;
    this.drainQueue();
  }

  /**
   * 成交触发的平移请求进入队列。
   */
  private enqueueFilledShift(steps: number): void {
    if (steps === 0) {
      return;
    }
    this.pendingFillShiftSteps.push(steps);
    this.drainQueue();
  }

  /**
   * 串行执行行情与成交触发的平移，避免状态并发修改。
   */
  private drainQueue(): void {
    if (this.processing) {
      return;
    }
    if (this.pendingFillShiftSteps.length > 0) {
      const steps = this.pendingFillShiftSteps.shift();
      if (steps !== undefined) {
        this.processing = true;
        void this.processFilledShift(steps).finally(() => {
          this.processing = false;
          this.drainQueue();
        });
        return;
      }
    }
    if (this.pendingQuote) {
      const next = this.pendingQuote;
      this.pendingQuote = null;
      this.processing = true;
      void this.processQuote(next).finally(() => {
        this.processing = false;
        this.drainQueue();
      });
    }
  }

  /**
   * 执行网格逻辑：初始化中心价、平移或重建，并同步订单。
   */
  private async processQuote(quote: ExchangeQuote): Promise<void> {
    this.state.updateMark(quote.mark, quote.ts);

    if (!this.state.centerPrice) {
      await this.handleFirstQuote(quote);
      return;
    }

    await this.cancelExpiredOrders();

    const steps = this.strategy.calculateShiftSteps(this.state.centerPrice, quote.mark);
    if (steps === 0) {
      this.resetPendingMarkShift();
      await this.syncOrders();
      return;
    }

    if (Math.abs(steps) >= this.config.levels) {
      this.resetPendingMarkShift();
      await this.fullRebuild(quote);
      return;
    }

    if (Math.abs(steps) < 2) {
      this.resetPendingMarkShift();
      await this.syncOrders();
      return;
    }

    if (!this.shouldConfirmMarkShift(steps)) {
      await this.syncOrders();
      return;
    }

    const shiftResult = this.state.shiftCenter(steps);
    await this.cancelOrders(shiftResult.outOfRangeOrders, "mark 确认平移");
    await this.syncOrders();
  }

  /**
   * 成交触发的平移处理，按档位步数移动中心价。
   */
  private async processFilledShift(steps: number): Promise<void> {
    if (!this.state.centerPrice) {
      return;
    }
    if (steps === 0) {
      return;
    }
    this.resetPendingMarkShift();
    const shiftResult = this.state.shiftCenter(steps);
    await this.cancelOrders(shiftResult.outOfRangeOrders, "成交平移");
    await this.syncOrders();
  }

  /**
   * 首次接收行情时，以 mark 价作为中心价并建立网格。
   */
  private async handleFirstQuote(quote: ExchangeQuote): Promise<void> {
    this.state.reset(quote.mark);
    await this.cancelManagedOpenOrders();
    await this.syncOrders();
  }

  /**
   * 全量重建：取消旧订单后以最新 mark 重建网格。
   */
  private async fullRebuild(quote: ExchangeQuote): Promise<void> {
    this.state.reset(quote.mark);
    await this.cancelManagedOpenOrders();
    await this.syncOrders();
  }

  /**
   * 记录并判断 mark 跨档的持续时间，满足确认条件才平移。
   */
  private shouldConfirmMarkShift(steps: number): boolean {
    const sign = steps > 0 ? 1 : -1;
    const now = Date.now();
    if (this.pendingMarkShiftStartedAt === null || this.pendingMarkShiftSign !== sign) {
      this.pendingMarkShiftStartedAt = now;
      this.pendingMarkShiftSign = sign;
      return false;
    }
    if (now - this.pendingMarkShiftStartedAt < this.markShiftConfirmMs) {
      return false;
    }
    this.resetPendingMarkShift();
    return true;
  }

  /**
   * 清理 mark 平移确认状态。
   */
  private resetPendingMarkShift(): void {
    this.pendingMarkShiftStartedAt = null;
    this.pendingMarkShiftSign = null;
  }

  /**
   * 写入订单状态，并同步落库。
   */
  private upsertOrderState(order: GridOrderState, extra?: OrderRecordExtra): void {
    this.state.upsertOrder(order);
    this.recordOrderState(order, extra);
  }

  /**
   * 组合订单记录字段，并异步写入数据库。
   */
  private recordOrderState(order: GridOrderState, extra?: OrderRecordExtra): void {
    if (!this.recorder) {
      return;
    }
    const payload: OrderRecordInput = {
      strategyId: this.config.strategyId,
      exchange: this.exchange.name,
      accountId: extra?.accountId,
      symbol: this.config.symbol,
      exchangeSymbol: this.exchangeSymbol,
      clientOrderId: order.clientOrderId,
      exchangeOrderId: extra?.exchangeOrderId ?? order.exchangeOrderId,
      side: order.side,
      orderType: "LIMIT",
      timeInForce: undefined,
      postOnly: this.config.postOnly,
      reduceOnly: false,
      price: order.price,
      quantity: order.quantity,
      filledQuantity: extra?.filledQuantity,
      avgFillPrice: extra?.avgFillPrice,
      status: order.status,
      exchangeStatus: extra?.exchangeStatus,
      statusReason: extra?.statusReason,
      gridLevelIndex: order.levelIndex,
      placedAt: order.placedAt,
      exchangeUpdatedAt: extra?.exchangeUpdatedAt ?? order.updatedAt,
    };
    void this.recorder.recordOrder(payload).catch((error) => {
      console.warn("订单落库失败", error);
    });
  }

  /**
   * 将订单更新转换为落库补充字段。
   */
  private buildRecordExtraFromUpdate(update: OrderUpdate): OrderRecordExtra {
    return {
      accountId: update.accountId,
      exchangeOrderId: update.exchangeOrderId,
      exchangeStatus: update.exchangeStatus,
      statusReason: update.statusReason,
      filledQuantity: update.filledQuantity,
      avgFillPrice: update.avgFillPrice,
      exchangeUpdatedAt: update.updatedAt,
    };
  }

  /**
   * 将交易所订单快照转换为落库补充字段。
   */
  private buildRecordExtraFromExchange(order: ExchangeOrder): OrderRecordExtra {
    return {
      accountId: order.accountId,
      exchangeOrderId: order.exchangeOrderId,
      exchangeStatus: order.exchangeStatus,
      statusReason: order.statusReason,
      filledQuantity: order.filledQuantity,
      avgFillPrice: order.avgFillPrice,
      exchangeUpdatedAt: order.updatedAt,
    };
  }

  /**
   * 取消指定订单列表，避免重复撤单。
   */
  private async cancelOrders(orders: GridOrderState[], reason: string): Promise<void> {
    for (const order of orders) {
      if (!this.isManagedOrder(order.clientOrderId)) {
        continue;
      }
      if (this.pendingCancels.has(order.clientOrderId)) {
        continue;
      }
      this.pendingCancels.add(order.clientOrderId);
      try {
        await this.exchange.cancelOrderByExternalId(order.clientOrderId);
        this.upsertOrderState({
          ...order,
          status: "CANCELLED",
          updatedAt: Date.now(),
        });
      } catch (error) {
        console.warn(`撤单失败: ${reason}`, error);
        await this.reconcileCancelFailure(order, reason);
      } finally {
        this.pendingCancels.delete(order.clientOrderId);
      }
    }
  }

  /**
   * 取消当前策略已存在的挂单，避免重复挂单。
   */
  private async cancelManagedOpenOrders(): Promise<void> {
    const openOrders = await this.exchange.getOpenOrders(this.config.symbol);
    const targets = openOrders.filter((order) => this.isManagedOrder(order.clientOrderId));
    for (const order of targets) {
      if (this.pendingCancels.has(order.clientOrderId)) {
        continue;
      }
      this.pendingCancels.add(order.clientOrderId);
      const orderState = this.buildOrderStateFromExchange(order);
      try {
        await this.exchange.cancelOrderByExternalId(order.clientOrderId);
        this.upsertOrderState({
          ...orderState,
          status: "CANCELLED",
          updatedAt: Date.now(),
        });
      } catch (error) {
        console.warn("启动前清理挂单失败", error);
        await this.reconcileCancelFailure(orderState, "启动清理");
      } finally {
        this.pendingCancels.delete(order.clientOrderId);
      }
    }
  }

  /**
   * 对齐当前网格档位，补齐缺失订单。
   */
  private async syncOrders(): Promise<void> {
    if (!this.state.centerPrice) {
      return;
    }
    const netPosition = await this.loadNetPosition();
    if (netPosition === null) {
      console.warn("仓位信息不可用，跳过本次补单");
      return;
    }
    const pending = this.countPendingQuantities();
    const levels = this.state.getLevels();
    let activeCount = this.countActiveOrders();
    for (const level of levels) {
      if (!level.targetSide) {
        continue;
      }
      if (this.hasActiveOrderAtLevel(level.index)) {
        continue;
      }
      if (activeCount >= this.config.maxOpenOrders) {
        return;
      }
      if (
        !canPlaceByMaxPosition({
          side: level.targetSide,
          netPosition,
          pendingBuy: pending.buy,
          pendingSell: pending.sell,
          orderQuantity: this.config.quantity,
          maxPosition: this.config.maxPosition,
        })
      ) {
        continue;
      }
      const placedOrder = await this.placeOrderForLevel(level);
      if (!placedOrder || isTerminalOrderStatus(placedOrder.status)) {
        continue;
      }
      if (placedOrder.side === "BUY") {
        pending.buy = pending.buy.plus(placedOrder.quantity);
      } else {
        pending.sell = pending.sell.plus(placedOrder.quantity);
      }
      activeCount += 1;
    }
  }

  /**
   * 判断指定档位是否存在未终态订单。
   */
  private hasActiveOrderAtLevel(levelIndex: number): boolean {
    return this.state
      .getOrders()
      .some((order) => order.levelIndex === levelIndex && !isTerminalOrderStatus(order.status));
  }

  /**
   * 统计当前所有未终态订单数量，用于限制挂单总量。
   */
  private countActiveOrders(): number {
    return this.state.getOrders().filter((order) => !isTerminalOrderStatus(order.status)).length;
  }

  /**
   * 为指定档位创建并提交订单。
   */
  private async placeOrderForLevel(level: GridLevel): Promise<GridOrderState | null> {
    if (!level.targetSide) {
      return null;
    }
    if (this.shouldSkipPostOnlyOrder(level)) {
      return null;
    }
    const clientOrderId = this.nextClientOrderId(level);
    const now = Date.now();
    const pendingOrder: GridOrderState = {
      clientOrderId,
      side: level.targetSide,
      price: level.price,
      quantity: this.config.quantity,
      levelIndex: level.index,
      status: "PENDING_SEND",
      placedAt: now,
      updatedAt: now,
    };
    this.upsertOrderState(pendingOrder);
    try {
      const result = await this.exchange.placeOrder({
        clientOrderId,
        symbol: this.config.symbol,
        side: level.targetSide,
        type: "LIMIT",
        price: level.price,
        quantity: this.config.quantity,
        expireTimeMs: now + this.config.cancelTimeoutMs,
        postOnly: this.config.postOnly,
      });
      const updated: GridOrderState = {
        ...pendingOrder,
        exchangeOrderId: result.exchangeOrderId,
        status: result.status,
        updatedAt: result.updatedAt,
      };
      this.upsertOrderState(updated);
      return updated;
    } catch (error) {
      console.warn("下单失败", error);
      const rejected: GridOrderState = {
        ...pendingOrder,
        status: "REJECTED",
        updatedAt: Date.now(),
      };
      this.upsertOrderState(rejected);
      return rejected;
    }
  }

  /**
   * post-only 保护：避免下单价格穿越盘口而变为吃单。
   */
  private shouldSkipPostOnlyOrder(level: GridLevel): boolean {
    if (!this.config.postOnly) {
      return false;
    }
    const quote = this.marketData.getLatestQuote(this.exchange.name);
    if (!quote) {
      return true;
    }
    if (level.targetSide === "BUY") {
      return level.price.gte(quote.ask);
    }
    return level.price.lte(quote.bid);
  }

  /**
   * 生成客户端订单 ID，确保同一策略内唯一。
   */
  private nextClientOrderId(level: GridLevel): string {
    const sequence = this.orderSequence++;
    return `${this.orderIdPrefix}${level.targetSide}-${level.index}-${sequence}`;
  }

  /**
   * 判断订单是否由当前策略创建。
   */
  private isManagedOrder(clientOrderId: string): boolean {
    return clientOrderId.startsWith(this.orderIdPrefix);
  }

  /**
   * 执行维护任务，避免与行情处理并发冲突。
   */
  public async runMaintenance(): Promise<void> {
    if (this.processing || this.maintenanceInProgress) {
      return;
    }
    if (!this.state.centerPrice) {
      return;
    }
    this.maintenanceInProgress = true;
    this.lastMaintenanceAt = Date.now();
    try {
      await this.cancelExpiredOrders();
      const now = Date.now();
      if (this.lastReconcileAt === null || now - this.lastReconcileAt >= this.reconcileIntervalMs) {
        this.lastReconcileAt = now;
        await this.reconcileActiveOrders();
      }
    } finally {
      this.maintenanceInProgress = false;
    }
  }

  /**
   * 撤单失败后做一次对账，避免漏单导致重复挂单。
   */
  private async reconcileCancelFailure(order: GridOrderState, reason: string): Promise<void> {
    try {
      const latest = await this.exchange.getOrderByClientOrderId(order.clientOrderId);
      if (!latest) {
        this.upsertOrderState({
          ...order,
          status: "UNKNOWN",
          updatedAt: Date.now(),
        });
        return;
      }
      this.upsertOrderState(
        {
          ...order,
          status: latest.status,
          exchangeOrderId: latest.exchangeOrderId ?? order.exchangeOrderId,
          updatedAt: latest.updatedAt,
        },
        this.buildRecordExtraFromExchange(latest)
      );
    } catch (error) {
      console.warn(`撤单对账失败: ${reason}`, error);
    }
  }

  /**
   * 周期性对账：同步 open orders 与未知状态订单。
   */
  private async reconcileActiveOrders(): Promise<void> {
    let openOrders: ExchangeOrder[] = [];
    try {
      openOrders = await this.exchange.getOpenOrders(this.config.symbol);
    } catch (error) {
      console.warn("拉取挂单失败，跳过本次对账", error);
      return;
    }

    const openMap = new Map<string, ExchangeOrder>();
    for (const order of openOrders) {
      if (!this.isManagedOrder(order.clientOrderId)) {
        continue;
      }
      openMap.set(order.clientOrderId, order);
      const existing = this.state.getOrder(order.clientOrderId);
      const next = this.mergeOrderFromExchange(order, existing);
      this.upsertOrderState(next, this.buildRecordExtraFromExchange(order));
    }

    const activeOrders = this.state
      .getOrders()
      .filter((order) => !isTerminalOrderStatus(order.status));

    for (const order of activeOrders) {
      if (!this.isManagedOrder(order.clientOrderId)) {
        continue;
      }
      if (openMap.has(order.clientOrderId)) {
        continue;
      }
      await this.reconcileCancelFailure(order, "周期对账");
    }
  }

  /**
   * 将交易所订单转换为网格订单状态。
   */
  private buildOrderStateFromExchange(order: ExchangeOrder): GridOrderState {
    return this.mergeOrderFromExchange(order, null);
  }

  /**
   * 将交易所订单合并为网格订单状态，保留已有档位与下单时间。
   */
  private mergeOrderFromExchange(
    order: ExchangeOrder,
    existing: GridOrderState | null
  ): GridOrderState {
    const levelIndex = existing?.levelIndex ?? this.parseLevelIndex(order.clientOrderId) ?? 0;
    const placedAt = existing?.placedAt ?? order.updatedAt;
    return {
      clientOrderId: order.clientOrderId,
      exchangeOrderId: order.exchangeOrderId ?? existing?.exchangeOrderId,
      status: order.status,
      side: order.side,
      price: order.price,
      quantity: order.quantity,
      levelIndex,
      placedAt,
      updatedAt: order.updatedAt,
    };
  }

  /**
   * 从 clientOrderId 解析网格档位索引。
   */
  private parseLevelIndex(clientOrderId: string): number | null {
    if (!this.isManagedOrder(clientOrderId)) {
      return null;
    }
    const rest = clientOrderId.slice(this.orderIdPrefix.length);
    const match = rest.match(/^(BUY|SELL)-(-?\\d+)-\\d+$/);
    if (!match) {
      return null;
    }
    const index = Number(match[2]);
    return Number.isFinite(index) ? index : null;
  }

  /**
   * 统计未终态订单的潜在仓位占用。
   */
  private countPendingQuantities(): { buy: Decimal; sell: Decimal } {
    let buy = Decimal(0);
    let sell = Decimal(0);
    for (const order of this.state.getOrders()) {
      if (isTerminalOrderStatus(order.status)) {
        continue;
      }
      if (order.side === "BUY") {
        buy = buy.plus(order.quantity);
      } else {
        sell = sell.plus(order.quantity);
      }
    }
    return { buy, sell };
  }

  /**
   * 获取净仓位（多为正，空为负），WS 优先，必要时回退 REST。
   */
  private async loadNetPosition(): Promise<Decimal | null> {
    const now = Date.now();
    if (
      this.cachedNetPosition !== null &&
      this.lastPositionUpdateAt !== null &&
      now - this.lastPositionUpdateAt < this.positionStaleMs
    ) {
      return this.cachedNetPosition;
    }
    const refreshed = await this.refreshNetPosition("补单前刷新");
    if (refreshed !== null) {
      return refreshed;
    }
    return this.cachedNetPosition;
  }

  /**
   * 使用 REST 刷新仓位，适用于启动或 WS 长时间无更新时。
   */
  private async refreshNetPosition(reason: string): Promise<Decimal | null> {
    const now = Date.now();
    if (
      this.lastPositionRefreshAt !== null &&
      now - this.lastPositionRefreshAt < this.positionRefreshIntervalMs
    ) {
      return this.cachedNetPosition;
    }
    this.lastPositionRefreshAt = now;
    try {
      const netPosition = await this.exchange.getNetPosition(this.config.symbol);
      this.cachedNetPosition = netPosition;
      this.positionSnapshotReady = true;
      this.lastPositionUpdateAt = Date.now();
      return netPosition;
    } catch (error) {
      console.warn(`获取仓位失败: ${reason}`, error);
      return null;
    }
  }

  /**
   * 清空仓位缓存，用于强制刷新。
   */
  private invalidatePositionCache(): void {
    this.cachedNetPosition = null;
    this.lastPositionUpdateAt = null;
  }

  /**
   * 撤单超时处理，仅针对已确认的挂单。
   */
  private async cancelExpiredOrders(): Promise<void> {
    if (!this.state.centerPrice) {
      return;
    }
    const now = Date.now();
    const expiredOrders = this.state
      .getOrders()
      .filter(
        (order) =>
          (order.status === "ACKED" || order.status === "PARTIALLY_FILLED") &&
          now - order.placedAt >= this.config.cancelTimeoutMs
      );
    if (expiredOrders.length === 0) {
      return;
    }
    await this.cancelOrders(expiredOrders, "撤单超时");
  }
}

/**
 * 订单管理器运行状态快照。
 */
export interface GridOrderManagerStatus {
  centerPrice: Decimal | null;
  lastOrderUpdateAt: number | null;
  lastPositionUpdateAt: number | null;
  lastMaintenanceAt: number | null;
  lastReconcileAt: number | null;
}

/**
 * 订单落库所需的补充字段。
 */
type OrderRecordExtra = {
  accountId?: string;
  exchangeOrderId?: string;
  exchangeStatus?: string;
  statusReason?: string;
  filledQuantity?: Decimal;
  avgFillPrice?: Decimal;
  exchangeUpdatedAt?: number;
};
