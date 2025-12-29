import type { PrivateClient, PublicClient, schemas } from "@zheyu/extended";

/**
 * 获取当前 API Key 对应的账户信息。
 */
export async function loadAccountInfo(client: PrivateClient): Promise<schemas.AccountDetails> {
  return client.account.getAccount();
}

/**
 * 加载市场元数据，用于步长与签名。
 */
export async function loadMarketInfo(
  client: PublicClient,
  marketName: string
): Promise<schemas.Market> {
  const markets = await client.info.getMarkets({ market: [marketName] });
  const market = markets.find((item) => item.name === marketName);
  if (!market) {
    throw new Error(`未找到市场信息: ${marketName}`);
  }
  return market;
}

/**
 * 加载费率配置，包含 builder 费率。
 */
export async function loadFees(
  client: PrivateClient,
  marketName: string,
  builderId?: number
): Promise<schemas.Fees> {
  const fees = await client.account.getFees({
    market: marketName,
    builderId: builderId ? String(builderId) : undefined,
  });
  const match = fees.find((item) => item.market === marketName);
  if (!match) {
    throw new Error(`未获取到市场 ${marketName} 的费率配置`);
  }
  return match;
}
