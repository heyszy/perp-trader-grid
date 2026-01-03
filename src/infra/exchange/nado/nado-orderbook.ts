import type { EngineServerSubscriptionBestBidOfferEvent } from "@nadohq/client";
import type { ExchangeQuote } from "../../../core/exchange/models";
import type { Unsubscribe } from "../../../core/exchange/adapter";
import { fromX18, normalizeTimestampMs } from "./nado-utils";
import type { NadoWsManager } from "./nado-ws";

type QuoteListener = (quote: ExchangeQuote) => void;

/**
 * Nado best bid/offer 订阅封装。
 */
export class NadoOrderbookStream {
  private readonly ws: NadoWsManager;
  private readonly productId: number;
  private readonly exchangeName: string;

  constructor(ws: NadoWsManager, productId: number, exchangeName: string) {
    this.ws = ws;
    this.productId = productId;
    this.exchangeName = exchangeName;
  }

  /**
   * 订阅 best_bid_offer，并输出统一行情结构。
   */
  public subscribe(onQuote: QuoteListener): Unsubscribe {
    return this.ws.subscribe("best_bid_offer", { product_id: this.productId }, (event) =>
      this.handleBestBidOffer(event, onQuote)
    );
  }

  private handleBestBidOffer(
    event: EngineServerSubscriptionBestBidOfferEvent,
    onQuote: QuoteListener
  ): void {
    const bid = fromX18(event.bid_price);
    const ask = fromX18(event.ask_price);
    if (bid.lte(0) || ask.lte(0)) {
      return;
    }
    const mark = bid.plus(ask).dividedBy(2);
    const ts = normalizeTimestampMs(event.timestamp);
    onQuote({
      exchange: this.exchangeName,
      bid,
      ask,
      mark,
      ts,
    });
  }
}
