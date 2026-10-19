# M1-05 接入与人工恢复记录

2026-10-19。离线 Consumer 恢复入口和模拟恢复已验证；用户提供接入条件后，指定群单次真实闭环也已通过，见[真实记录](m1-live.md)。本页保留恢复操作、接入步骤与尚未覆盖的真实场景。

## 离线恢复命令

先构建 npm run build。查看完整参数：

    npm --silent run consumer:recover -- --help

恢复操作统一使用 --silent 关闭 npm 自身的命令参数回显；普通 npm run 会将 --reason 的内容打印到 stdout。也可直接运行 node dist/src/cli/recover.js，参数相同。此处的输出脱敏不代替对本地命令历史和进程参数的访问控制，原因中仍不得包含凭据或消息全文。

Consumer 暂停时，先在宿主仍可查询期间，用原 Agent 主体通过 imbrex_get_call 或现有单条 calls HTTP 接口查询实际 store_id/call_id，并核对 Agent 会话和平台接收记录。operator 没有跨主体调用查询权限；猜测的 call_id 查询不到不表示没有发送。无法建立输入与调用关联时保持未确认。

然后正常停止整个宿主，确认其 Agent、监督进程及 tini 已退出。命令会取得 data_dir/.lock；仅停用插件而保持宿主运行会被拒绝。不要删除锁文件。私有状态位于 data_dir/plugins/<instance>/consumer-state.json。恢复参数 --data-dir 相对当前工作目录解析，必须指向宿主实际的数据目录。

从已核验记录中设置 EXPECTED_STORE_ID 和 EXPECTED_PENDING_SEQ，后者必须是当前 in_flight.seq 的规范十进制字符串。确认本条已处理后执行：

    npm --silent run consumer:recover -- \
      --data-dir data/acp --instance agent \
      --store-id "$EXPECTED_STORE_ID" --seq "$EXPECTED_PENDING_SEQ" \
      --action processed --reason '已核对原调用与会话记录，确认本条处理结束'

明确放弃该输入、并为它的会话选择新的 ACP session：

    npm --silent run consumer:recover -- \
      --data-dir data/acp --instance agent \
      --store-id "$EXPECTED_STORE_ID" --seq "$EXPECTED_PENDING_SEQ" \
      --action abandoned --new-session --reason '保留未知调用，放弃本条自动处理并启用新会话'

两种处置都只推进到保存的未决 seq 并清除 in_flight；不会修改 calls、补发或重跑模型。--new-session 只删除该输入所属会话的映射，其他映射保留。需为新的明确意图发送时另按能力契约操作，不能把 abandoned 当作重试开关。

Agent 不支持恢复旧 session，或操作者决定全部重新建会话时，必须已无 in_flight，并用当前 last_seq 作为 EXPECTED_LAST_SEQ：

    npm --silent run consumer:recover -- \
      --data-dir data/acp --instance agent \
      --store-id "$EXPECTED_STORE_ID" --seq "$EXPECTED_LAST_SEQ" \
      --action reset-sessions --reason '原会话不可恢复，保留进度并显式重新建立会话'

reset-sessions 清空全部会话关联和观察到的 Agent 名称/版本，保留消费位置、输入选择、主体与程序/工作目录绑定。命令不负责更换存储、调整读取范围、回退位置或修复损坏状态；这些情况仍须按应用恢复规则确定新起点。

## 持久记录与错误

恢复命令只读打开现有 SQLite，不执行普通启动时的 in_progress → unknown 恢复。它核对 schema_version=1、store_id、last_seq/in_flight 及未决事件真实序号。输入位置、会话关联或实际事件不一致时拒绝。

更新前先在 plugins/<instance>/recovery/<operation_id>.json 保存准备记录：version=1、operation_id、prepared_at、operator_uid、instance、action、new_session、expected_seq、reason 和 before（完整旧状态）。目录权限 0700，文件权限 0600；先写临时文件、fsync、rename、同步目录，再用同样顺序替换状态。reason 是非空的、最多 2048 UTF-8 字节的处置说明，保存在本地私有记录中，不能写入凭据或消息全文。

备份记录只证明已准备处置，不能单独证明状态已经替换。成功返回 consumer_recovered、最终 last_seq 和相对数据目录的 backup 路径；不输出原因、会话或消息正文。退出码 0 表示完成，75 表示实例锁正在使用，其他失败为 1。

| 错误码 | 处理 |
| --- | --- |
| recovery_invalid_arguments | 核对必填参数、规范十进制序号和非空原因 |
| recovery_state_invalid / recovery_store_unavailable | 保留原文件，核对格式、路径和数据库可读性，禁止自动重置 |
| recovery_store_mismatch / recovery_position_mismatch / recovery_event_mismatch | 对照实际存储和状态重新核验，命令没有推进进度 |
| recovery_backup_write_failed | 备份未确认持久保存，命令未开始替换状态；检查磁盘与私有目录权限 |
| recovery_state_write_uncertain | 备份已保存，但状态替换/目录同步失败；按返回路径检查备份和当前文件，不能盲目重试或复制旧状态回去 |

