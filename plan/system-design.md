# 系统设计与技术栈

## 目标与约束

- 将 `perp-dex-trader` 的网格交易模块迁移到本仓库并做结构化重构。
- 交易所对接统一通过 `@shenzheyu/extended` SDK，同时预留多交易所扩展接口。
- 运行环境为 Node.js，数据库使用 SQLite + Drizzle，仅保留 `orders` 单表。
- 依赖直接使用已发布的 npm 包 `@shenzheyu/extended`，避免本地引用带来的版本漂移。
- 保持策略行为一致，强调可维护性与可扩展性。

## 设计原则

- 领域逻辑与基础设施解耦，核心策略不直接依赖 SDK 与数据库。
- 状态单一来源，订单状态流转由事件与对账统一驱动。
- 事件驱动为主、定时对账为辅，保证异常场景可恢复。
- 适配层可插拔，统一数据模型与能力描述。
- 模块内聚、文件适度拆分，避免单体文件过大。
- 网格始终保持对称结构，避免方向性偏置。

## 模块划分与职责

```
src/
  bootstrap/           进程入口与生命周期管理
    grid.ts
    grid-bot.ts
  app/                 应用编排层，负责运行态流程
    grid-runtime.ts
    grid-orchestrator.ts
    reconcilers/
      order-reconciler.ts
    schedulers/
      tick-driver.ts
  core/                领域核心，纯逻辑与状态
    grid/
      strategy.ts
      state.ts
      level.ts
      order-manager.ts
      order-factory.ts
      types.ts
    risk/
      risk-guard.ts
      limit-checks.ts
    exchange/
      adapter.ts
      models.ts
      events.ts
  services/            应用服务层，面向业务用例
    market-data/
      market-data-service.ts
      quote-normalizer.ts
    recorder/
      order-recorder.ts
    notification/
      notifier.ts
  infra/               基础设施实现
    exchange/
      factory.ts
      extended/
        extended-client.ts
        extended-orderbook.ts
        extended-account.ts
    db/
      index.ts
      schema.ts
      order-repo.ts
    config/
      env.ts
      schema.ts
    log/
      logger.ts
    clock/
      timer.ts
  shared/              通用类型与工具
    errors.ts
    time.ts
    types.ts
```

依赖方向约束：

- `core` 只依赖 `shared`，保持纯逻辑。
- `services` 依赖 `core`，通过接口访问 `infra` 的实现。
- `app` 依赖 `core` 与 `services`，负责编排流程与调度。
- `infra` 依赖外部 SDK/DB，仅实现接口，不反向依赖应用层。
- `bootstrap` 负责装配与启动。

## 关键职责与协作关系

- 策略计算与订单决策在 `core/grid` 完成，输出目标档位与订单意图。
- 风控规则集中在 `core/risk`，由订单管理器统一调用。
- 行情接入由 `services/market-data` 统一输出 `ExchangeQuote`。
- 策略计算以 mark 价格为中心价，不依赖 mid 作为锚点。
- 订单落库由 `services/recorder` 负责，`infra/db` 提供仓储实现。
- 对账与修复由 `app/reconcilers` 控制执行节奏与触发条件。
- 交易所对接由 `infra/exchange` 实现并通过 `core/exchange` 接口暴露能力。

## 网格策略设计

### 网格形态

- 始终保持“下 N 档 BUY、上 N 档 SELL”的对称结构。
- 成交只更新订单状态，不改变目标挂单方向。
- 网格中心价以 mark 价格为准。

### 间距模式

- 绝对价差网格：`price_i = center ± i * spacing`
- 几何百分比网格：`price_i = center * (1 + p)^i`
- 配置支持二选一，默认使用绝对价差。

### 平移与重建规则

- 价格每跨一档就触发平移。
- 单次更新可跨多档，按 `steps` 一次性平移。
- 当 `abs(steps) >= levels` 时，执行全量重建：
  - 撤销所有未终态订单
  - 以最新 mark 重新构建对称网格
  - 补齐上下档位挂单
