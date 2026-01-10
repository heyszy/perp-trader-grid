# perp-trader-grid

## 运行

- 本地开发：`pnpm dev`
- 构建运行：`pnpm build` 后执行 `pnpm start`
- 退出流程：支持 `SIGINT` / `SIGTERM`，收到信号后会停止编排、断开交易所并关闭数据库

## 交易所 SDK

- Extended 对接使用 npm 包 `@shenzheyu/extended`。
- Nado 对接使用 npm 包 `@nadohq/client`。

## Nado 配置（inkMainnet）

- 切换交易所：`EXCHANGE=nado`
- RPC 地址：`NADO_RPC_URL=https://rpc-gel.inkonchain.com`
- 交易私钥：`NADO_PRIVATE_KEY=...`
- 子账户列表：`NADO_SUBACCOUNT_NAMES=default,sub1`

`NADO_SUBACCOUNT_NAMES` 支持逗号分隔，未填写时默认 `default`。

## Nado 数量精度

- Nado 返回的订单数量与成交数量为 x18 精度，系统会转换为实际数量后落库。
- Nado 事件时间戳可能为秒/毫秒/微秒/纳秒，已统一归一化为毫秒。

## 运行编排与健康检查

- 运行编排由 `GridOrchestrator` 统一驱动，负责维护调度（撤单超时与对账）与健康检查输出。
- 健康检查默认每 10 秒执行一次，仅在异常时输出 warning。
- 启动初期允许短暂无行情更新，避免误报。
- REST 请求遇到 429 时会进入退避窗口，减少短时间内的重复请求。

## 订单簿订阅与重试

- 订单簿订阅在序列异常或订阅中断时会触发重订阅。
- 为避免旧订阅残留消息混入，新订阅会生成新的版本号并丢弃旧消息。
- 序列异常时会清理本地订单簿状态，等待新快照恢复行情。

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
