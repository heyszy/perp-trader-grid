const DEFAULT_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
const MAX_JITTER_MS = 250;

/**
 * 简单的限流守卫：在遇到 429 时进入退避窗口，避免短时间内重复撞限流。
 */
export class RateLimitGuard {
  private blockedUntil = 0;
  private backoffMs = 0;

  /**
   * 若处于退避窗口，等待到允许时间后再继续执行。
   */
  public async wait(): Promise<void> {
    const now = Date.now();
    if (now >= this.blockedUntil) {
      return;
    }
    const sleepMs = this.blockedUntil - now;
    await sleep(sleepMs);
  }

  /**
   * 收到 429 后延长退避窗口，采用指数退避并加入轻微抖动。
   */
  public onRateLimit(retryAfterMs?: number | null): void {
    const nextBackoff = retryAfterMs ?? this.nextBackoffMs();
    const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
    this.backoffMs = nextBackoff;
    this.blockedUntil = Date.now() + nextBackoff + jitter;
  }

  /**
   * 成功请求后重置退避状态，避免持续延长窗口。
   */
  public onSuccess(): void {
    this.backoffMs = 0;
    this.blockedUntil = 0;
  }

  private nextBackoffMs(): number {
    if (this.backoffMs <= 0) {
      return DEFAULT_BACKOFF_MS;
    }
    return Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }
}

/**
 * 判断错误是否为 REST 限流错误。
 */
export function isRateLimitError(error: unknown): boolean {
  return getStatusCode(error) === 429;
}

/**
 * 尝试从错误中读取 Retry-After，并转换为毫秒。
 */
export function extractRetryAfterMs(error: unknown): number | null {
  const headers =
    getHeadersValue(error) ??
    (typeof error === "object" && error && "response" in error
      ? getHeadersValue((error as { response?: unknown }).response)
      : null);

  if (!headers) {
    return null;
  }

  const retryAfter = readHeaderValue(headers, "retry-after");
  if (!retryAfter) {
    return null;
  }

  const retrySeconds = Number(retryAfter);
  if (Number.isFinite(retrySeconds)) {
    return Math.max(0, Math.round(retrySeconds * 1000));
  }

  const retryAt = Date.parse(retryAfter);
  if (Number.isNaN(retryAt)) {
    return null;
  }
  return Math.max(0, retryAt - Date.now());
}

type HeaderSource = Headers | Record<string, string> | Record<string, string[]>;

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  if ("status" in error && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  if ("response" in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === "object" && "status" in response) {
      const status = (response as { status?: unknown }).status;
      if (typeof status === "number") {
        return status;
      }
    }
  }
  return null;
}

function getHeadersValue(payload: unknown): HeaderSource | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if ("headers" in payload) {
    const headers = (payload as { headers?: unknown }).headers;
    if (isHeaderSource(headers)) {
      return headers;
    }
  }
  return null;
}

function isHeaderSource(headers: unknown): headers is HeaderSource {
  if (!headers) {
    return false;
  }
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return true;
  }
  return typeof headers === "object";
}

function readHeaderValue(headers: HeaderSource, name: string): string | null {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  if (!key) {
    return null;
  }
  const value = headers[key];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
