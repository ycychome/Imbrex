# M1 真实模型与 OneBot 验证记录

2026-10-19。用户已提供本机 OneBot 服务、指定测试群和发送者，以及个人模型网关。凭据、真实身份与原始记录保存在忽略的本地运行目录，不进入本文件。

## 已完成的连接验证

- OneBot 服务报告 SnowLuma 1.11.1-node / OneBot v11。正向 WebSocket 与 HTTP 的 get_login_info 返回一致账号，指定群的 get_group_info 成功。
- 个人模型网关可发现指定 deepseek/deepseek-flash 路由，并完成一次真实文本请求。
- pi 1.3.0 使用独立 models.json/settings.json 与 MCP 配置，通过真实模型对 OneBot 模拟平台完成回复及不回复：回复读取 info、能力、原事件后调用 qq-main.reply，调用 succeeded，模拟平台收到1次正确 Action；不回复只读取 info/原事件，没有新增 Action。

## 真实消息验证结果

运行代码基线为 99f35571dc2a50492ecc461684e15950374aa750，使用 Node.js 24.22.0 / npm 11.19.1、tini 0.19.0、pi 1.3.0、pi-acp 0.0.34、ACP SDK 1.9.0 和 MCP SDK 1.32.1。只更新本次验证记录，没有修改产品代码。

通过临时单次验证转发器，只接纳指定测试发送者在指定群发出的随机口令；只允许引用该原消息、使用固定文本的一次回复尝试。发送前持久保存尝试记录，不自动重发。转发器是本次实验的范围与次数限制，不是产品组件；它不合成输入、不模拟平台响应，也不是正式启动依赖。Imbrex 的正式 Host、OneBot 插件、ACP Consumer、pi-acp、pi 和 MCP 路径保持不变。

操作者在真实 QQ 群中发送口令后，完成以下链路：

    QQ 原始群消息 → 正向 WS → Imbrex OneBot 连接器 → SQLite 事件
    → ACP Consumer → pi-acp → pi / deepseek/deepseek-flash
    → Imbrex MCP → qq-main.reply → OneBot send_group_msg → 平台消息查询

公开记录使用 Bot-A、Group-A、Sender-A、Event-A、Store-A、Call-A 等一致别名。私有记录保存实际原生消息 ID、source/id/seq、store_id/caller_id/call_id、Agent session 与平台返回的对应关系。

| 检查 | 实际结果 |
| --- | --- |
| 来源身份与范围 | WS 与 HTTP 的机器人身份一致；入站的机器人、群与发送者均匹配获准范围 |
| 真实入站 | 保存1条真实原事件 Event-A，seq="1"；不是人工写入网关的模拟事件 |
| 真实 Agent | pi 会话记录使用 personal/deepseek/deepseek-flash；ACP 报告 pi-acp 0.0.34，1个 session |
| 实际工具调用 | imbrex_info → imbrex_list_capabilities → imbrex_lookup_event → imbrex_invoke |
| 回复身份 | params.input_event_ref 等于 Event-A；稳定 call_id 等于预先约定的 Call-A；正文等于约定测试文本 |
| 核心调用与发送 | calls 中只有1条调用，status=succeeded；平台发送尝试1次，门禁拒绝0次 |
| 平台核验 | OneBot get_msg 成功，返回的发送者为 Bot-A、群为 Group-A、消息 ID 与调用结果 native_message_id 一致，文本匹配 |
| 消费完成 | last_seq="1"、in_flight=null；完成状态与本次事件一致 |
| 收尾 | 测试 Host 已退出，未发现该测试工作目录下遗留 Agent；测试实例已停止 |

这证明指定服务、指定群、指定发送者与当前版本组合的一次真实自动回复。结论不只来自 Agent 的 end_turn，而同时核对了事件、调用记录、OneBot 响应和平台消息。

## 有效配置要点

- pi 使用独立的 models.json，provider 名称为 personal，api=openai-completions，model ID 为 deepseek/deepseek-flash，baseUrl 指向用户的本地个人网关。该网关无 Token 鉴权；pi 的模型登记使用非秘密占位值使模型可选，不把它当成真实服务凭据。
- settings.json 选择同一个 provider/model，defaultThinkingLevel=off、defaultTools=[]。内置文件/命令工具未启用，MCP 工具仍可用。模型会话中的实际选择已核对，而非只检查配置文本。
- HOME 与 PI_CODING_AGENT_DIR 都使用独立运行目录，隔离 pi 配置与 pi-acp 的用户级 session-map，不改用户已有 Agent 配置。
- MCP 使用 Imbrex 专用主体 Token；读取规则限定到 Group-A 的完整 source，仅允许 qq-main.reply 与本主体调用查询。OneBot 上游凭据不传给模型。
- 使用 examples/agent/acp.json 的正式宿主/插件结构与公开 CLI，先完成 MCP 监听与 ACP 握手，再让操作者发出新口令。Token、账号、群号、模型地址和实际目录由部署者填写，不纳入公开模板。

模拟平台的真实 pi 步骤仍按 [M1-03](m1-pi.md) 的 reply/no-reply 材料运行。正式配置和启动流程见 [ACP 运行记录](m1-acp.md)，人工恢复见 [M1-05](m1-operations.md)。

## 仍未覆盖的真实场景

本次只授权一条测试回复，完成后停止测试实例，没有部署常驻自动回复。真实多会话切换、真实 Agent 重启后 session/load、真实服务断线/丢响应的 unknown 演练，以及对真实未决输入执行人工恢复，均未在本轮执行；这些机制目前保留既有模拟与故障测试证据。真实“不回复”也没有另向 QQ 群投递测试输入，已验证的是模型在模拟平台上的不回复路径。

未验证其他 OneBot 实现、私聊、附件、历史补取、全部自发回流或长期运行可靠性；不得把本次单轮记录扩大为这些兼容承诺。
