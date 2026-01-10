# perp-trader-grid

perp-trader-grid 是一个网格交易机器人，支持 Nado、Extended 与 Hyperliquid 交易所。

## 运行

- 本地开发：`pnpm dev`
- 构建运行：`pnpm build` 后执行 `pnpm start`
- 退出流程：支持 `SIGINT` / `SIGTERM`，收到信号后会停止编排、断开交易所并关闭数据库

## 交易所 SDK

- Extended 对接使用 npm 包 `@shenzheyu/extended`。
- Nado 对接使用 npm 包 `@nadohq/client`。
- Hyperliquid 对接使用 npm 包 `@nktkas/hyperliquid`。

## 环境变量配置

本项目使用 `.env` 管理本地配置，示例可参考 `.env.example`。

### 网格参数

- 策略 ID：`GRID_STRATEGY_ID=grid-default`
- 交易对：`GRID_SYMBOL=BTC`
- 单边档位数：`GRID_LEVELS=10`
- 间距模式：`GRID_SPACING_MODE=ABS` 或 `GRID_SPACING_MODE=PERCENT`
- 绝对价差：`GRID_SPACING=10`（仅 ABS 模式）
- 百分比间距：`GRID_SPACING_PERCENT=0.002`（仅 PERCENT 模式）
- 每档数量：`GRID_QUANTITY=0.001`
- 是否 post-only：`GRID_POST_ONLY=true`
- 撤单超时（毫秒）：`GRID_CANCEL_TIMEOUT_MS=60000`
- 最大持仓：`GRID_MAX_POSITION=0.01`
- 最大挂单数：`GRID_MAX_OPEN_ORDERS=40`

### 调试与数据库

- 行情调试日志：`DEBUG_MARKET_LOG=false`
- SQLite 路径：`DB_PATH=./data/perp-grid.db`

### 交易所选择

- 交易所类型：`EXCHANGE=extended`（可选 `nado` / `hyperliquid`）

### Extended 配置

- API Key：`EXTENDED_API_KEY=...`
- L2 私钥：`EXTENDED_L2_PRIVATE_KEY=...`
- 网络：`EXTENDED_NETWORK=mainnet`（或 `testnet`）

### Nado 配置（inkMainnet）

- RPC 地址：`NADO_RPC_URL=https://rpc-gel.inkonchain.com`
- 交易私钥：`NADO_PRIVATE_KEY=...`
- 子账户列表：`NADO_SUBACCOUNT_NAMES=default,sub1`

`NADO_SUBACCOUNT_NAMES` 支持逗号分隔，未填写时默认 `default`。

### Hyperliquid 配置

- 网络：`HYPERLIQUID_NETWORK=mainnet`（或 `testnet`）
- 交易私钥：`HYPERLIQUID_PRIVATE_KEY=...`
- 账户地址：`HYPERLIQUID_USER_ADDRESS=...`（使用 agent key 或子账户时必须填主账户/子账户地址，用于 Info 端点查询）
- 可选 DEX 名称：`HYPERLIQUID_DEX=`（默认留空使用主 DEX）
- 最小下单金额（USD）：`HYPERLIQUID_MIN_NOTIONAL=10`（可按需调整）
- Builder DEX 交易对说明：当需要交易 Builder DEX 资产时，需要提供 `HYPERLIQUID_DEX`（小写），并确保交易对使用 `dex:ASSET` 形式。
  - 自动映射：`HYPERLIQUID_DEX=xyz` + `GRID_SYMBOL=XYZ100` 会自动映射为 `xyz:XYZ100`
  - 显式填写：`GRID_SYMBOL=xyz:XYZ100` 也可用，系统会规范化为 `xyz:XYZ100`

示例（Builder DEX + XYZ100 永续）：

```bash
EXCHANGE=hyperliquid
HYPERLIQUID_NETWORK=mainnet
HYPERLIQUID_PRIVATE_KEY=...
HYPERLIQUID_DEX=xyz
GRID_SYMBOL=XYZ100
```

### 通知（可选）

- Bark 服务地址：`BARK_SERVER=https://api.day.app`
- Bark 设备 key 列表：`BARK_KEYS=key1,key2`（逗号分隔，不支持 JSON 数组）

## Extended 配置示例

```bash
EXCHANGE=extended
EXTENDED_NETWORK=mainnet
EXTENDED_API_KEY=...
EXTENDED_L2_PRIVATE_KEY=...
GRID_SYMBOL=BTC
```

## Nado 配置示例

```bash
EXCHANGE=nado
NADO_RPC_URL=https://rpc-gel.inkonchain.com
NADO_PRIVATE_KEY=...
NADO_SUBACCOUNT_NAMES=default
GRID_SYMBOL=BTC
```

## PM2 部署

1. 构建产物：`pnpm build`
2. 启动服务：`pm2 start ecosystem.config.js`
3. 查看日志：`pm2 logs perp-trader-grid`
4. 重启服务：`pm2 restart perp-trader-grid`
5. 停止服务：`pm2 stop perp-trader-grid`

## 数据库

- 默认使用 SQLite，路径由 `DB_PATH` 配置（默认 `./data/perp-grid.db`）。
- 启动时自动初始化 `orders` 表结构。

### 初始化流程

1. 启动应用时读取 `DB_PATH` 并创建目录（若不存在会自动创建）。
2. 连接 SQLite 文件，开启 `WAL` 与 `foreign_keys`。
3. 执行初始化 SQL：创建 `orders` 表与索引（若已存在则跳过）。

无需手动迁移，首次启动会自动完成初始化。
