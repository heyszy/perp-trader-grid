import { createNadoClient, type NadoClient } from "@nadohq/client";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ink } from "viem/chains";
import type { NadoConfig } from "../../config/schema";

export interface NadoClients {
  client: NadoClient;
}

/**
 * 构建 Nado SDK 所需的 viem 客户端与签名账户。
 */
export function createNadoClients(config: NadoConfig): NadoClients {
  const privateKey = normalizePrivateKey(config.privateKey);
  const account = privateKeyToAccount(privateKey);
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({
    chain: ink,
    transport,
  });
  const walletClient = createWalletClient({
    chain: ink,
    transport,
    account,
  });
  type NadoClientInit = Parameters<typeof createNadoClient>[1];
  // pnpm 会生成多份 viem 类型，显式对齐到 SDK 期望的类型定义。
  const client = createNadoClient("inkMainnet", {
    publicClient: publicClient as NadoClientInit["publicClient"],
    walletClient: walletClient as NadoClientInit["walletClient"],
  });
  return {
    client,
  };
}

/**
 * 规范化私钥格式，确保以 0x 开头。
 */
function normalizePrivateKey(value: string): `0x${string}` {
  const trimmed = value.trim();
  if (trimmed.startsWith("0x")) {
    return trimmed as `0x${string}`;
  }
  return `0x${trimmed}` as `0x${string}`;
}
