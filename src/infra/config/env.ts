import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import type { GridSpacingMode } from "../../core/grid/types";
import { Decimal } from "../../shared/number";
import type {
  AppConfig,
  DbConfig,
  DebugConfig,
  ExchangeConfig,
  GridConfig,
  NotificationConfig,
} from "./schema";

let loaded = false;

/**
 * 加载 .env 文件（若存在），用于本地开发环境。
 * 生产环境可直接通过环境变量注入，不强制要求文件存在。
 */
function ensureEnvLoaded(): void {
  if (loaded) {
    return;
  }
  const envPath = path.resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
  loaded = true;
}

/**
 * 将空字符串规整为 undefined，便于统一默认值处理。
 */
function emptyToUndefined(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 必填字符串字段校验。
 */
function requiredString(key: string) {
  const message = `缺少必要环境变量: ${key}`;
  return z.preprocess(
    (value) => {
      const normalized = emptyToUndefined(value);
      return normalized === undefined ? "" : normalized;
    },
    z.string().min(1, message)
  );
}

/**
 * 可选字符串字段校验。
 */
function optionalString() {
  return z.preprocess(emptyToUndefined, z.string().optional());
}

/**
 * 可选地址字段校验，要求 0x 开头且长度为 42。
 */
function optionalAddressField(key: string) {
  return optionalString().transform((value, ctx) => {
    if (value === undefined) {
      return undefined;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: `环境变量 ${key} 不是有效地址: ${value}`,
      });
      return z.NEVER;
    }
    return value;
  });
}

/**
 * 整数字段校验，支持设置最小值。
 */
function intField(key: string, minValue: number) {
  return requiredString(key).transform((value, ctx) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      ctx.addIssue({
        code: "custom",
        message: `环境变量 ${key} 不是有效整数: ${value}`,
      });
      return z.NEVER;
    }
    if (parsed < minValue) {
      ctx.addIssue({
        code: "custom",
        message: `环境变量 ${key} 必须大于等于 ${minValue}: ${parsed}`,
      });
      return z.NEVER;
    }
    return parsed;
  });
}

/**
 * Decimal 字段校验，支持最小值约束。
 */
function decimalField(key: string, options: { minInclusive?: number; minExclusive?: number }) {
  return requiredString(key).transform((value, ctx) => {
    const decimal = Decimal(value);
    if (decimal.isNaN()) {
      ctx.addIssue({
        code: "custom",
        message: `环境变量 ${key} 不是有效数字: ${value}`,
      });
      return z.NEVER;
    }
    if (options.minExclusive !== undefined && decimal.lte(options.minExclusive)) {
      ctx.addIssue({
        code: "custom",
        message: `环境变量 ${key} 必须大于 ${options.minExclusive}: ${value}`,
      });
      return z.NEVER;
    }
    if (options.minInclusive !== undefined && decimal.lt(options.minInclusive)) {
      ctx.addIssue({
        code: "custom",
        message: `环境变量 ${key} 必须大于等于 ${options.minInclusive}: ${value}`,
      });
      return z.NEVER;
    }
    return decimal;
  });
}

/**
 * 可选 Decimal 字段校验。
 */
function optionalDecimalField(
  key: string,
  options: { minInclusive?: number; minExclusive?: number }
) {
  return optionalString().transform((value, ctx) => {
    if (value === undefined) {
      return undefined;
    }
    const decimal = Decimal(value);
    if (decimal.isNaN()) {
      ctx.addIssue({
        code: "custom",
        message: `环境变量 ${key} 不是有效数字: ${value}`,
      });
      return z.NEVER;
    }
    if (options.minExclusive !== undefined && decimal.lte(options.minExclusive)) {
      ctx.addIssue({
        code: "custom",
        message: `环境变量 ${key} 必须大于 ${options.minExclusive}: ${value}`,
      });
      return z.NEVER;
    }
    if (options.minInclusive !== undefined && decimal.lt(options.minInclusive)) {
      ctx.addIssue({
        code: "custom",
        message: `环境变量 ${key} 必须大于等于 ${options.minInclusive}: ${value}`,
      });
      return z.NEVER;
    }
    return decimal;
  });
}

/**
 * 布尔字段校验，仅支持 true/false/1/0。
 */
function booleanField(key: string) {
  return requiredString(key).transform((value, ctx) => {
    const normalized = value.toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
    ctx.addIssue({
      code: "custom",
      message: `环境变量 ${key} 不是有效布尔值: ${value}`,
    });
    return z.NEVER;
  });
}

/**
 * 可选布尔字段校验，未提供时返回默认值。
 */
function optionalBooleanField(key: string, defaultValue: boolean) {
  return optionalString().transform((value, ctx) => {
    if (value === undefined) {
      return defaultValue;
    }
    const normalized = value.toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
    ctx.addIssue({
      code: "custom",
      message: `环境变量 ${key} 不是有效布尔值: ${value}`,
    });
    return z.NEVER;
  });
}

/**
 * 解析子账户名称列表，支持逗号分隔，空值时回退为 default。
 */
