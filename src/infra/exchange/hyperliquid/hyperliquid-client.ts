import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { HyperliquidConfig } from "../../config/schema";

/**
 * Hyperliquid 客户端集合，统一管理 HTTP 与 WS 传输层。
 */
export interface HyperliquidClients {
  infoClient: InfoClient;
  exchangeClient: ExchangeClient;
  subscriptionClient: SubscriptionClient;
  httpTransport: HttpTransport;
  wsTransport: WebSocketTransport;
  accountAddress: `0x${string}`;
}

/**
 * 创建 Hyperliquid 客户端与传输层实例。
 */
export function createHyperliquidClients(config: HyperliquidConfig): HyperliquidClients {
  const isTestnet = config.network === "testnet";
  const httpTransport = new HttpTransport({ isTestnet });
  const wsTransport = new WebSocketTransport({
    isTestnet,
    resubscribe: true,
  });
  const wallet = privateKeyToAccount(config.privateKey as `0x${string}`);
  return {
    infoClient: new InfoClient({ transport: httpTransport }),
    exchangeClient: new ExchangeClient({
      wallet,
      transport: httpTransport,
      sequentialRequests: true,
    }),
    subscriptionClient: new SubscriptionClient({ transport: wsTransport }),
    httpTransport,
    wsTransport,
    accountAddress: wallet.address,
  };
}
