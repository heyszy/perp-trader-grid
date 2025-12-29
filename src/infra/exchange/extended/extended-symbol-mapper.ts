import type { ExchangeSymbolMapper } from "../../../core/exchange/symbol-mapper";
import { normalizeSymbolInput } from "../../../core/exchange/symbol-mapper";

const DEFAULT_QUOTE = "USD";

const toExchangeSymbol = (symbol: string): string => {
  const normalized = normalizeSymbolInput(symbol);
  if (normalized.includes("-")) {
    return normalized;
  }
  return `${normalized}-${DEFAULT_QUOTE}`;
};

const toCanonicalSymbol = (exchangeSymbol: string): string => {
  const normalized = normalizeSymbolInput(exchangeSymbol);
  const [base] = normalized.split("-");
  return base ?? normalized;
};

const isSameMarket = (symbol: string, exchangeSymbol: string): boolean => {
  return toExchangeSymbol(symbol) === normalizeSymbolInput(exchangeSymbol);
};

/**
 * Extended 交易所交易对映射器。
 */
export const extendedSymbolMapper: ExchangeSymbolMapper = {
  toExchangeSymbol,
  toCanonicalSymbol,
  isSameMarket,
};
