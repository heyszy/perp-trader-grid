import type { ExchangeSymbolMapper } from "../../../core/exchange/symbol-mapper";
import { normalizeSymbolInput } from "../../../core/exchange/symbol-mapper";

/**
 * Nado 交易对映射器：统一固定为 {BASE}-PERP 形式。
 */
const toExchangeSymbol = (symbol: string): string => {
  const normalized = normalizeSymbolInput(symbol);
  const [base] = normalized.split("-");
  return `${base ?? normalized}-PERP`;
};

const toCanonicalSymbol = (exchangeSymbol: string): string => {
  const normalized = normalizeSymbolInput(exchangeSymbol);
  const [base] = normalized.split("-");
  return base ?? normalized;
};

const isSameMarket = (symbol: string, exchangeSymbol: string): boolean => {
  return toExchangeSymbol(symbol) === normalizeSymbolInput(exchangeSymbol);
};

export const nadoSymbolMapper: ExchangeSymbolMapper = {
  toExchangeSymbol,
  toCanonicalSymbol,
  isSameMarket,
};
