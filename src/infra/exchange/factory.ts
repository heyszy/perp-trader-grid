import type { GridExchangeAdapter } from "../../core/exchange/adapter";
import type { AppConfig } from "../config/schema";
import { ExtendedGridExchangeAdapter } from "./extended/extended-adapter";
import { NadoGridExchangeAdapter } from "./nado/nado-adapter";

/**
 * 交易所适配器工厂，按配置创建对应的实现。
 */
export function createExchangeAdapter(config: AppConfig): GridExchangeAdapter {
  // 目前已接入 Extended 与 Nado，新增交易所在此分支扩展即可。
  if (config.exchange.name === "extended") {
    const extendedConfig = config.exchange.extended;
    if (!extendedConfig) {
      throw new Error("未提供 Extended 交易所配置");
    }
    // symbol 由配置统一传入，适配器内部负责市场名称解析。
    return new ExtendedGridExchangeAdapter(extendedConfig, config.grid.symbol);
  }
  if (config.exchange.name === "nado") {
    const nadoConfig = config.exchange.nado;
    if (!nadoConfig) {
      throw new Error("未提供 Nado 交易所配置");
    }
    return new NadoGridExchangeAdapter(nadoConfig, config.grid.symbol);
  }
  throw new Error(`暂不支持交易所: ${config.exchange.name}`);
}
