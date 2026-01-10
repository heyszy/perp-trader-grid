/**
 * Hyperliquid 交易对映射器，默认采用币种大写。
 */
export const hyperliquidSymbolMapper = {
  toExchangeSymbol(symbol: string, dex?: string): string {
    const trimmed = symbol.trim();
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      const rawDex = trimmed.slice(0, colonIndex);
      const rawAsset = trimmed.slice(colonIndex + 1);
      // Builder DEX 需要 dex:ASSET 形式，dex 使用小写，资产使用大写。
      return `${rawDex.trim().toLowerCase()}:${rawAsset.trim().toUpperCase()}`;
    }
    const normalizedAsset = trimmed.toUpperCase();
    if (!dex) {
      return normalizedAsset;
    }
    return `${dex.trim().toLowerCase()}:${normalizedAsset}`;
  },
  isSameMarket(symbol: string, exchangeSymbol: string, dex?: string): boolean {
    return this.toExchangeSymbol(symbol, dex) === exchangeSymbol;
  },
};
