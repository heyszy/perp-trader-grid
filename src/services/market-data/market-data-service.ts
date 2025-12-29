import type { Unsubscribe } from "../../core/exchange/adapter";
import type { ExchangeQuote } from "../../core/exchange/models";

/**
 * 行情监听器类型，直接复用统一行情结构。
 */
export type QuoteListener = (quote: ExchangeQuote) => void;

/**
 * 行情来源描述，屏蔽不同交易所的订阅细节。
 */
export interface MarketDataSource {
  /** 交易所标识 */
  exchange: string;
  /** 订阅入口，返回取消函数 */
  subscribe: (listener: QuoteListener) => Unsubscribe;
}

/**
 * 行情快照，记录触发更新的来源与各交易所最新行情。
 */
export interface MarketDataSnapshot {
  source: ExchangeQuote;
  latest: Record<string, ExchangeQuote>;
}

/**
 * 行情订阅配置，支持按交易所过滤。
 */
export interface MarketDataSubscription {
  exchanges: string[];
  listener: (snapshot: MarketDataSnapshot) => void;
}

/**
 * 行情聚合服务，负责汇总多交易所行情并分发给订阅者。
 */
export class MarketDataService {
  private readonly sources: MarketDataSource[];
  private readonly subscriptions = new Map<number, MarketDataSubscription>();
  private readonly latestQuotes: Record<string, ExchangeQuote> = {};
  private readonly unsubscribes: Unsubscribe[] = [];
  private subscriptionId = 0;
  private started = false;

  constructor(sources: MarketDataSource[]) {
    this.sources = sources;
  }

  /**
   * 启动行情订阅，确保仅启动一次。
   */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const source of this.sources) {
      const unsubscribe = source.subscribe((quote) => this.handleQuote(quote));
      this.unsubscribes.push(unsubscribe);
    }
  }

  /**
   * 停止行情订阅并清空资源。
   */
  public stop(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes.length = 0;
    this.started = false;
  }

  /**
   * 订阅行情变化，返回取消订阅函数。
   */
  public subscribe(
    exchanges: string[],
    listener: (snapshot: MarketDataSnapshot) => void
  ): Unsubscribe {
    const id = this.subscriptionId++;
    this.subscriptions.set(id, { exchanges, listener });
    return () => {
      this.subscriptions.delete(id);
    };
  }

  /**
   * 获取指定交易所的最新行情。
   */
  public getLatestQuote(exchange: string): ExchangeQuote | null {
    return this.latestQuotes[exchange] ?? null;
  }

  /**
   * 获取最近一次行情快照（按更新时间取最新来源）。
   */
  public getLatestSnapshot(): MarketDataSnapshot | null {
    const exchanges = Object.keys(this.latestQuotes);
    if (exchanges.length === 0) {
      return null;
    }
    const latestExchange = exchanges.reduce((acc, current) => {
      const accTs = this.latestQuotes[acc]?.ts ?? 0;
      const currentTs = this.latestQuotes[current]?.ts ?? 0;
      return currentTs > accTs ? current : acc;
    });
    const source = this.latestQuotes[latestExchange];
    if (!source) {
      return null;
    }
    return {
      source,
      latest: { ...this.latestQuotes },
    };
  }

  private handleQuote(quote: ExchangeQuote): void {
    this.latestQuotes[quote.exchange] = quote;
    const snapshot: MarketDataSnapshot = {
      source: quote,
      latest: { ...this.latestQuotes },
    };
    for (const subscription of this.subscriptions.values()) {
      if (subscription.exchanges.length > 0 && !subscription.exchanges.includes(quote.exchange)) {
        continue;
      }
      subscription.listener(snapshot);
    }
  }
}
