# M1-03 pi 接入与手动演示

2026-10-19。实际运行 pi 1.3.0、pi-acp 0.0.34、Node.js 24.22.0、npm 11.19.1。在独立配置目录中，真实 pi mcp list --json 已连接 Imbrex 的 /v1/mcp，返回 connected、六个预期工具和空 errors。MCP 配置确实被 pi 读取，未仅依靠上游文档声明。

另以官方 ACP SDK 1.9.0 对真实 pi-acp 0.0.34 执行 initialize，确认协议版本 1、loadSession=true、mcpCapabilities.http/sse=false；握手后进程正常退出（exit 0）。没有执行 session/new、模型 prompt 或真实 QQ 发送；用户目前尚无模型配置与 OneBot 服务。

## 准备运行环境

从仓库根目录、使用锁定 Node/npm 执行：

    npm ci
    npm run build
    export IMBREX_AGENT_TOOLS="$PWD/data/agent-tools"
    npm install --prefix "$IMBREX_AGENT_TOOLS" --save-exact @earendil-works/pi-coding-agent@1.3.0 pi-acp@0.0.34
    export PATH="$IMBREX_AGENT_TOOLS/node_modules/.bin:$PATH"
    pi --version

Agent 是独立程序，不作为网关的运行时依赖。MCP 参考配置位于 examples/agent/mcp.json，凭据从 IMBREX_QQ_AGENT_TOKEN 取值。实际环境可使用 pi mcp add 合并配置：

    pi mcp add imbrex --url http://127.0.0.1:8080/v1/mcp --bearer-token-env-var IMBREX_QQ_AGENT_TOKEN --exposure direct
    pi mcp list --json

需要独立 Agent 配置时，在执行 pi 命令前把 PI_CODING_AGENT_DIR 指向专用绝对目录，在该目录对应的 pi 环境中配置模型。pi-acp 0.0.34 的会话映射仍写入其用户级 .pi/pi-acp/session-map.json，不受此环境变量隔离；正式部署为此 Agent 选择专用运行用户与工作目录。

## 检查连接

先按 [OneBot 模拟说明](m1-onebot.md) 启动模拟器和 Imbrex，确保当前终端有同一个 IMBREX_QQ_AGENT_TOKEN。执行：

    node dist/examples/agent/check-pi.js http://127.0.0.1:8080/v1/mcp pi

此脚本创建临时 pi MCP 配置，用真实 pi 检查版本和工具发现，结束时清理；只查询协议能力，不需要模型凭据、不调用 reply。成功输出包含 state=connected、六个工具和 model_turn=not_tested。可以把最后的 pi 换成已安装可执行文件的绝对路径；远程端点须用 HTTPS。

已对实际 Imbrex/模拟器端口运行此脚本：pi 1.3.0 返回 connected 与六个工具；错误凭据 exit 1，不输出凭据；两条路径均清理临时目录。npm run check 类型检查、构建及57/57既有测试通过，未为文档或常量添加测试。

## 手动回复与不回复

模型配置就绪后执行这两项验收。先确认自己运行的是本地模拟服务，并在专用 Imbrex 配置副本中将 external_writes_enabled 设为 true；来源账号、会话、namespace 保持模拟配置。data_dir 相对配置文件解析，复制配置时显式填写数据目录。

示例默认数据目录为已忽略的 data/onebot。若已有旧 data-onebot 数据，配置副本应继续显式指向原目录；切换目录会产生新的 store_id，需要按恢复规则核对。

1. 在模拟器输入 group。使用具备模型的 pi 会话提交 examples/agent/reply.md 的内容；核对返回的 store_id、call_id=m1-manual-reply-001 与状态。模拟器 actions 应出现一次 send_group_msg，group_id=987654，reply.id=-42，text 为给定文本。用同一主体查询原调用，重复该意图不应增加 Action。
2. 在模拟器输入 private，记录 actions 当前数量。向 pi 提交 examples/agent/no-reply.md；确认它确实读取原事件，并且 Action 数量没有增加。
3. 保留实际 pi/模型标识、store_id、caller_id=qq-agent、call_id 与对应模拟 Action 的关联证据。unknown 不记录为成功，不更换 ID 自动补发；原调用使用 qq-agent 的凭据查询，operator 无跨主体调用权限。

固定模拟事件和 call_id 用于可核验的演示。已有数据中的同一身份保持原内容；需要新实验时选择独立数据目录和明确意图，不能通过清空状态绕过 unknown。pi 1.3.0 的 HTTP 客户端可能对网络错误重试同一请求，网关依靠相同 call_id 去重；模型生成新 call_id 仍是新意图，提示中明确禁止自动这样做。

## 尚未完成的验收

| 项目 | 当前证据 |
| --- | --- |
| 真实 pi 读取配置、连接 MCP 并发现工具 | 已通过，六个工具全部可见 |
| pi-acp 的真实 initialize 与退出 | 已通过；没有创建模型会话 |
| 模型读取模拟输入并通过 MCP 发出 reply | 待模型配置后验证 |
| 模型选择不回复，模拟器无新增 Action | 待模型配置后验证 |
| 真实 QQ → Agent → reply | 待 OneBot 服务、授权会话与模型配置后验证 |

前两项不代替后三项。M1-04 可继续实现 ACP 自动消费与故障恢复的独立模拟验证；M1-03 的模型轮次保持待验收。
