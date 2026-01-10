import { buildCloid } from "./hyperliquid-utils";

/**
 * Hyperliquid cloid 与 clientOrderId 的映射缓存。
 */
export class HyperliquidOrderIdStore {
  private readonly clientToCloid = new Map<string, `0x${string}`>();
  private readonly cloidToClient = new Map<string, string>();

  /**
   * 获取或生成 cloid，并写入映射。
   */
  public ensureCloid(clientOrderId: string): `0x${string}` {
    const existing = this.clientToCloid.get(clientOrderId);
    if (existing) {
      return existing;
    }
    const cloid = buildCloid(clientOrderId);
    this.clientToCloid.set(clientOrderId, cloid);
    this.cloidToClient.set(cloid, clientOrderId);
    return cloid;
  }

  /**
   * 根据 cloid 解析 clientOrderId。
   */
  public resolveClientOrderId(cloid?: string | null): string | null {
    if (!cloid) {
      return null;
    }
    return this.cloidToClient.get(cloid) ?? null;
  }
}