function parseSubaccountNames(value: string | undefined): string[] {
  if (!value) {
    return ["default"];
  }
  const names = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return names.length > 0 ? names : ["default"];
}

/**
 * 交易所名称校验，统一为小写并提供默认值。
 */
function exchangeNameField() {
  return z
    .preprocess(
      (value) => {
        if (typeof value !== "string") {
          return value;
        }
        const trimmed = value.trim();
        if (!trimmed) {
          return undefined;
        }
        return trimmed.toLowerCase();
      },
      z.enum(["extended", "nado", "hyperliquid"], "暂不支持交易所")
    )
    .default("extended");
}

/**
 * 解析并校验环境变量，返回结构化的配置数据。
 */
const envSchema = z
  .object({
    GRID_STRATEGY_ID: optionalString().default("grid-default"),
    GRID_SYMBOL: requiredString("GRID_SYMBOL"),
    GRID_LEVELS: intField("GRID_LEVELS", 1),
    GRID_SPACING_MODE: requiredString("GRID_SPACING_MODE").transform((value, ctx) => {
      const normalized = value.toUpperCase();
      if (normalized !== "ABS" && normalized !== "PERCENT") {
        ctx.addIssue({
          code: "custom",
          message: `GRID_SPACING_MODE 仅支持 ABS 或 PERCENT: ${value}`,
        });
        return z.NEVER;
      }
      return normalized as GridSpacingMode;
    }),
    GRID_SPACING: optionalDecimalField("GRID_SPACING", { minExclusive: 0 }),
    GRID_SPACING_PERCENT: optionalDecimalField("GRID_SPACING_PERCENT", { minExclusive: 0 }),
    GRID_QUANTITY: decimalField("GRID_QUANTITY", { minExclusive: 0 }),
    GRID_POST_ONLY: booleanField("GRID_POST_ONLY"),
    GRID_CANCEL_TIMEOUT_MS: intField("GRID_CANCEL_TIMEOUT_MS", 1),
    GRID_MAX_POSITION: decimalField("GRID_MAX_POSITION", { minInclusive: 0 }),
    GRID_MAX_OPEN_ORDERS: intField("GRID_MAX_OPEN_ORDERS", 1),
    EXCHANGE: exchangeNameField(),
    EXTENDED_API_KEY: optionalString(),
    EXTENDED_L2_PRIVATE_KEY: optionalString(),
    EXTENDED_NETWORK: optionalString()
      .default("mainnet")
      .transform((value, ctx) => {
        const normalized = value.toLowerCase();
        if (normalized !== "mainnet" && normalized !== "testnet") {
          ctx.addIssue({
            code: "custom",
            message: `EXTENDED_NETWORK 仅支持 mainnet 或 testnet: ${value}`,
          });
          return z.NEVER;
        }
        return normalized as "mainnet" | "testnet";
      }),
    NADO_PRIVATE_KEY: optionalString(),
    NADO_RPC_URL: optionalString().default("https://rpc-gel.inkonchain.com"),
    NADO_SUBACCOUNT_NAMES: optionalString().default("default"),
    HYPERLIQUID_PRIVATE_KEY: optionalString(),
    HYPERLIQUID_USER_ADDRESS: optionalAddressField("HYPERLIQUID_USER_ADDRESS"),
    HYPERLIQUID_NETWORK: optionalString()
      .default("mainnet")
      .transform((value, ctx) => {
        const normalized = value.toLowerCase();
        if (normalized !== "mainnet" && normalized !== "testnet") {
          ctx.addIssue({
            code: "custom",
            message: `HYPERLIQUID_NETWORK 仅支持 mainnet 或 testnet: ${value}`,
          });
          return z.NEVER;
        }
        return normalized as "mainnet" | "testnet";
      }),
    HYPERLIQUID_DEX: optionalString(),
    HYPERLIQUID_MIN_NOTIONAL: optionalDecimalField("HYPERLIQUID_MIN_NOTIONAL", {
      minExclusive: 0,
    }),
    DB_PATH: optionalString().default("data/perp-grid.db"),
    DEBUG_MARKET_LOG: optionalBooleanField("DEBUG_MARKET_LOG", false),
    BARK_SERVER: optionalString(),
    BARK_KEYS: optionalString(),
  })
  .superRefine((data, ctx) => {
    if (data.GRID_SPACING_MODE === "ABS" && !data.GRID_SPACING) {
      ctx.addIssue({
        code: "custom",
        message: "GRID_SPACING_MODE=ABS 时必须提供 GRID_SPACING",
        path: ["GRID_SPACING"],
      });
    }
    if (data.GRID_SPACING_MODE === "PERCENT" && !data.GRID_SPACING_PERCENT) {
      ctx.addIssue({
        code: "custom",
        message: "GRID_SPACING_MODE=PERCENT 时必须提供 GRID_SPACING_PERCENT",
        path: ["GRID_SPACING_PERCENT"],
      });
    }
    if (data.EXCHANGE === "extended" && !data.EXTENDED_API_KEY) {
      ctx.addIssue({
        code: "custom",
        message: "EXCHANGE=extended 时必须提供 EXTENDED_API_KEY",
        path: ["EXTENDED_API_KEY"],
      });
    }
    if (data.EXCHANGE === "extended" && !data.EXTENDED_L2_PRIVATE_KEY) {
      ctx.addIssue({
        code: "custom",
        message: "EXCHANGE=extended 时必须提供 EXTENDED_L2_PRIVATE_KEY",
        path: ["EXTENDED_L2_PRIVATE_KEY"],
      });
    }
    if (data.EXCHANGE === "nado" && !data.NADO_PRIVATE_KEY) {
      ctx.addIssue({
        code: "custom",
        message: "EXCHANGE=nado 时必须提供 NADO_PRIVATE_KEY",
        path: ["NADO_PRIVATE_KEY"],
      });
    }
    if (data.EXCHANGE === "hyperliquid" && !data.HYPERLIQUID_PRIVATE_KEY) {
      ctx.addIssue({
        code: "custom",
        message: "EXCHANGE=hyperliquid 时必须提供 HYPERLIQUID_PRIVATE_KEY",
        path: ["HYPERLIQUID_PRIVATE_KEY"],
      });
    }
  });

