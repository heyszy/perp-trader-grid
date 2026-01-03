# Nado 交易所对接方案与计划

## 目标与范围

- 在现有网格框架内新增 Nado 交易所适配器，保持策略行为一致。
- 覆盖行情订阅、下单/撤单、订单与仓位更新、订单对账/历史查询等能力。
- 通过配置切换交易所，不影响 Extended 现有逻辑。

## 关键依赖与约束

- SDK 入口为 `createNadoClient`，`NadoClient` 暴露 `market` / `subaccount` / `perp` / `spot` / `ws`。
- `createNadoClient` 支持 `ChainEnv` 或自定义 endpoints；`ChainEnv` 取值为 `local` / `inkTestnet` / `inkMainnet`，默认使用 `ENGINE_CLIENT_ENDPOINTS` / `INDEXER_CLIENT_ENDPOINTS` / `TRIGGER_CLIENT_ENDPOINTS` 与 `NADO_DEPLOYMENTS`。
- `inkMainnet` 仅决定链与网关端点，仍需提供 RPC URL 用于构建 `publicClient` / `walletClient`。
- WS 端点由 `ENGINE_WS_CLIENT_ENDPOINTS`（query/execute）与 `ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS`（订阅）提供，SDK 仅拼装消息，不负责建立连接。
- SDK 的 WS 消息构造入口为 `nadoClient.ws.execute/query/subscription`，消息体对应 gateway 的 `place_order` / `cancel_orders` / `subaccount_orders` / `subscribe` 等。
- 网关文档使用 `GATEWAY_WEBSOCKET_ENDPOINT`（executes/queries/subscriptions），在实现中映射为 SDK 的 `/ws`（execute/query）与 `/subscribe`（订阅）两条连接。
- 签名走 EIP712：需要 `walletClient`（或 `linkedSignerWalletClient`），`subaccount.createStandardLinkedSigner` 可生成标准 linked signer。
- 订单字段为 `EIP712OrderParams`（`expiration` 秒、`price`、`amount`（正买负卖）、`nonce`、`appendix`），`appendix` 用 `packOrderAppendix` 生成；`getOrderNonce` / `getOrderDigest` 可生成 nonce/digest。
- 订单 `nonce` 结构为 `recv_time_ms << 20` + `random(20 bits)`，SDK `getOrderNonce` 默认使用 `now + 90s`。
- 取消订单依赖 `digest` + `productId` 列表；`placeOrder.id` 为可选 number（客户端自定义），会回传到 `Fill` / `OrderUpdate`，但不参与 digest。
- `id` 与 `nonce` 无直接关系：`nonce` 参与签名与 digest，`id` 仅用于回传关联；需在本地维护 `clientOrderId <-> id <-> digest` 映射，并持久化 `id` 与 `digest`。
- 数值精度默认 18（`NADO_PRODUCT_DECIMALS = 18`），使用 `addDecimals` / `removeDecimals` 做换算；WS 推送与查询多数为 x18 字符串。
- 子账户以 `subaccountOwner` + `subaccountName` 表示，WS 订阅需传 bytes32 hex（`subaccountToHex`）。
- 速率限制：`place_order` 会区分 `spot_leverage` 与否（文档给出 600 orders/min vs 30 orders/min），需要在下单节流中考虑。

## 决策记录

- PERP 交易对固定采用 `{BASE}-PERP` 形式（如 `BTC` -> `BTC-PERP`），启动时可用 `getSymbols` 校验存在性。
- `placeOrder.id` 使用本地递增序号生成，作为事件回传关联；维护 `clientOrderId <-> id <-> digest` 映射，撤单仍以 `digest` 为准。
- `id` 与 `digest` 需要落表：`digest` 写入 `exchangeOrderId`，新增 `clientOrderNum` 保存 `id`。
- WS 采用双连接：`/ws` 发送 execute/query，`/subscribe` 负责订阅流。
- `createNadoClient` 使用 `inkMainnet` 环境。
- 支持多个子账户名，通过配置列表统一订阅与对账。
- RPC 通过配置项提供（`NADO_RPC_URL`），用于构建 `publicClient` / `walletClient`。
- 当前 RPC 选型：INK 主网 `https://rpc-gel.inkonchain.com`（Chain ID: 57073）。

## 目录结构设计（模块化）

建议新增目录 `src/infra/exchange/nado/`，拆分如下：

