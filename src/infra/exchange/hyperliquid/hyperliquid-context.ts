import type { InfoClient } from "@nktkas/hyperliquid";
import type { SymbolConverter } from "@nktkas/hyperliquid/utils";
import type { MarketTradingConfig } from "../../../core/exchange/models";
import { Decimal } from "../../../shared/number";
import { hyperliquidSymbolMapper } from "./hyperliquid-symbol-mapper";

export interface HyperliquidMarketContext {
  exchangeSymbol: string;
  assetId: number;
  szDecimals: number;
  tradingConfig: MarketTradingConfig;
}

/**
 * 拉取 Hyperliquid 市场与费率配置。
 */
export async function loadHyperliquidMarketContext(params: {
  infoClient: InfoClient;
  symbol: string;
  userAddress: string;
  symbolConverter: SymbolConverter;
  dex?: string;
}): Promise<HyperliquidMarketContext> {
  const exchangeSymbol = hyperliquidSymbolMapper.toExchangeSymbol(params.symbol, params.dex);
  const assetId = params.symbolConverter.getAssetId(exchangeSymbol);
  const szDecimals = params.symbolConverter.getSzDecimals(exchangeSymbol);
  if (assetId === undefined || szDecimals === undefined) {
    throw new Error(`未找到 Hyperliquid 交易对: ${exchangeSymbol}`);
  }
  const fees = await params.infoClient.userFees({ user: params.userAddress });
  const maxPriceDecimals = Math.max(6 - szDecimals, 0);
  const minPriceChange = Decimal(1).div(Decimal(10).pow(maxPriceDecimals));
  const minOrderSizeChange = Decimal(1).div(Decimal(10).pow(szDecimals));
  return {
    exchangeSymbol,
    assetId,
    szDecimals,
    tradingConfig: {
      minPriceChange,
      minOrderSizeChange,
      makerFee: Decimal(fees.userAddRate),
      takerFee: Decimal(fees.userCrossRate),
    },
  };
}
