# M1-01 OneBot 标准子集与模拟验证

2026-10-19。实现位于 src/plugins/onebot-v11/；协议依据为 botuniverse/onebot-11 的 d4456ee706f9ada9c2dfde56a2bcfc69752600e4，核对 communication/ws.md、authorization.md、api/public.md、event/message.md、message/segment.md。此记录只证明协议子集，不声明 NapCat、SnowLuma 的真实运行兼容。

验证环境采用仓库锁定 Node.js 24.22.0、npm 11.19.1 与 ws 8.22.0。执行 npm run check（类型检查、构建和全部测试）。新增用例验证两组独立字面量夹具（数值 ID/数组消息与字符串 ID/CQ 消息）、可信引用与 caller 权限、显式文本 Action、重复输入/调用、unknown/failed、身份变化、超限帧、队列溢出与停用重启。既有核心测试继续覆盖外部写开关和调用持久化。

本次完整检查 53/53 通过。实际启动模拟器和公开 CLI 后，group 输入得到 succeeded、native_message_id=1001；同一 call_id 重复调用复用结果。CI 首次运行发现旧能力测试默认 100 ms 与 Worker I/O 竞争，已将非超时用例的测试预算改为 5 秒；专门的超时用例仍显式使用短预算。

## 本地模拟操作

先 npm ci && npm run build。终端一执行 node dist/examples/onebot/simulator.js。它仅监听本地 6700，命令 group/private 推送固定测试输入，重复执行会推送同一事件；actions 显示收到的 Action；disconnect 模拟断线，quit 退出。

终端二设置 IMBREX_QQ_AGENT_TOKEN 与 IMBREX_OPERATOR_TOKEN（使用自行生成的测试值），执行 node dist/src/cli/start.js --config examples/onebot/imbrex.json。示例默认 external_writes_enabled=false；只在模拟服务上验证发送时将自己的配置副本改为 true。配置中的 data_dir 相对于配置文件所在目录解析。

使用 Agent token 访问 GET /v1/info，取得 store_id；GET /v1/events?store_id=…&after_seq=0 查询输入。发送 POST /v1/capabilities/qq-main.reply/invoke，输入 store_id、稳定 call_id=manual-intent-001 和 params。params 的 input_event_ref 为 source=imbrex://qq/123456/main/group/987654、id=message:-42，text 为模拟回复内容。

请求使用 Authorization: Bearer 和 Content-Type: application/json。成功时 call.status=succeeded，result.native_message_id 为字符串；终端一 actions 应显示 send_group_msg、group_id=987654 和 reply/text 数组。重复同一 call_id/参数不增加 Action。使用 GET /v1/calls/manual-intent-001?store_id=… 查询本主体记录；unknown 需要人工核验，不更换 ID 自动补发。

## 真实接入前仍需的证据

用户目前没有 OneBot 服务及许可测试会话，也没有提供模型配置。实际接入必须补齐实现版本、完整通用 WS 地址、认证环境变量、账号、允许群聊/私聊、identity_namespace，并采用新的插件实例与匹配来源权限。外部写只针对这些已授权会话打开。真实账号的收发、自发回流、断线缺口、实现切换与未知结果恢复仍未验证；后续 M1-05 记录真实证据。Token、真实会话内容不写入仓库。