进程被信号中断、命令输出丢失或磁盘故障也可能发生在状态替换之后；同样先核对当前 last_seq/in_flight 和准备记录。普通完成后再次提交旧未决 seq 会被拒绝。此流程不保证断电或磁盘损坏恢复，也不消除平台 unknown。

## 可复现的模拟验证

环境沿用 Node.js 24.22.0 / npm 11.19.1、Linux flock、tini 0.19.0。自动化验证命令：

    npm run check

针对锁竞争、错误 store_id/位置、错误事件关联、备份失败、路径重定向和 session 重置编写实际 CLI 测试。调用表包含 in_progress 的对照记录，用于确认恢复工具没有运行普通数据库启动恢复。ACP 集成演练覆盖 unknown 工具结果后 Agent 中断、人工放弃并显式换会话、重启仅处理新输入。

基于已合入 M1-04 的主线执行 npm ci、npm run check：类型检查与构建通过，97 tests / 97 pass / 0 fail。其中新增6项恢复 CLI 测试和1项完整模拟恢复演练。演练保留原 unknown 调用，旧输入重复上报后 Action 仍为1次，新输入通过新 session 完成后 Action 合计2次；检查点与新事件实际 seq 一致，不假定序号连续。npm --silent run consumer:recover -- --help 也实际执行通过。

独立审查复现 npm 普通运行时回显处置原因后，已将6项 CLI 测试改为实际调用文档中的 npm --silent run 入口，检查 stdout/stderr 均无原因正文、备份仍保存完整原因，避免只测试下层 Node 入口。

## 真实接入准备

| 必需信息 | 本次状态 |
| --- | --- |
| OneBot 服务实现、精确版本、正向通用 WebSocket 地址与认证配置路径 | 已提供并连通 SnowLuma 1.11.1-node / v11；实际配置保留本地 |
| 账号与 identity_namespace、允许测试的群聊/私聊、旧消息策略 | 已授权指定群/发送者的一条测试回复；仍使用实时输入与5分钟年龄限制 |
| pi 1.3.0 / pi-acp 0.0.34 的有效模型配置、模型权限与 MCP 配置路径 | 已配置并验证指定 deepseek/deepseek-flash 模型及 MCP/ACP 路径 |

在项目忽略的 data/ 下生成本地配置，从 examples/agent/acp.json 开始，按 [ACP 运行记录](m1-acp.md) 设置 Agent 绝对工作目录及环境变量名称。先保持 external_writes_enabled=false。OneBot 的 ws_url/account_id/identity_namespace、允许会话、Consumer source_prefix 和 Agent read_sources 必须指向同一个获准范围；切换服务身份时使用显式新命名空间，不复用未证实连续的原生消息身份。

真实凭据通过环境变量或 Agent 自己的配置提供，不粘贴到 PR 或聊天。公开记录只保留一致脱敏的账号/会话/事件/调用标识、版本及结果，真实配置与消息不纳入 Git。

## 分阶段真实验收

1. 在模拟 OneBot 上按 [M1-03](m1-pi.md) 运行真实 pi，分别验证上下文读取、回复和不回复。保留 MCP 实际调用与 Action 记录，不能只记录工具发现成功。
2. 切换到已授权的真实 OneBot，先禁写核验账号元数据、入站映射、范围过滤、重复输入与断线重连。此阶段不开自动回复。
3. 明确启用约定范围的外部写，在模拟平台的真实 pi 手动阶段通过后，验证真实 QQ 新输入由 ACP 自动触发。对不应回复的输入同时检查模型记录、calls 与平台 Action。
4. 对已授权的测试输入验证会话隔离、旧消息与自发回流过滤。核对恢复/重启前后 prompt 次数和 call_id，而不仅看界面有无响应。
5. 只有受控故障演练获准时才制造丢响应/中断。保存 unknown 与原 call_id，核验真实平台，再按上面的停机恢复命令处置；不得为了让结果成功而自动换 ID 重发。

| 验收项 | 应保存的证据 | 当前结果 |
| --- | --- | --- |
| 真实 pi 对模拟平台回复 / 不回复 | 模型版本、MCP 调用、Action 次数与目标 | 已通过；回复1次，不回复无新增 Action |
| 真实 QQ 入站与成功回复 | 实现版本、输入 source/id/seq、store_id/caller_id/call_id、平台返回及接收证据 | 指定群单次自动回复已通过，平台 get_msg 核验成功 |
| 真实 Agent 不回复 | 本轮结束记录、对应期间无回复调用/Action | 模型在模拟平台已验证；真实群未另行执行 |
| 真实会话隔离与重启 | 不同会话 session 关联、恢复能力、前后 prompt/Action 对照 | 本轮真实验证仅1个 session；多会话/重启仍保留模拟证据 |
| 真实 unknown 与人工核验 | 原调用状态、平台证据、准备备份与恢复后状态 | 真实服务故障演练未执行；已有模拟 unknown 与人工恢复证据 |

已执行项的实际对应关系见真实记录；其余场景保持未验证，不用模拟结果、其他 OneBot 实现或 ACP end_turn 替代。
