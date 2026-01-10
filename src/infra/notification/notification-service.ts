import type { NotificationConfig } from "../config/schema";
import { BarkNotifier } from "./bark-notifier";

/**
 * 通知消息体，统一在应用内使用。
 */
export type NotificationPayload = {
  title: string;
  body: string;
};

/**
 * 通知服务，按配置选择不同的通知渠道。
 */
export class NotificationService {
  private readonly barkNotifier?: BarkNotifier;

  constructor(config: NotificationConfig) {
    if (config.barkServer && config.barkKeys && config.barkKeys.length > 0) {
      this.barkNotifier = new BarkNotifier(config.barkServer, config.barkKeys);
    }
  }

  /**
   * 发送通知，未配置渠道时直接忽略。
   */
  public async notify(payload: NotificationPayload): Promise<void> {
    if (!this.barkNotifier) {
      return;
    }
    await this.barkNotifier.notify(payload);
  }
}
