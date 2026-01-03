# perp-trader-grid 开发协作指引

## 项目目标与范围

- 保持功能行为一致，优先考虑可维护性与可扩展性。
- 相关技术细节与系统设计以 `plan/` 文档为准。

## 开发规范

修改代码后请执行以下操作：
- 运行 `npm run typecheck` 检查类型
- 运行 `npm run format` 格式化代码
- 运行 `npm run lint` 检查代码风格
- 每一次代码修改都需要按照实际情况更新 `README.md`
- 如果开发中遇到 SDK 相关问题，请反馈，不要直接尝试解决
- NADO 交易所文档可调用 MCP 服务，Typescript SDK 源码可以查看 '～/Project/perp/refer/nado-typescript-sdk'。

完成 plans/ 中的任务后更新 plans/ 中的计划，标记为完成。

## 交付与验收

- 重要逻辑变更需说明验证方式与结果。
- 文档与实现保持一致，避免信息漂移。

## 提交规范

commit message 使用中文，提交规范参考 [COMMIT_CONVENTION](COMMIT_CONVENTION.md)。
