# M1 真实模型与 OneBot 验证记录

2026-10-19。用户已提供本机 OneBot 服务、指定测试群和发送者，以及个人模型网关。凭据、真实身份与原始记录保存在忽略的本地运行目录，不进入本文件。

## 已完成的连接验证

- OneBot 服务报告 SnowLuma 1.11.1-node / OneBot v11。正向 WebSocket 与 HTTP 的 get_login_info 返回一致账号，指定群的 get_group_info 成功。
- 个人模型网关可发现指定 deepseek/deepseek-flash 路由，并完成一次真实文本请求。
- pi 1.3.0 使用独立 models.json/settings.json 与 MCP 配置，通过真实模型对 OneBot 模拟平台完成回复及不回复：回复读取 info、能力、原事件后调用 qq-main.reply，调用 succeeded，模拟平台收到1次正确 Action；不回复只读取 info/原事件，没有新增 Action。

## 待完成的真实消息验证

通过临时单次验证转发器，只接纳指定测试发送者在指定群发出的随机口令；只允许引用该原消息、使用固定文本的一次回复尝试。发送前持久保存尝试记录，不自动重发。Imbrex 的正式 Host、OneBot 插件、ACP Consumer、pi-acp、pi 和 MCP 路径保持不变。

真实入站、自动模型轮次、网关调用、平台响应与平台消息查询结果将在执行后填写。当前不能把上面的连接/模拟结果记为真实 QQ 闭环成功。
