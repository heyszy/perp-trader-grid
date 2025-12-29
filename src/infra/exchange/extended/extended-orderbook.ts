import { OrderbookTracker, type StreamClient, type Subscription } from "@shenzheyu/extended";
import type { schemas } from "@shenzheyu/extended";
import { Decimal } from "../../../shared/number";
import type { ExchangeQuote } from "../../../core/exchange/models";
import type { Unsubscribe } from "../../../core/exchange/adapter";

type QuoteListener = (quote: ExchangeQuote) => void;

/**
 * 订单簿与 mark 价格聚合器，负责输出带 mark 的行情快照。
 */
export class ExtendedOrderbookStream {
  private readonly streamClient: StreamClient;
  private readonly market: string;
  private readonly exchangeName: string;
  private readonly tracker: OrderbookTracker;
  private lastBook: {
    bid: Decimal;
    ask: Decimal;
    ts: number;
  } | null = null;
  private lastMark: Decimal | null = null;
  private lastMarkTs: number | null = null;
  private orderbookSub: Subscription | null = null;
  private markSub: Subscription | null = null;
  private orderbookResubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private markResubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;

  constructor(streamClient: StreamClient, market: string, exchangeName: string) {
    this.streamClient = streamClient;
    this.market = market;
    this.exchangeName = exchangeName;
    this.tracker = new OrderbookTracker({ market, depth: 1 });
  }

  /**
   * 启动订单簿与 mark 订阅，并返回取消函数。
   */
  public subscribe(onQuote: QuoteListener): Unsubscribe {
    this.active = true;
    void this.startOrderbook(onQuote);
    void this.startMark(onQuote);
    return () => {
      this.active = false;
      this.clearTimers();
      void this.unsubscribeOrderbook();
      void this.unsubscribeMark();
    };
  }

  private async startOrderbook(onQuote: QuoteListener): Promise<void> {
    if (!this.active) {
      return;
    }
    await this.unsubscribeOrderbook();
    this.tracker.reset();
    try {
      this.orderbookSub = await this.streamClient.stream.orderbooks(
        this.market,
        (message) => this.handleOrderbook(message, onQuote),
        1
      );
      this.orderbookSub.failureSignal.addEventListener("abort", () => {
        this.scheduleOrderbookResubscribe(onQuote, "订单簿订阅中断");
      });
    } catch (error) {
      console.warn("Extended 订单簿订阅失败，准备重试", error);
      this.scheduleOrderbookResubscribe(onQuote, "订单簿订阅失败");
    }
  }

  private async startMark(onQuote: QuoteListener): Promise<void> {
    if (!this.active) {
      return;
    }
    await this.unsubscribeMark();
    try {
      this.markSub = await this.streamClient.stream.markPrices(this.market, (message) =>
        this.handleMark(message, onQuote)
      );
      this.markSub.failureSignal.addEventListener("abort", () => {
        this.scheduleMarkResubscribe(onQuote, "mark 订阅中断");
      });
    } catch (error) {
      console.warn("Extended mark 订阅失败，准备重试", error);
      this.scheduleMarkResubscribe(onQuote, "mark 订阅失败");
    }
  }

  private async unsubscribeOrderbook(): Promise<void> {
    if (!this.orderbookSub) {
      return;
    }
    try {
      await this.orderbookSub.unsubscribe();
    } catch (error) {
      console.warn("取消订单簿订阅失败", error);
    } finally {
      this.orderbookSub = null;
    }
  }

  private async unsubscribeMark(): Promise<void> {
    if (!this.markSub) {
      return;
    }
    try {
      await this.markSub.unsubscribe();
    } catch (error) {
      console.warn("取消 mark 订阅失败", error);
    } finally {
      this.markSub = null;
    }
  }

  private handleOrderbook(message: schemas.OrderbookMessage, onQuote: QuoteListener): void {
    if (!this.active) {
      return;
    }
    try {
      const state = this.tracker.apply(message);
      const bestBid = state.bids[0];
      const bestAsk = state.asks[0];
      if (!bestBid || !bestAsk) {
        return;
      }
      this.lastBook = {
        bid: Decimal(bestBid.price),
        ask: Decimal(bestAsk.price),
        ts: state.ts,
      };
      this.emitQuoteIfReady(onQuote);
    } catch (error) {
      console.warn("订单簿序列异常，准备重订阅", error);
      this.scheduleOrderbookResubscribe(onQuote, "订单簿序列异常");
    }
  }

  private handleMark(message: schemas.MarkPriceMessage, onQuote: QuoteListener): void {
    if (!this.active) {
      return;
    }
    this.lastMark = Decimal(message.data.p);
    this.lastMarkTs = message.data.ts;
    this.emitQuoteIfReady(onQuote);
  }

  private emitQuoteIfReady(onQuote: QuoteListener): void {
    if (!this.lastBook || !this.lastMark) {
      return;
    }
    const ts = Math.max(this.lastBook.ts, this.lastMarkTs ?? this.lastBook.ts);
    onQuote({
      exchange: this.exchangeName,
      bid: this.lastBook.bid,
      ask: this.lastBook.ask,
      mark: this.lastMark,
      ts,
    });
  }

  private scheduleOrderbookResubscribe(onQuote: QuoteListener, reason: string): void {
    if (!this.active || this.orderbookResubscribeTimer) {
      return;
    }
    console.warn(`订单簿即将重订阅: ${reason}`);
    this.orderbookResubscribeTimer = setTimeout(() => {
      this.orderbookResubscribeTimer = null;
      void this.startOrderbook(onQuote);
    }, 1000);
  }

  private scheduleMarkResubscribe(onQuote: QuoteListener, reason: string): void {
    if (!this.active || this.markResubscribeTimer) {
      return;
    }
    console.warn(`mark 即将重订阅: ${reason}`);
    this.markResubscribeTimer = setTimeout(() => {
      this.markResubscribeTimer = null;
      void this.startMark(onQuote);
    }, 1000);
  }

  private clearTimers(): void {
    if (this.orderbookResubscribeTimer) {
      clearTimeout(this.orderbookResubscribeTimer);
      this.orderbookResubscribeTimer = null;
    }
    if (this.markResubscribeTimer) {
      clearTimeout(this.markResubscribeTimer);
      this.markResubscribeTimer = null;
    }
  }
}
