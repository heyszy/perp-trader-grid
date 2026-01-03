import type { EngineSymbol, NadoClient } from "@nadohq/client";
import { ProductEngineType } from "@nadohq/client";
import type { MarketTradingConfig } from "../../../core/exchange/models";
import { Decimal } from "../../../shared/number";
import { nadoSymbolMapper } from "./nado-symbol-mapper";
import { fromX18, toDecimal } from "./nado-utils";

export interface NadoMarketContext {
  exchangeSymbol: string;
  productId: number;
  tradingConfig: MarketTradingConfig;
  symbolInfo: EngineSymbol;
}

/**
 * 加载 Nado 市场元信息，用于下单步长与费率。
 */
export async function loadNadoMarketContext(
  client: NadoClient,
  symbol: string
): Promise<NadoMarketContext> {
  const exchangeSymbol = nadoSymbolMapper.toExchangeSymbol(symbol);
  const symbols = await client.context.engineClient.getSymbols({
    productType: ProductEngineType.PERP,
  });
  const symbolInfo = symbols.symbols[exchangeSymbol];
  if (!symbolInfo) {
    throw new Error(`未找到 Nado 交易对: ${exchangeSymbol}`);
  }
  if (symbolInfo.type !== ProductEngineType.PERP) {
    console.warn("Nado 交易对类型非 PERP，需确认配置是否正确", {
      symbol: exchangeSymbol,
      type: symbolInfo.type,
    });
  }
  return {
    exchangeSymbol,
    productId: symbolInfo.productId,
    symbolInfo,
    tradingConfig: {
      minPriceChange: toDecimal(symbolInfo.priceIncrement),
      // sizeIncrement 为 x18 精度，需先换算为实际数量步长
      minOrderSizeChange: fromX18(symbolInfo.sizeIncrement),
      makerFee: toDecimal(symbolInfo.makerFeeRate),
      takerFee: toDecimal(symbolInfo.takerFeeRate),
    },
  };
}

/**
 * 将订单数量对齐到交易所最小步长。
 */
export function roundToStep(value: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) {
    throw new Error("步长必须大于 0");
  }
  return value.dividedBy(step).integerValue(Decimal.ROUND_DOWN).multipliedBy(step);
}
