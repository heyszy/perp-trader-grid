# 网格策略实现方案（落地清单）

## 实现目标

- 按“对称滑动网格”实现：始终保持下 N 档 BUY、上 N 档 SELL。
- 中心价使用 mark 价格。
- 支持两种间距模式：绝对价差与几何百分比。
- 价格跨档即触发平移，`abs(steps) >= levels` 时全量重建。

## 任务分解

### 1) 配置与环境变量

- 新增配置项：
  - `GRID_SPACING_MODE`: `ABS` | `PERCENT`
  - `GRID_SPACING`: 绝对价差
  - `GRID_SPACING_PERCENT`: 几何百分比间距（如 `0.002` 表示 0.2%）
- 规则：
  - `GRID_SPACING_MODE=ABS` 时必须提供 `GRID_SPACING`
  - `GRID_SPACING_MODE=PERCENT` 时必须提供 `GRID_SPACING_PERCENT`
- 移除或弃用 `GRID_SHIFT_TRIGGER_LEVELS`（改为跨档触发平移）
- 更新 `.env.example` 与配置加载校验逻辑。

### 2) 交易所模型与行情数据

- `ExchangeQuote` 补充 `mark` 字段。
- `ExchangeCapabilities` 增加 `supportsMarkPrice`，由适配器明确能力。
- 行情服务统一输出包含 `mark` 的报价。
- 适配器不支持 mark 时处理策略需明确（启动失败或降级为 mid，需决策）。

### 3) 网格核心策略

- 新增 `GridSpacingMode` 与统一的价格计算函数：
  - 绝对价差：`price_i = center ± i * spacing`
  - 几何百分比：`price_i = center * (1 + p)^i`
- 跨档步数计算：
  - 绝对价差：`steps = floor(|mark - center| / spacing)`
  - 几何百分比：
    - 上涨：`steps = floor(log(mark / center) / log(1 + p))`
    - 下跌：`steps = -floor(log(center / mark) / log(1 + p))`
- 统一 `GridStrategy` 只负责计算与判定，不直接操作订单。

### 4) 网格状态管理

- `GridState` 重构为对称网格：
  - `buildLevels(center)` 生成对称 BUY/SELL 目标方向。
  - 平移时不继承旧 `targetSide`，始终重建为对称结构。
- 支持订单重映射：
  - 根据新中心价重新计算订单的 `levelIndex`。
  - 超出范围或方向不匹配的订单进入待撤单队列。

### 5) 订单管理器调整

- 使用 `mark` 作为中心价与平移依据。
- 取消“成交后改挂反向单”的逻辑，成交仅更新状态。
- 平移流程：
  - `steps !== 0` 触发平移
  - `abs(steps) >= levels` 执行全量重建：撤销所有未终态订单 → 重建对称网格 → 补单
  - `abs(steps) < levels` 执行局部平移：重算中心与档位 → 撤掉不匹配订单 → 补齐缺失档位
- 下单逻辑维持原有风控约束（`maxPosition` / `maxOpenOrders` / `postOnly`）。

### 6) 对账与异常处理

- 对账仍以 WS 为主、REST 为辅，保持 UNKNOWN 修复逻辑。
- 全量重建后，旧订单状态更新只写 DB，不再影响当前网格状态。

### 7) 测试与验证（最小集合）

- 单元验证：
  - 绝对价差与几何百分比的档位计算与跨档步数计算。
  - 平移与重建阈值判断。
- 运行验证：
  - mark 价格驱动平移与补单行为符合对称结构。

## 关键变更点说明

- 取消 `GRID_SHIFT_TRIGGER_LEVELS`：改为“跨档即平移”。
- 不再依赖成交后修改 `targetSide`，网格结构保持对称。
- mark 作为唯一中心价来源，避免 mid 噪声。

## 需要最终确认

- 交易所必须支持 mark 价格；不支持 mark 的交易所不接入。
