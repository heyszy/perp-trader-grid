import {
  nowInSeconds,
  packOrderAppendix,
  type EngineOrderParams,
  type OrderExecutionType,
} from "@nadohq/client";
import type { PlaceOrderRequest } from "../../../core/exchange/adapter";
import { toSeconds, toX18 } from "./nado-utils";

/**
 * 将下单请求转换为 Nado 所需的订单参数。
 */
export function buildNadoOrderParams(
  request: PlaceOrderRequest,
  subaccountName: string,
  subaccountOwner: string
): EngineOrderParams {
  const appendix = packOrderAppendix({
    orderExecutionType: resolveExecutionType(request),
    reduceOnly: request.reduceOnly ?? false,
  });
  const signedQty = request.side === "BUY" ? request.quantity : request.quantity.negated();
  return {
    subaccountOwner,
    subaccountName,
    // SDK 在签名时会自动将价格转换为 x18，因此此处保留原始价格。
    price: request.price,
    // SDK 期望 amount 已经是 x18 精度（数量字段不会再次 addDecimals）。
    amount: toX18(signedQty),
    expiration: resolveExpirationSeconds(request.expireTimeMs),
    appendix,
  };
}

/**
 * 计算订单过期时间（秒），未提供时默认 60 秒。
 */
function resolveExpirationSeconds(expireTimeMs?: number): number {
  if (!expireTimeMs) {
    return nowInSeconds() + 60;
  }
  return toSeconds(expireTimeMs);
}

/**
 * 根据下单参数推导 Nado 的执行类型。
 */
function resolveExecutionType(request: PlaceOrderRequest): OrderExecutionType {
  if (request.postOnly) {
    return "post_only";
  }
  if (request.timeInForce === "IOC") {
    return "ioc";
  }
  if (request.timeInForce === "FOK") {
    return "fok";
  }
  return "default";
}

/**
 * 订单编号与 digest 的映射管理器。
 */
export class NadoOrderIdStore {
  private nextOrderNum = 1;
  private readonly clientOrderIdToNum = new Map<string, number>();
  private readonly numToClientOrderId = new Map<number, string>();
  private readonly clientOrderIdToDigest = new Map<string, string>();
  private readonly digestToClientOrderId = new Map<string, string>();
  private readonly digestToOrderNum = new Map<string, number>();
  private readonly clientOrderIdToSubaccount = new Map<string, string>();

  /**
   * 注册 clientOrderId，返回可用于 Nado 的数值订单号。
   */
  public registerClientOrder(clientOrderId: string, subaccountName: string): number {
    const existing = this.clientOrderIdToNum.get(clientOrderId);
    if (existing !== undefined) {
      return existing;
    }
    const orderNum = this.nextOrderNum++;
    this.clientOrderIdToNum.set(clientOrderId, orderNum);
    this.numToClientOrderId.set(orderNum, clientOrderId);
    this.clientOrderIdToSubaccount.set(clientOrderId, subaccountName);
    return orderNum;
  }

  /**
   * 写入 digest 映射，用于后续撤单与对账。
   */
  public recordDigest(clientOrderId: string, digest: string): void {
    this.clientOrderIdToDigest.set(clientOrderId, digest);
    this.digestToClientOrderId.set(digest, clientOrderId);
    const orderNum = this.clientOrderIdToNum.get(clientOrderId);
    if (orderNum !== undefined) {
      this.digestToOrderNum.set(digest, orderNum);
    }
  }

  /**
   * 根据 digest 或数值订单号解析 clientOrderId。
   */
  public resolveClientOrderId(params: { clientOrderNum?: number; digest?: string }): string | null {
    if (params.clientOrderNum !== undefined) {
      return this.numToClientOrderId.get(params.clientOrderNum) ?? null;
    }
    if (params.digest) {
      return this.digestToClientOrderId.get(params.digest) ?? null;
    }
    return null;
  }

  /**
   * 获取 clientOrderId 对应的 digest。
   */
  public resolveDigest(clientOrderId: string): string | null {
    return this.clientOrderIdToDigest.get(clientOrderId) ?? null;
  }

  /**
   * 获取 digest 对应的数值订单号。
   */
  public resolveClientOrderNumByDigest(digest: string): number | null {
    return this.digestToOrderNum.get(digest) ?? null;
  }

  /**
   * 获取 clientOrderId 对应的数值订单号。
   */
  public resolveClientOrderNum(clientOrderId: string): number | null {
    return this.clientOrderIdToNum.get(clientOrderId) ?? null;
  }

  /**
   * 获取 clientOrderId 对应的子账户名称。
   */
  public resolveSubaccountName(clientOrderId: string): string | null {
    return this.clientOrderIdToSubaccount.get(clientOrderId) ?? null;
  }
}
