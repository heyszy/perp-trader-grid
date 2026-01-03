import type {
  EngineServerSubscriptionEvent,
  EngineServerSubscriptionEventType,
  EngineServerSubscriptionStreamParamsByType,
  EngineServerSubscriptionStreamParamsType,
  NadoClient,
} from "@nadohq/client";
import type { Unsubscribe } from "../../../core/exchange/adapter";

type WsMessageHandler = (payload: unknown) => void;
type SubscriptionHandler<T extends EngineServerSubscriptionEventType> = (
  event: Extract<EngineServerSubscriptionEvent, { type: T }>
) => void;
type AnySubscriptionHandler = (event: EngineServerSubscriptionEvent) => void;

type WebSocketEventType = "open" | "message" | "close" | "error";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;

const WS_READY_OPEN = 1;

/**
 * 管理单条 WebSocket 连接，负责重连与消息分发。
 */
class NadoWsConnection {
  private readonly url: string;
  private readonly name: string;
  private readonly onOpen: (() => void) | null;
  private ws: WebSocketLike | null = null;
  private connecting: Promise<void> | null = null;
  private readonly handlers = new Set<WsMessageHandler>();
  private readonly pendingMessages: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(url: string, name: string, onOpen?: () => void) {
    this.url = url;
    this.name = name;
    this.onOpen = onOpen ?? null;
  }

  /**
   * 注册消息监听器。
   */
  public addHandler(handler: WsMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * 发送 JSON 消息，必要时自动建立连接。
   */
  public async sendJson(payload: unknown): Promise<void> {
    const message = JSON.stringify(payload);
    if (this.ws && this.ws.readyState === WS_READY_OPEN) {
      this.ws.send(message);
      return;
    }
    this.pendingMessages.push(message);
    await this.ensureOpen();
  }

  /**
   * 主动关闭连接，停止后续自动重连。
   */
  public close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.ws && this.ws.readyState === WS_READY_OPEN) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.openConnection();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async openConnection(): Promise<void> {
    const wsConstructor = getWebSocketConstructor();
    const socket = new wsConstructor(this.url);
    this.ws = socket;
    await new Promise<void>((resolve) => {
      const handleOpen = () => {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
        this.flushPending();
        this.onOpen?.();
        resolve();
      };
      const handleError = (event: unknown) => {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
        console.warn(`${this.name} WebSocket 连接失败`, event);
        resolve();
      };
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
      socket.addEventListener("message", (event) => this.handleMessage(event));
      socket.addEventListener("close", () => this.handleClose());
      socket.addEventListener("error", (event) => this.handleError(event));
    });
  }

  private flushPending(): void {
    if (!this.ws || this.ws.readyState !== WS_READY_OPEN) {
      return;
    }
    for (const message of this.pendingMessages.splice(0, this.pendingMessages.length)) {
      this.ws.send(message);
    }
  }

  private handleMessage(event: unknown): void {
    const payload = parseMessagePayload(event);
    if (payload === null) {
      return;
    }
    for (const handler of this.handlers) {
      handler(payload);
    }
  }

  private handleClose(): void {
    this.ws = null;
    if (this.closed) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureOpen();
    }, 1000);
  }

  private handleError(event: unknown): void {
    console.warn(`${this.name} WebSocket 异常`, event);
  }
}

type SubscriptionEntry = {
  streamType: EngineServerSubscriptionEventType;
  params: EngineServerSubscriptionStreamParamsByType[EngineServerSubscriptionEventType];
  handler: AnySubscriptionHandler;
};

/**
 * Nado WS 管理器，封装 /ws 与 /subscribe 双连接。
 */
export class NadoWsManager {
  private readonly client: NadoClient;
  private readonly executeConnection: NadoWsConnection;
  private readonly subscriptionConnection: NadoWsConnection;
  private readonly subscriptions: SubscriptionEntry[] = [];
  private readonly handlersByType = new Map<
    EngineServerSubscriptionEventType,
    Set<AnySubscriptionHandler>
  >();
  private nextRequestId = 1;

  constructor(params: { client: NadoClient; wsUrl: string; subscriptionUrl: string }) {
    this.client = params.client;
    this.executeConnection = new NadoWsConnection(params.wsUrl, "Nado WS");
    this.subscriptionConnection = new NadoWsConnection(
      params.subscriptionUrl,
      "Nado Subscribe",
      () => this.resubscribeAll()
    );
    this.subscriptionConnection.addHandler((payload) => this.dispatchSubscription(payload));
  }

