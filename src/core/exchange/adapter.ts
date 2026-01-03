import type { Decimal } from "../../shared/number";
import type {
  ExchangeOrder,
  ExchangePosition,
  ExchangeQuote,
  MarketTradingConfig,
  OrderSide,
  OrderStatus,
  OrderUpdate,
} from "./models";

/**
 * 取消订阅函数。
 */
export type Unsubscribe = () => void;

/**
 * 交易所能力描述，用于运行时选择兼容逻辑。
 */
export interface ExchangeCapabilities {
  supportsMassCancel: boolean;
  supportsPostOnly: boolean;
  supportsOrderbook: boolean;
  supportsMarkPrice: boolean;
}

/**
 * 订单簿订阅参数。
 */
export interface OrderbookSubscribeParams {
  symbol: string;
  onQuote: (quote: ExchangeQuote) => void;
}

/**
 * 账户事件订阅参数。
 */
export interface AccountSubscribeParams {
  onOrderUpdates: (updates: OrderUpdate[]) => void;
  onPositionUpdates?: (positions: ExchangePosition[]) => void;
}

/**
 * 历史订单查询参数。
 */
export interface OrderHistoryQuery {
  symbol: string;
  sinceMs: number;
}

/**
 * 下单请求，统一由适配器负责转换为交易所格式。
 */
export interface PlaceOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: "LIMIT" | "MARKET";
  price: Decimal;
  quantity: Decimal;
  timeInForce?: "GTT" | "IOC" | "FOK" | "GTC";
  expireTimeMs?: number;
  postOnly?: boolean;
  reduceOnly?: boolean;
}

/**
 * 下单结果，包含交易所返回的关键字段。
 */
export interface PlaceOrderResult {
  status: OrderStatus;
  /** 交易所账户标识（如子账户名），便于落库 */
  accountId?: string;
  /** 客户端自定义的数值订单号，用于事件回传关联 */
  clientOrderNum?: number;
  exchangeOrderId?: string;
  statusReason?: string;
  errorCode?: string;
  errorMessage?: string;
  updatedAt: number;
}

/**
 * 网格交易所适配器接口，屏蔽不同交易所差异。
 */
export interface GridExchangeAdapter {
  readonly name: string;
  readonly capabilities: ExchangeCapabilities;
  /** 解析交易所格式的交易对 */
  resolveExchangeSymbol(symbol: string): string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribeOrderbook(params: OrderbookSubscribeParams): Unsubscribe;
  subscribeAccount(params: AccountSubscribeParams): Unsubscribe;
  getMarketConfig(symbol: string): Promise<MarketTradingConfig>;
  getNetPosition(symbol: string): Promise<Decimal>;
  getOrderByClientOrderId(clientOrderId: string): Promise<ExchangeOrder | null>;
  getOpenOrders(symbol: string): Promise<ExchangeOrder[]>;
  getOrdersHistory(query: OrderHistoryQuery): Promise<ExchangeOrder[]>;
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>;
  cancelOrderByExternalId(externalId: string): Promise<void>;
  massCancel(symbol: string): Promise<void>;
}