- 当 `abs(steps) < levels` 时，执行平移与局部补单：
  - 更新中心价与档位价格
  - 撤销超出范围或方向不匹配的订单
  - 补齐缺失档位

### 跨档步数计算

- 绝对价差网格：
  - `steps = floor(|mark - center| / spacing)`，方向由 `mark` 相对 `center` 决定
- 几何百分比网格：
  - 上涨：`steps = floor(log(mark / center) / log(1 + p))`
  - 下跌：`steps = -floor(log(center / mark) / log(1 + p))`

## 关键流程

### 启动流程

1. 读取并校验环境变量。
2. 初始化数据库连接与订单记录服务。
3. 根据配置创建交易所适配器并建立连接。
4. 启动行情订阅与账户更新监听。
5. 启动网格运行时，进入策略与订单循环。

### 行情驱动下单

1. 适配器输出订单簿更新。
2. 行情服务生成 top-of-book `ExchangeQuote`。
3. 使用 mark 价格计算平移步数与目标档位。
4. 订单管理器对比目标与当前状态。
5. 触发下单或撤单并记录变更。

### 订单生命周期

1. 生成 `clientOrderId`，插入 `orders` 记录为 `PENDING_SEND`。
2. 下单成功后更新为 `SENT`。
3. WS 回报更新为 `ACKED` / `PARTIALLY_FILLED` / `FILLED`。
4. 定时 REST 对账修复遗漏状态。
5. 撤单或过期更新 DB 与内存状态。

### 断线与状态修复

1. 适配器上报断线事件，暂停下单与撤单操作。
2. 重连后重新订阅行情与账户通道。
3. 执行一次全量对账，恢复订单状态与档位一致性。

## 交易所适配层

统一接口屏蔽交易所差异，核心逻辑只依赖接口与数据模型。

### 统一接口定义

```
type Unsubscribe = () => void;

interface ExchangeCapabilities {
  supportsMassCancel: boolean;
  supportsPostOnly: boolean;
  supportsOrderbook: boolean;
  supportsMarkPrice: boolean;
}

interface GridExchangeAdapter {
  readonly name: string;
  readonly capabilities: ExchangeCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribeOrderbook(params: OrderbookSubscribeParams): Unsubscribe;
  subscribeAccount(params: AccountSubscribeParams): Unsubscribe;
  getMarketConfig(symbol: string): Promise<MarketTradingConfig>;
  getOpenOrders(symbol: string): Promise<ExchangeOrder[]>;
  getOrdersHistory(params: OrderHistoryQuery): Promise<ExchangeOrder[]>;
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>;
  cancelOrderByExternalId(externalId: string): Promise<void>;
  massCancel(symbol: string): Promise<void>;
}
```

关键模型由 `core/exchange/models.ts` 统一维护，包括：

- `ExchangeQuote`：标准化行情报价，包含 `bid` / `ask` / `mark` / `ts`。
- `AccountUpdate`：订单、余额、持仓变更事件。
- `ExchangeOrder`：订单状态与数量汇总。
- `MarketTradingConfig`：最小步长、费率、最小下单限制。
- `PlaceOrderRequest` / `PlaceOrderResult`：下单请求与回报。

### Extended 实现要点

- 行情订阅使用 `StreamClient.stream.orderbooks` + `OrderbookTracker`。
- 订单回报使用 `StreamClient.stream.accountUpdates`。
- 下单使用 `createOrderRequest`，`clientOrderId` 写入 `OrderRequest.id`。
- post-only 走 maker 费率，其余走 taker 费率，并保留 builder 费率上限与 builderId。
- mark 价格通过扩展行情通道或 REST 补齐，保证 `ExchangeQuote.mark` 可用。

### 多交易所接入方案

