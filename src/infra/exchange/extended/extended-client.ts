import {
  HttpTransport,
  PrivateClient,
  PublicClient,
  StreamClient,
  WebSocketTransport,
  STARKNET_MAINNET,
  STARKNET_TESTNET,
  StarknetSigner,
  type EndpointConfig,
} from "@shenzheyu/extended";
import type { ExtendedConfig } from "../../config/schema";

export interface ExtendedApiClients {
  endpoint: EndpointConfig;
  publicClient: PublicClient;
  privateClient: PrivateClient;
  streamClient: StreamClient;
  signer: StarknetSigner;
}

/**
 * 创建 Extended SDK 客户端实例，集中管理 transport 与签名器。
 */
export function createExtendedClients(config: ExtendedConfig): ExtendedApiClients {
  const endpoint = config.network === "testnet" ? STARKNET_TESTNET : STARKNET_MAINNET;
  const httpTransport = new HttpTransport({ baseUrl: endpoint.apiBaseUrl });
  const streamTransport = new WebSocketTransport({ baseUrl: endpoint.streamBaseUrl });
  const signer = new StarknetSigner({ privateKey: config.l2PrivateKey });

  const publicClient = new PublicClient({
    endpoint,
    transport: httpTransport,
    apiKey: config.apiKey,
    signer,
  });
  const privateClient = new PrivateClient({
    endpoint,
    transport: httpTransport,
    apiKey: config.apiKey,
    signer,
  });
  const streamClient = new StreamClient({
    endpoint,
    transport: streamTransport,
    apiKey: config.apiKey,
  });

  return {
    endpoint,
    publicClient,
    privateClient,
    streamClient,
    signer,
  };
}
