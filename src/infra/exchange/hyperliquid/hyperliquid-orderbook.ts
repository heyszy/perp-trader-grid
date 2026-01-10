import type { SubscriptionClient } from "@nktkas/hyperliquid";
import type { Unsubscribe } from "../../../core/exchange/adapter";
import type { ExchangeQuote } from "../../../core/exchange/models";
import { Decimal } from "../../../shared/number";

/**
 * Hyperliquid 行情订阅器，组合 L2 盘口与 mark 价格输出统一报价。
 */
export class HyperliquidOrderbookStream {
  private readonly subscriptionClient: SubscriptionClient;
  private readonly exchange: string;
  private readonly symbol: string;
  private readonly assetId: number;
  private readonly dex: string;

  constructor(params: {
    subscriptionClient: SubscriptionClient;
    exchange: string;
    symbol: string;
    assetId: number;
    dex?: string;
  }) {
    this.subscriptionClient = params.subscriptionClient;
    this.exchange = params.exchange;
    this.symbol = params.symbol;
    this.assetId = params.assetId;
    this.dex = params.dex ?? "";
  }

  /**
   * 启动订阅并输出标准化行情。
   */
  public async subscribe(onQuote: (quote: ExchangeQuote) => void): Promise<Unsubscribe> {
    let bid: Decimal | null = null;
    let ask: Decimal | null = null;
    let mark: Decimal | null = null;
    let lastTs = 0;

    const emit = (ts: number) => {
      if (!bid || !ask) {
        return;
      }
      const mid = bid.plus(ask).div(2);
      const resolvedMark = mark ?? mid;
      onQuote({
        exchange: this.exchange,
        bid,
        ask,
        mark: resolvedMark,
        ts,
      });
    };

    const l2Sub = await this.subscriptionClient.l2Book({ coin: this.symbol }, (event) => {
      const bestBid = event.levels[0][0];
      const bestAsk = event.levels[1][0];
      if (!bestBid || !bestAsk) {
        return;
      }
      bid = Decimal(bestBid.px);
      ask = Decimal(bestAsk.px);
      lastTs = event.time;
      emit(lastTs);
    });

    const ctxSub = await this.subscriptionClient.assetCtxs({ dex: this.dex }, (event) => {
      const ctx = event.ctxs[this.assetId];
      if (!ctx) {
        return;
      }
      mark = Decimal(ctx.markPx);
      emit(lastTs || Date.now());
    });

    return () => {
      void l2Sub.unsubscribe();
      void ctxSub.unsubscribe();
    };
  }
}