  /**
   * 发送 execute 消息（当前主要使用 REST，保留接口）。
   */
  public async sendExecute(payload: unknown): Promise<void> {
    await this.executeConnection.sendJson(payload);
  }

  /**
   * 发送 query 消息（当前主要使用 REST，保留接口）。
   */
  public async sendQuery(payload: unknown): Promise<void> {
    await this.executeConnection.sendJson(payload);
  }

  /**
   * 订阅指定流事件，返回取消订阅函数。
   */
  public subscribe<T extends EngineServerSubscriptionEventType>(
    streamType: T,
    params: EngineServerSubscriptionStreamParamsByType[T],
    handler: SubscriptionHandler<T>
  ): Unsubscribe {
    const wrappedHandler: AnySubscriptionHandler = (event) => {
      handler(event as Extract<EngineServerSubscriptionEvent, { type: T }>);
    };
    const entry: SubscriptionEntry = {
      streamType,
      params,
      handler: wrappedHandler,
    };
    this.subscriptions.push(entry);
    this.addHandler(streamType, wrappedHandler);
    void this.sendSubscribe(streamType, params);

    return () => {
      this.removeSubscription(entry);
      void this.sendUnsubscribe(streamType, params);
    };
  }

  /**
   * 主动关闭所有连接。
   */
  public close(): void {
    this.executeConnection.close();
    this.subscriptionConnection.close();
  }

  private addHandler(
    streamType: EngineServerSubscriptionEventType,
    handler: AnySubscriptionHandler
  ): void {
    const existing = this.handlersByType.get(streamType) ?? new Set<AnySubscriptionHandler>();
    existing.add(handler);
    this.handlersByType.set(streamType, existing);
  }

  private removeSubscription(entry: SubscriptionEntry): void {
    const index = this.subscriptions.indexOf(entry);
    if (index >= 0) {
      this.subscriptions.splice(index, 1);
    }
    const handlers = this.handlersByType.get(entry.streamType);
    if (!handlers) {
      return;
    }
    handlers.delete(entry.handler);
    if (handlers.size === 0) {
      this.handlersByType.delete(entry.streamType);
    }
  }

  private dispatchSubscription(payload: unknown): void {
    if (!payload || typeof payload !== "object" || !("type" in payload)) {
      return;
    }
    const eventType = (payload as { type?: unknown }).type;
    if (typeof eventType !== "string") {
      return;
    }
    const handlers = this.handlersByType.get(eventType as EngineServerSubscriptionEventType);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      handler(payload as EngineServerSubscriptionEvent);
    }
  }

  private async sendSubscribe<T extends EngineServerSubscriptionEventType>(
    streamType: T,
    params: EngineServerSubscriptionStreamParamsByType[T]
  ): Promise<void> {
    const request = this.buildSubscriptionMessage(streamType, params, "subscribe");
    await this.subscriptionConnection.sendJson(request);
  }

  private async sendUnsubscribe<T extends EngineServerSubscriptionEventType>(
    streamType: T,
    params: EngineServerSubscriptionStreamParamsByType[T]
  ): Promise<void> {
    const request = this.buildSubscriptionMessage(streamType, params, "unsubscribe");
    await this.subscriptionConnection.sendJson(request);
  }

  private buildSubscriptionMessage<T extends EngineServerSubscriptionEventType>(
    streamType: T,
    params: EngineServerSubscriptionStreamParamsByType[T],
    method: "subscribe" | "unsubscribe"
  ) {
    const streamParams = this.client.ws.subscription.buildSubscriptionParams(
      streamType as EngineServerSubscriptionStreamParamsType,
      params as EngineServerSubscriptionStreamParamsByType[EngineServerSubscriptionStreamParamsType]
    );
    const requestId = this.nextRequestId++;
    return this.client.ws.subscription.buildSubscriptionMessage(requestId, method, streamParams);
  }

  private resubscribeAll(): void {
    for (const entry of this.subscriptions) {
      void this.sendSubscribe(entry.streamType, entry.params);
    }
  }
}

function getWebSocketConstructor(): WebSocketConstructor {
  if (!("WebSocket" in globalThis)) {
    throw new Error("当前运行时不支持 WebSocket");
  }
  return globalThis.WebSocket as unknown as WebSocketConstructor;
}

function parseMessagePayload(event: unknown): unknown | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  if (!("data" in event)) {
    return null;
  }
  const data = (event as { data?: unknown }).data;
  const message =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString()
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer).toString()
          : null;
  if (!message) {
    return null;
  }
  try {
    return JSON.parse(message);
  } catch (error) {
    console.warn("Nado WS 消息解析失败", error);
    return null;
  }
}