- 使用 `infra/exchange/factory.ts` 实现适配器工厂。
- 新交易所仅需实现 `GridExchangeAdapter` 并注册到工厂。
- 以 `EXCHANGE` 配置选择适配器，核心逻辑无需改动。
- 对能力差异通过 `ExchangeCapabilities` 做运行时判断。
- 交易所必须支持 mark 价格，不支持 mark 的交易所不接入。

## 数据存储

仅保留 `orders` 单表，记录网格订单全生命周期状态。`services/recorder` 作为统一写入入口，
避免状态分散在多处更新，并为对账提供权威依据。

### orders 表字段（草案）

- `id`：主键
- `strategy_id`：策略 ID
- `exchange`：交易所名称
- `account_id`：交易所账户标识
- `symbol`：统一交易对（如 `SOL`）
- `exchange_symbol`：交易所交易对（如 `SOL-USD`）
- `client_order_id`：客户端订单号
- `exchange_order_id`：交易所订单号（可空）
- `side`：BUY / SELL
- `order_type`：LIMIT / MARKET
- `time_in_force`：GTT / IOC / FOK / GTC（可空）
- `post_only`：是否 post-only
- `reduce_only`：是否 reduce-only
- `price`：下单价格（TEXT）
- `quantity`：下单数量（TEXT）
- `filled_quantity`：已成交数量（TEXT，可空）
- `avg_fill_price`：平均成交价（TEXT，可空）
- `status`：统一订单状态
- `exchange_status`：交易所原始状态（可空）
- `status_reason`：状态原因（可空）
- `grid_level_index`：网格档位（可空）
- `placed_at`：下单时间（毫秒）
- `exchange_updated_at`：交易所更新时间（毫秒）
- `record_created_at`：入库时间（毫秒）
- `record_updated_at`：更新时间（毫秒）

### orders 表索引（草案）

- 唯一索引：`exchange + client_order_id`
- 普通索引：`exchange + exchange_order_id`
- 普通索引：`strategy_id + status`
- 普通索引：`exchange + symbol + status`

## 配置与安全

- 使用 `.env` 管理本地变量，并提供 `.env.example`。
- 配置分为网格参数、交易所参数与通知参数，统一校验与默认值。
- 新增网格间距模式：
  - `GRID_SPACING_MODE`：`ABS` | `PERCENT`
  - `GRID_SPACING`：绝对价差
  - `GRID_SPACING_PERCENT`：百分比间距（如 `0.002` 代表 0.2%）

## 工程化与项目初始化

- 包管理工具：pnpm。
- 基础文件：
  - `package.json`：脚本与依赖管理
  - `tsconfig.json` / `tsconfig.paths.json`：TypeScript 配置与路径别名
  - `biome.json`：格式化与静态检查
  - `vitest.config.ts`：测试配置
  - `ecosystem.config.js`：pm2 部署配置
- 推荐脚本：
  - `pnpm dev`：tsx 启动本地开发（热更新）
  - `pnpm build`：esbuild 打包产物
  - `pnpm start`：运行打包产物
  - `pnpm test`：运行 vitest
  - `pnpm lint` / `pnpm format`：Biome 校验与格式化
- 依赖清单（建议）：
  - 运行时：`@shenzheyu/extended`、`bignumber.js`、`dotenv`、`drizzle-orm`、`better-sqlite3`、`zod`
  - 开发时：`typescript`、`@types/node`、`vitest`、`biome`、`drizzle-kit`、`tsx`、`esbuild`

## 可观测性

- 统一日志出口，关键字段带上 `strategyId` / `symbol` / `orderId`。
- 重点记录：下单、撤单、回报、对账、重连与异常。

## 技术栈

- 语言：TypeScript
- 运行时：Node.js
- 包管理：pnpm
- 交易所 SDK：`@shenzheyu/extended`（npm 包）
- 数据库：SQLite
- ORM：Drizzle
- 配置：`.env` + 配置加载器
- 配置校验：zod
- 开发运行：tsx
- 构建：esbuild
- 测试：vitest
- 代码格式化与校验：biome
- 通知：BARK（可选）
