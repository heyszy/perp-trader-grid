# Commit 规范

## 格式

```
<type>(<scope>): <subject>
```

- `type` 必填，表示变更类型。
- `scope` 可选，表示影响范围/模块。
- `subject` 必填，使用中文动词开头，简短清晰，不以句号结尾。

## type 列表

- `feat`：新功能
- `fix`：修复缺陷
- `docs`：文档变更
- `style`：仅格式调整（不影响逻辑）
- `refactor`：重构（不新增功能或修复缺陷）
- `perf`：性能优化
- `test`：测试相关
- `chore`：杂项维护（工具、脚本、配置等）
- `build`：构建系统或依赖变更
- `ci`：CI 配置变更
- `revert`：回滚提交

## scope 建议

优先使用模块名：`api`、`client`、`config`、`errors`、`models`、`schemas`、`signing`、`transport`、`utils`。  
跨模块或工程性修改可使用：`build`、`deps`、`release`、`types`，或省略 `scope`。

## 破坏性变更

在 `type` 后添加 `!`，并在页脚注明：

```
BREAKING CHANGE: <说明>
```

## 示例

- `feat(client): 添加 WebSocket 自动重连`
- `fix(transport): 修复超时后未清理定时器`
- `docs: 补充 Extended API 使用示例`
- `chore(deps): 升级 ethers 到 6.15.0`
