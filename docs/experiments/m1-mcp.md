# M1-02 MCP Streamable HTTP 验证

2026-10-19。锁定 Node.js 24.22.0、npm 11.19.1、官方 @modelcontextprotocol/sdk 1.32.1。/v1/mcp 直接调用核心 services，采用 SDK 的 stateless JSON 响应模式。公开工具、参数与错误说明见 [Agent 接入](../agent-integration.md)。

新增测试在真实 Host、SQLite worker 和 HTTP 监听上运行官方 SDK Client，并使用独立字面量 HTTP 请求核验协议失败。执行：

    npm run typecheck
    npm run build
    node --test --test-timeout=10000 dist/test/host/mcp.test.js

上述检查通过，新增 3 项有风险依据的集成测试全部通过：

更新到包含 M1-01 的主线后，再执行 npm run check：类型检查与构建通过，56 tests / 56 pass / 0 fail。

- 大整数写入实际 SQLite 序号后，SDK 收到 9007199254740993 和 9007199254740994 的精确十进制字符串；Unicode 事件引用原样查询，读取范围不泄漏私有事件。
- 发现与执行分别鉴权，未授权主体不能通过直接工具名绕过权限；注册的数组参数 schema 原样发现并可执行；错存储、非法位置与伪造 caller 参数拒绝。
- 完整 initialize 与 SDK 工具发现可用；错误凭据、非法 Origin、协议版本、Accept、会话/恢复头、批请求及超大输入被拒绝，拒绝后服务仍可用。
- 外部写派发后主动中断 HTTP 响应，同一 call_id 保持 in_progress，改变参数得到 call_conflict，其他主体查不到记录；原调用最终为 unknown，重复调用不增加 handler 执行，插件卸载后仍可查询。

SDK 互通覆盖 T03/T05/T06 的 MCP 入口，不代替 pi 的实际模型调用或真实 QQ 发送。M1-03 继续接入 pi 自身的 MCP 配置，M1-04 再加入 ACP 自动消费；目前没有模型配置或真实 OneBot 服务凭据。