type EnvValues = z.infer<typeof envSchema>;

/**
 * 将校验错误整理为可读信息。
 */
function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

/**
 * 读取环境变量并转换为结构化配置。
 */
function readEnv(): EnvValues {
  ensureEnvLoaded();
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }
  return result.data;
}

/**
 * 构建网格配置。
 */
function loadGridConfig(env: EnvValues): GridConfig {
  const baseConfig: GridConfig = {
    strategyId: env.GRID_STRATEGY_ID,
    symbol: env.GRID_SYMBOL,
    levels: env.GRID_LEVELS,
    spacingMode: env.GRID_SPACING_MODE,
    spacing: undefined,
    spacingPercent: undefined,
    quantity: env.GRID_QUANTITY,
    postOnly: env.GRID_POST_ONLY,
    cancelTimeoutMs: env.GRID_CANCEL_TIMEOUT_MS,
    maxPosition: env.GRID_MAX_POSITION,
    maxOpenOrders: env.GRID_MAX_OPEN_ORDERS,
  };

  if (env.GRID_SPACING_MODE === "ABS") {
    return {
      ...baseConfig,
      spacing: env.GRID_SPACING,
    };
  }

  return {
    ...baseConfig,
    spacingPercent: env.GRID_SPACING_PERCENT,
  };
}

/**
 * 构建交易所配置，按交易所类型组装对应配置。
 */
function loadExchangeConfig(env: EnvValues): ExchangeConfig {
  if (env.EXCHANGE === "extended") {
    // Extended 凭据已在环境校验阶段保证存在。
    const extendedApiKey = env.EXTENDED_API_KEY as string;
    const extendedL2PrivateKey = env.EXTENDED_L2_PRIVATE_KEY as string;
    return {
      name: env.EXCHANGE,
      extended: {
        apiKey: extendedApiKey,
        l2PrivateKey: extendedL2PrivateKey,
        network: env.EXTENDED_NETWORK,
      },
    };
  }
  // Nado 私钥已在环境校验阶段保证存在。
  if (env.EXCHANGE === "nado") {
    const nadoPrivateKey = env.NADO_PRIVATE_KEY as string;
    return {
      name: env.EXCHANGE,
      nado: {
        rpcUrl: env.NADO_RPC_URL,
        privateKey: nadoPrivateKey,
        subaccountNames: parseSubaccountNames(env.NADO_SUBACCOUNT_NAMES),
      },
    };
  }
  const hyperliquidPrivateKey = env.HYPERLIQUID_PRIVATE_KEY as string;
  return {
    name: env.EXCHANGE,
    hyperliquid: {
      privateKey: hyperliquidPrivateKey,
      userAddress: env.HYPERLIQUID_USER_ADDRESS,
      network: env.HYPERLIQUID_NETWORK,
      dex: env.HYPERLIQUID_DEX || undefined,
      minNotional: env.HYPERLIQUID_MIN_NOTIONAL,
    },
  };
}

/**
 * 构建通知配置。
 */
function loadNotificationConfig(env: EnvValues): NotificationConfig {
  const barkKeys =
    env.BARK_KEYS && env.BARK_KEYS.length > 0
      ? env.BARK_KEYS.split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined;
  return {
    barkServer: env.BARK_SERVER || undefined,
    barkKeys,
  };
}

/**
 * 构建数据库配置。
 */
function loadDbConfig(env: EnvValues): DbConfig {
  return {
    path: env.DB_PATH,
  };
}

/**
 * 构建调试配置。
 */
function loadDebugConfig(env: EnvValues): DebugConfig {
  return {
    marketLog: env.DEBUG_MARKET_LOG,
  };
}

/**
 * 加载应用配置，供启动流程统一使用。
 */
export function loadAppConfig(): AppConfig {
  const env = readEnv();
  return {
    grid: loadGridConfig(env),
    exchange: loadExchangeConfig(env),
    notification: loadNotificationConfig(env),
    db: loadDbConfig(env),
    debug: loadDebugConfig(env),
  };
}