- `nado-adapter.ts`：实现 `GridExchangeAdapter`，负责业务入口。
- `nado-client.ts`：创建 Nado SDK 客户端、管理 wallet/public client。
- `nado-context.ts`：加载产品信息（`getSymbols` / `getAllMarkets`）、费率（`getSubaccountFeeRates`）、市场参数等。
- `nado-ws.ts`：维护两条 WS 连接（`/ws` 执行/查询、`/subscribe` 订阅）、订阅管理、重连策略与事件分发。
- `nado-orderbook.ts`：订阅 best bid/offer 或订单簿，输出 `ExchangeQuote`。
- `nado-order.ts`：订单参数/appendix/nonce/digest 构建与映射，负责 `id` 序号生成与 `clientOrderId <-> id <-> digest` 维护。
- `nado-symbol-mapper.ts`：交易对与 `product_id`、`ticker_id` 的映射。
- `nado-utils.ts`：状态映射、数值换算、时间处理等工具。
- `nado-rate-limit.ts`：如有必要，统一 429 退避控制。

## 配置与文档改动

- `src/infra/config/schema.ts`：
  - 扩展 `ExchangeName` 支持 `nado`。
  - 新增 `NadoConfig`（网络、私钥、RPC、子账户名等）。
- `src/infra/config/env.ts`：
  - 新增 `NADO_*` 环境变量解析与校验。
- 建议环境变量：
  - `NADO_RPC_URL`：inkMainnet RPC 地址（默认 `https://rpc-gel.inkonchain.com`）。
  - `NADO_SUBACCOUNT_NAMES`：逗号分隔的子账户名列表。
- `src/infra/db/schema.ts`：
  - 新增 `clientOrderNum` 字段（保存 Nado 的 `id`），`exchangeOrderId` 存 `digest`。
- `src/core/exchange/models.ts` / `src/services/recorder/order-recorder.ts`：
  - 同步落库字段，确保 `id` / `digest` 可被对账与回放使用。
- `.env.example`：追加 Nado 所需配置项（空值占位）。
- `README.md`：补充 Nado 配置与启动说明。
- `src/infra/exchange/factory.ts`：新增 `nado` 分支创建适配器。

## 交易功能映射设计

### 行情/Mark 价格

- 实时：订阅 `best_bid_offer` 流，字段 `bid_price` / `ask_price`（x18），用 `removeDecimals` 转换后取中间价作为 `mark`。
- 兜底：`market.getLatestMarketPrice` / `market.getLatestMarketPrices`（engine `market_price(s)`）获取 bid/ask。
- 如需深度：可选 `book_depth` 流或 `market.getMarketLiquidity`。

### 下单与撤单

- 使用 `nadoClient.market.placeOrder`：
  - `order` 需补齐 `subaccountOwner` / `subaccountName`，`price` / `amount` 用 `addDecimals`，`expiration` 为秒级时间戳。
  - SDK 在签名时会对 `price` 执行 `addDecimals`，但 `amount` 不会自动放大，需要提前转为 x18。
  - `appendix` 由 `packOrderAppendix` 构建（`orderExecutionType` / `reduceOnly` / `isolated`）。
  - `nonce` 可省略，SDK 会自动生成；需要时用 `getOrderNonce`。
  - `id?: number` 仅自定义标识，非 `clientOrderId`。
- 撤单使用 `nadoClient.market.cancelOrders`（`digests` + `productIds`），必要时用 `getOrderDigest` 计算。
- 支持 `cancelProductOrders`（按产品撤全）与 `cancelAndPlace`（替换下单）。

### 订单更新

- 使用 `order_update` 订阅流获取状态更新：`digest` / `amount` / `reason(placed|filled|cancelled)` / `timestamp`。
- 使用 `fill` 流补充成交细节：`order_digest` / `filled_qty` / `remaining_qty` / `price` / `fee` / `appendix`。
- 若下单传 `id`，理论上 `Fill` / `OrderUpdate` 事件会回传该 `id`；但当前 SDK 明确在事件类型中移除了 `id`（避免 `u64` 溢出）。因此运行态只能依赖 `digest` 进行订单关联，`id` 仅用于本地落库与回放。

### 仓位更新

- 订阅 `position_change` 流：`product_id` / `amount` / `v_quote_amount` / `isolated` / `reason` / `timestamp`。
- 快照兜底：`subaccount.getSubaccountSummary` 与 `subaccount.getIsolatedPositions`。

### 历史订单与对账

