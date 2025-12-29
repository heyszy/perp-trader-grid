/**
 * 交易对名称映射接口，用于统一处理不同交易所的命名规则。
 */
export interface ExchangeSymbolMapper {
  /** 将用户输入的交易对转为交易所格式 */
  toExchangeSymbol(symbol: string): string;
  /** 将交易所格式转换为统一显示用的交易对 */
  toCanonicalSymbol(exchangeSymbol: string): string;
  /** 判断两个交易对是否指向同一市场 */
  isSameMarket(symbol: string, exchangeSymbol: string): boolean;
}

/**
 * 统一清洗用户输入的交易对字符串。
 */
export function normalizeSymbolInput(symbol: string): string {
  return symbol.trim().toUpperCase();
}
