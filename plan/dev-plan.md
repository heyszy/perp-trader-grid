# 开发方案

## 目标

- 在保持网格策略行为一致的前提下完成模块化迁移。
- 完成 `@zheyu/extended` SDK 接入，并具备多交易所扩展能力。
- 数据落库与对账流程可用，支持稳定运行与恢复。

## 任务清单

### 联调问题清单（逐项处理）

- [ ] REST 仓位接口触发 ZodError：待 SDK 侧修复字段兼容。
- [x] 跨档未成交且频繁撤单重挂：引入成交驱动平移 + mark 跨档确认窗口。
- [x] 交易对格式映射需统一抽象（如 GRID_SYMBOL=SOL -> SOL-USD），确认不同交易所的转换策略。

### 已完成

- 完善系统设计与策略讨论文档，明确 mark 价格与对称滑动网格方案。
- 完成基础模型与网格计算模块：
  - `src/shared/number.ts`
  - `src/core/exchange/models.ts`
  - `src/core/exchange/adapter.ts`
  - `src/core/grid/types.ts`
  - `src/core/grid/spacing.ts`
  - `src/core/grid/strategy.ts`
  - `src/core/grid/state.ts`
- 工程化初始化：
  - `package.json` / `tsconfig.json` / `tsconfig.paths.json`
  - `biome.json` / `vitest.config.ts`
  - `ecosystem.config.js`
  - 目录骨架与 `.gitkeep`
  - `.env.example`
- 已完成 `pnpm install` 依赖安装
- 完成环境变量加载与校验模块：
  - `src/infra/config/schema.ts`
  - `src/infra/config/env.ts`
  - 使用 zod 做配置校验
- 启动入口与脚本调整：
  - `src/index.ts` / `src/bootstrap/grid.ts`
  - 开发运行切换为 tsx
  - 构建产物统一为 `dist/index.js`
- 完成 Extended 适配器基础实现：
  - `src/infra/exchange/extended/extended-adapter.ts`
  - `src/infra/exchange/extended/extended-orderbook.ts`
  - `src/infra/exchange/extended/extended-client.ts`
  - `src/infra/exchange/extended/extended-context.ts`
  - `src/infra/exchange/extended/extended-utils.ts`
- 完成交易所装配与行情聚合：
  - `src/infra/exchange/factory.ts`
  - `src/app/grid-runtime.ts`
  - `src/services/market-data/market-data-service.ts`
- 接入网格订单管理器（行情驱动 + 对称滑动网格流程）：
  - `src/services/grid/grid-order-manager.ts`
- 接入基础风控能力：
  - `src/core/risk/position-guard.ts`
  - `src/core/exchange/order-status.ts`
  - `getNetPosition` 适配器能力
- 补齐撤单失败对账与订阅恢复：
  - 账户订阅中断自动重试
  - 撤单失败后拉取订单状态修正
- 补齐仓位订阅刷新与 post-only 穿价保护
- SQLite + Drizzle 单表 schema 与订单记录服务
- 运行编排完善（退出流程、健康检查等）与对账调度。

### 待完成

- Extended 适配器联调与验证（行情、mark、账户回报、下单/撤单/对账）。
- 补齐网格订单管理器的风控细节（更细粒度仓位限额、保证金约束等）。
- 同步依赖锁文件（`esbuild` 直依赖）。
- 测试与验收脚本（至少覆盖网格计算与平移逻辑）。

## 开发阶段与交付物

### 阶段一：工程化与基础能力

交付物：

- 基础工程结构与目录落地（与系统设计一致）。
- `package.json` + `pnpm` 管理依赖。
- `tsconfig` 配置与路径别名。
- `biome` 格式化与静态检查配置。
- `vitest` 基础测试框架配置。
- `tsx` 开发脚本与 `esbuild` 构建产物。
- 配置加载与环境变量校验（`.env` + `.env.example`）。
- 日志模块与统一输出格式。

验收点：

- 可启动进程并打印关键启动日志。
- 环境变量缺失时明确报错。

### 阶段二：领域核心与状态机

交付物：

- `core/grid`：策略、状态、订单管理器与订单工厂。
- `core/risk`：基础风控检查。
- 订单状态枚举与状态迁移规则。

验收点：

- 单元级别可验证策略计算与风控规则。
- 订单管理器可生成下单/撤单意图。

### 阶段三：交易所适配层与行情服务

交付物：

- `core/exchange` 接口与统一数据模型。
- `infra/exchange/extended` 适配器实现。
- 行情服务与报价标准化。
- 账户更新事件处理与订单状态更新。

验收点：

- 行情订阅可稳定输出 `ExchangeQuote`。
- 订单回报可推动状态流转。

### 阶段四：数据持久化与对账

交付物：

- SQLite + Drizzle 初始化与 `orders` 表 schema。
- 订单记录服务与仓储实现。
- 对账流程与修复机制。

验收点：

- 下单与回报状态准确落库。
- 对账可修复缺失状态。

### 阶段五：运行编排与稳定性

交付物：

- `app` 运行编排与定时调度。
- 订阅恢复与对账流程（依赖 SDK 自动重连）。
- 关键事件通知（可选）。

验收点：

- 重连后订阅能自动恢复，订单状态通过对账修复。
- 启动、运行、退出流程可控。

### 阶段六：清理与验收

交付物：

- 对照 `main` 分支 diff 清理“AI 代码杂质”。
- 补充关键流程的中文注释。
- 完整 `.env.example`。

验收点：

- 文档与实现一致。
- 无敏感信息提交。

## 工作分工建议（可选）

- 核心策略与状态机：`core/grid` / `core/risk`
- 交易所与行情：`core/exchange` / `infra/exchange` / `services/market-data`
- 数据落库与对账：`infra/db` / `services/recorder` / `app/reconcilers`
- 编排与稳定性：`app` / `bootstrap`

## 开发节奏与里程碑

- M1：脚手架与基础能力完成。
- M2：策略与订单管理器可运行。
- M3：Extended 行情与回报接入完成。
- M4：落库与对账可用。
- M5：稳定性与验收通过。

## 风险与对策

- SDK 行为差异：封装适配层并保留 mock 能力。
- WS 断线导致状态缺失：定时对账兜底。
- 步长与最小单位限制：统一在下单前取整处理。
- 单文件膨胀：严格模块拆分，必要时再拆子模块。

## 测试与验证建议

- 核心逻辑使用单元测试或最小可运行脚本验证。
- 行情与下单流程优先在测试网络验证。
- 对账流程在模拟丢包或断线场景下验证可恢复性。
