import type { Decimal } from "../../shared/number";
import type { GridSpacingMode } from "../../core/grid/types";

/**
 * 支持的交易所名称。
 * 当前已接入 extended，nado 配置预留用于后续对接。
 */
export type ExchangeName = "extended" | "nado";

/**
 * 网格配置，包含策略与风控所需的全部参数。
 */
export interface GridConfig {
  /** 策略 ID，用于区分不同实例的订单 */
  strategyId: string;
  /** 交易对标识，例如 BTC */
  symbol: string;
  /** 单边档位数量 */
  levels: number;
  /** 间距模式：绝对价差或几何百分比 */
  spacingMode: GridSpacingMode;
  /** 绝对价差 */
  spacing?: Decimal;
  /** 几何百分比间距 */
  spacingPercent?: Decimal;
  /** 每档下单数量 */
  quantity: Decimal;
  /** 是否使用 post-only */
  postOnly: boolean;
  /** 撤单超时（毫秒） */
  cancelTimeoutMs: number;
  /** 最大持仓绝对值 */
  maxPosition: Decimal;
  /** 最大挂单数量 */
  maxOpenOrders: number;
}

/**
 * Extended 账户与网络配置。
 */
export interface ExtendedConfig {
  apiKey: string;
  l2PrivateKey: string;
  network: "mainnet" | "testnet";
}

/**
 * Nado 账户与网络配置。
 */
export interface NadoConfig {
  /** INK 主网 RPC 地址，用于构建 viem 客户端 */
  rpcUrl: string;
  /** 钱包私钥，用于签名订单 */
  privateKey: string;
  /** 需要订阅与交易的子账户名称列表 */
  subaccountNames: string[];
}

/**
 * 交易所配置。
 */
export interface ExchangeConfig {
  name: ExchangeName;
  extended?: ExtendedConfig;
  nado?: NadoConfig;
}

/**
 * 通知配置。
 */
export interface NotificationConfig {
  barkServer?: string;
  barkKeys?: string[];
}

/**
 * 数据库配置。
 */
export interface DbConfig {
  /** SQLite 文件路径 */
  path: string;
}

/**
 * 调试配置。
 */
export interface DebugConfig {
  /** 是否输出行情调试日志 */
  marketLog: boolean;
}

/**
 * 应用总配置。
 */
export interface AppConfig {
  grid: GridConfig;
  exchange: ExchangeConfig;
  notification: NotificationConfig;
  db: DbConfig;
  debug: DebugConfig;
}