- 历史订单：`market.getHistoricalOrders`（indexer `getOrders`）或 `indexerClient.getPaginatedSubaccountOrders`。
- 开放订单：`market.getOpenSubaccountOrders` / `market.getOpenSubaccountMultiProductOrders`。
- 对账时统一时间戳、数量精度与 `appendix` 映射（`unpackOrderAppendix`）。

## 计划拆解

### 阶段 1：调研与确认（文档 + 原型）

- 核对 SDK 中以下接口与返回结构：
  - `market.getSymbols` / `market.getAllMarkets` / `market.getLatestMarketPrice(s)` / `market.getMarketLiquidity`。
  - `market.placeOrder` / `market.cancelOrders` / `market.cancelProductOrders` / `market.getOpenSubaccountOrders`。
  - `indexer.getOrders` / `indexer.getPaginatedSubaccountOrders` / `subaccount.getSubaccountSummary` / `subaccount.getIsolatedPositions`。
- 明确 `product_id` / `symbol` 的转换策略（固定 `{BASE}-PERP`，用 `getSymbols` 校验）。
- 确认 `order_update` / `fill` / `position_change` 的订阅参数与解析规则。
- 明确 linked signer 的使用方式与签名私钥来源。
- 输出决策记录（建议写入计划文件的 “决策” 小节）。

### 阶段 2：配置与客户端封装

- 新增 `NadoConfig`，完善环境变量与配置装配。
- 实现 `nado-client.ts`，封装 `createNadoClient`，统一处理网络与 RPC（`ChainEnv` / 自定义 endpoints）。
- 增加 WS 端点配置（`ENGINE_WS_CLIENT_ENDPOINTS` / `ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS`）。
- 明确子账户名列表与 linked signer 的装配策略（可选 `createStandardLinkedSigner` + `linkSigner`）。
- 更新 `README.md` 与 `.env.example`。

### 阶段 3：行情订阅与市场参数

- 实现 `nado-ws.ts`：
  - 建立 WS 连接并发送订阅消息，处理重连与重复订阅。
- 实现 `nado-orderbook.ts`：
  - 订阅 `best_bid_offer`，推送 `ExchangeQuote`。
  - 必要时用 `market.getLatestMarketPrice(s)` 兜底。
- 实现 `nado-context.ts`：
  - 拉取产品信息（`getSymbols` / `getAllMarkets`）。
  - 获取费率（`getSubaccountFeeRates`），输出 `MarketTradingConfig`。

### 阶段 4：订单与仓位通道

- 实现订单下单/撤单/批量撤单逻辑（`placeOrder` / `cancelOrders` / `cancelProductOrders` / `cancelAndPlace`）。
- 使用 `order_update` + `fill` 订阅并映射到 `OrderUpdate`（多子账户需逐个订阅）。
- 使用 `position_change` 订阅并映射到 `ExchangePosition`（多子账户需逐个订阅），必要时拉取快照纠偏。
- 维护 `clientOrderId` 与 `digest` 的映射缓存。

### 阶段 5：对账与异常处理

- 实现 `getOpenOrders`、`getOrdersHistory`、`getOrderByClientOrderId`。
- 统一状态映射与字段换算，使用 `unpackOrderAppendix` 还原订单属性。
- 处理 `EngineServerFailureError` / trigger 错误码。
- 可选：接入限流退避机制与 linked signer 额度检查（`getLinkedSignerWithRateLimit`）。

### 阶段 6：验证与回归

- 本地连接测试网（或 sandbox），验证：
  - 行情更新频率与 mark 逻辑。
  - 下单、撤单、订单更新、仓位更新完整链路。
  - 对账流程与撤单超时处理。
- 运行 `npm run typecheck`、`npm run format`、`npm run lint`。
- 更新 `README.md` 与计划状态。

## 进度更新

- 已完成：配置与客户端封装、双 WS 连接、行情订阅、下单/撤单/批量撤单、订单/仓位订阅、订单与历史查询、`clientOrderNum` 落库与工厂接入。
- 进行中：补充文档与 SDK 限制说明，完善验证步骤。

## 待确认问题

- SDK 订阅事件缺少 `id` 字段，当前依赖 `digest` 做订单回传关联；若后续需要 `id`，需确认官方是否提供带 `id` 的 payload 或替代方案。

## 验收标准

- 使用 `EXCHANGE=nado` 可正常启动网格，行情/下单/撤单/对账正常。
- 订单与仓位更新可被 `GridOrderManager` 消费并驱动网格逻辑。
- 文档与配置示例完整，Extended 功能不受影响。
