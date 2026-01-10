import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { NotificationPayload } from "./notification-service";

/**
 * Bark 通知发送器，负责将消息推送到指定设备。
 */
export class BarkNotifier {
  private readonly server: string;
  private readonly keys: string[];

  constructor(server: string, keys: string[]) {
    this.server = server.replace(/\/+$/, "");
    this.keys = keys;
  }

  /**
   * 发送通知，逐个 key 推送，失败会抛出异常。
   */
  public async notify(payload: NotificationPayload): Promise<void> {
    for (const key of this.keys) {
      const url = this.buildUrl(key, payload.title, payload.body);
      await this.request(url);
    }
  }

  /**
   * 构建 Bark 请求 URL。
   */
  private buildUrl(key: string, title: string, body: string): string {
    const safeTitle = encodeURIComponent(title);
    const safeBody = encodeURIComponent(body);
    return `${this.server}/${key}/${safeTitle}/${safeBody}`;
  }

  /**
   * 发送 HTTP 请求并检查返回状态。
   */
  private request(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const client = target.protocol === "http:" ? http : https;
      const req = client.request(target, { method: "GET" }, (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        if (status >= 200 && status < 300) {
          resolve();
          return;
        }
        reject(new Error(`Bark 通知失败: ${status}`));
      });
      req.on("error", reject);
      req.end();
    });
  }
}
