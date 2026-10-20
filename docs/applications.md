# 应用消费、Agent Chat 与恢复

统一开发基线 0.3 · 2026-10-19。M0 演示消费者与 M1-04 ACP Consumer 已实现，模拟链路与故障验证见[运行记录](experiments/m1-acp.md)，真实模型与指定群的单次自动回复已通过，范围见[实测记录](experiments/m1-live.md)。Agent 协议分工见 [Agent 接入](agent-integration.md)，读取规则见[事件与存储](storage-and-recovery.md)，动作结果见[能力契约](capabilities.md)。

2026-10-20 定稿的 M2 将 acp-consumer 更名为 agent-chat；第 10—12 节定义待实现的观测、在线恢复和配置应用。当前 M1 的离线恢复与状态格式仍有效，不将目标能力视为已上线。

## 1. 三种消费方式

| 方式 | 用途 | 应用承担的代价 |
| --- | --- | --- |
| 临时事件通知 | 控制台显示、短时指标 | 停用、断线或通知失败期间可能漏过，无恢复承诺 |
| 主动读取 + 本地位置 | 简单脚本、可重复计算任务 | 位置保存与业务操作之间可能存在重做或漏做窗口 |
| 读取 + 持久处理状态 | ACP Consumer、需要恢复的变换应用 | 保存本应用需要的责任状态，区分可重做与未决输入 |

插件和外部应用都可自主选择。通知只唤醒读取，不代替持久接手；应用不需要注册 purpose、subscription 或 B1，也没有网关 ACK。

## 2. 输入范围和起点

读取器状态包含 input_id、store_id、source_prefix/type 等实际选择、last_seq。input_id 是应用内部稳定名称，不是网关消费者资源。

新实例先取得 info。面向实时回复的 Consumer 默认把当时 latest_seq 作为起点，并原子保存这个明确边界；后续消息从该边界继续读。历史上下文单独查询，不能当作新的触发输入。演示变换和观察器可显式从 0 开始。

恢复使用保存的 store_id/last_seq，不因再次启动而跳到 now。store_mismatch、position_ahead、读取错误或状态损坏使输入暂停并报告，不自动重置。读取选择、来源身份或授权范围改变时，旧位置只代表旧范围；当前 M1 不允许静默套用旧绑定。M2 仅为受控 filter 修改提供第 12 节的边界应用流程，其余身份/授权变更仍须明确处理。

## 3. ACP Consumer 的最少状态

`src/plugins/acp-consumer/` 是普通消费者插件，按绑定 API 读取事件，再通过 ACP 向现成 Agent 提交输入。首版每个插件实例串行处理一条输入；模型循环、回复内容、上下文裁剪和历史持久化归 Agent，不另建参考 Agent 决策库。

插件使用 `api.dataDir/consumer-state.json` 保存以下元数据；文件内位置使用十进制字符串，内存读取 API 仍使用 bigint。

| 状态 | 最少保存的内容与含义 |
| --- | --- |
| 输入进度 | input_id、store_id、实际选择范围、last_seq；表示已完成或已按明确规则跳过的前缀 |
| 会话关联 | 可信平台会话 → ACP sessionId，以及对应 Agent 程序/工作目录绑定；不复制 Agent 历史 |
| in_flight | 当前尚未确认完成的 source/id/seq、平台会话和 ACP sessionId；正常处理中也存在，不能单凭非空判断异常 |

同一份状态的替换必须原子、持久完成：写临时文件并同步，替换正式文件并同步目录；实现时核验目标文件系统的行为。写入失败不得继续提交 prompt。文件不可用或损坏时拒绝静默从头/从现在恢复。进程中断验证不等于断电耐久证明。

会话键来自可信连接器事件。OneBot v11 可使用包含账号、identity_namespace、group/private 与会话 ID 的完整 source，不能仅用群号，也不能让模型提供会话键。更换存储、Agent 程序或工作目录后不得直接套用旧 sessionId，恢复规则见 [ACP 接入](agent-integration.md)。

## 4. 一条输入的处理顺序

1. 拉取有界一页，按顺序处理。检查允许来源、入站方向和事件年龄；明确跳过的输入可保存进度，不向 Agent 提交。
2. 为有效输入取得或恢复所属 ACP 会话，持久保存会话关联。准备受控输入：原事件引用、内容及所需上下文入口。
3. 在写入 `session/prompt` 前，持久保存该输入的 in_flight。只要该标记存在，就不能处理下一条输入或自动重发这一轮。
4. 发送内容块数组形式的 prompt。写入 stdin、收到 `session/update` 或工具活动通知均不代表本轮完成。
5. 收到该次请求正常的最终响应 `stopReason: "end_turn"` 后，在一次状态替换中将 last_seq 推进到该输入并清除 in_flight。保存失败保留未决责任并暂停。
6. ACP 断开、进程退出、超时、取消、其他停止原因或最终结果不可判定时，保留 in_flight，报告 `available=false` 与 `consumer_in_flight_unconfirmed`，不继续投递。

`end_turn` 只表明这轮 Agent 交互结束，可以包含未回复、成功、失败或 unknown 的工具结果；它不证明 QQ 已发送成功。工具结果的权威仍是网关 calls。已记录 unknown 保持待核验，不因本轮结束而自动补发；Consumer 不以重跑 prompt 作为工具重试方式。

完成一页所有匹配输入后，才把 last_seq 推进到 next_after_seq，越过已完整查询的空隙；空页也只在成功读取后推进。中途退出只保留已完成的前缀，不能预先保存整页末尾。

调用方为外部写提供稳定 call_id；同一意图的重试或查询保留该 ID 和参数。重跑整轮 Agent 可能生成新的 call_id，核心去重不能使这种重跑安全。ACP 请求 ID、ACP 工具活动 ID 与 Imbrex call_id 也不能相互替代。

## 5. 中断和人工恢复

| 中断点 | 恢复行为 |
| --- | --- |
| in_flight 尚未持久保存，且未发送 prompt | 从旧位置重新读取，可再次筛选输入 |
| in_flight 已保存，但 prompt 可能尚未写出 | 仍暂停；不凭“看起来还没发送”自动重投 |
| Agent 已调用工具，但最终响应未到或进度未保存 | 保留 in_flight，暂停并人工核验，禁止重新运行模型来补回复 |
| 正常结束与进度已原子保存 | 从新的 last_seq 继续，不重复触发旧输入 |
| 网关调用状态为 unknown | 保留原记录，停止自动补发，不生成新 ID 绕过去重 |
| Agent 或网关状态被更换/回滚 | 明确暂停，不声称跨回滚无重复 |

暂停是插件可用性与输入责任状态，不新增 Cordis 的 suspended 状态。诊断应能定位 input_id 与未决事件引用；公开记录对账号和消息标识一致脱敏，不打印正文或凭据。

人工恢复先停用 Consumer 并确认其 Agent 工作已停止，备份当前状态，核对 store_id、输入范围、会话与未决 source/id/seq。结合 Agent 的实际会话记录、调用记录及必要的平台证据判断发生了什么。M1 演示须保留实际调用的 store_id、caller_id、call_id 关联；缺少关联时保持未确认，不能把查不到某个猜测的 ID 当作未发送。

现有查询是 `GET /v1/calls/{call_id}?store_id=...`，只允许调用所属主体查询；没有 `GET /v1/calls` 全量列表。M1 使用对应 Agent 主体凭据或其受权 MCP 查询入口。M2 的跨主体调用审计使用显式 admin:inspect 的独立管理入口，不自动扩大现有 operator/Agent 权限。

操作者明确选择确认已处理或放弃该输入后，记录处置原因，并在 Consumer 停止期间原子更新该输入的 last_seq、清除 in_flight；不得借此跳过其他未处理输入。需要补发时按[能力契约](capabilities.md)显式建立新意图并关联旧记录，不让 Consumer 自动重播旧 prompt。不支持恢复旧 ACP 会话时，需明确选择新会话再恢复运行。

已提供 npm --silent run consumer:recover 的离线入口，实际命令见[恢复记录](experiments/m1-operations.md)。必须停止整个宿主并取得同一 data_dir/.lock；核对指定 store_id、未决 seq、事件引用与会话关联后，先持久保存含原因的私有备份，再一次替换状态。processed 与 abandoned 都只推进当前未决输入；--new-session 仅移除该会话映射。reset-sessions 仅在没有未决输入且指定 seq 等于 last_seq 时清空会话，位置不变。命令不执行模型、能力或 SQLite 调用恢复，也不修改读取/Agent 绑定。状态替换后发生同步错误时，需检查当前文件与备份，不能盲目重试。

## 6. 历史、积压与循环

Consumer 只对连接器映射的允许入站消息触发。自己发送的回流、派生分析和诊断事件可作为上下文，默认不触发；不能仅靠 prompt 要求模型不要循环。

配置必须给出自动回复最大事件年龄。测试默认 5 分钟；按可信来源时间判断，来源时间缺失时使用 accepted_at 并注明口径。超窗输入记录跳过原因并推进；真实使用前明确旧消息策略。

历史预览使用没有外部写权限的凭据或禁写模式。仅添加 replay 标签不能阻止发送。更改旧消息策略不自动清空未决输入、调用或会话记录。

## 7. 演示消费者

M0 已提供 fixture-transform 与 observer 的位置持久化和读取循环；M2-01 删除 observer，取消原 G05 第二消费者交付及事件副本计划。ACP Consumer 是 M1 实现，M2 更名 agent-chat。

- fixture-transform 只处理受控 fixture 事件，生成确定内容和稳定派生身份；发布成功后保存位置。崩溃重试同一输出由网关 first-write-wins 处理，不承诺任意业务的恰好一次变换。
- observer 专属代码、配置与用例在 M2-01 清理；仍验证公共存储与插件行为的测试保留，不为 Admin 另建观察数据库。
- 模拟工具无真实外部副作用；调用记录故障验证使用受控提供者。OneBot 模拟服务只覆盖当前协议交互，不构造完整聊天平台。

读取循环不重入；忙时合并唤醒，空闲时按测试默认 1 秒补查，读取错误有界退避。终止信号停止新读取，等待本地提交，并按 [Agent 接入](agent-integration.md)清理 ACP 资源；未确认的输入保留标记。

## 8. 能保证的范围

M1 要验证当前存储中的事件续读、正常自动触发、未决输入阻止自动重放，以及同一调用意图的核心去重。接受结果不确定时需要人工处置，也可能最终没有回复。

这不证明来源离线窗口完整采集、平台端恰好一次、Agent 工具完全受控或状态删除/回滚后仍不重复。对应 T03、T06、T07、T08；实际状态见[验收](validation.md)。

## 9. M1-04 配置与状态格式

builtin:acp-consumer 的配置包括 input_id、source_prefix、max_event_age_seconds、agent，另可指定 turn_timeout_ms 和 filter。source_prefix 必须是规范的 imbrex://qq/<account>/<namespace>/；只触发该范围内可信的 qq.message.group/private 原始入站事件。最大年龄须显式给出，范围 1—86400 秒，示例为 300；超过当前时间 5 秒的来源时间也跳过。未提供来源时间时使用 accepted_at。

filter 同时包含 group_ids、private_user_ids 两个数组，ID 使用 OneBot 支持范围内的规范正十进制字符串，保存前去重排序。例如 `{ "group_ids": ["987654"], "private_user_ids": ["654321"] }` 允许指定群的入站消息（不额外限制发送者），或指定用户的私聊消息；私聊名单不放行该用户在其他群的消息。空数组不允许对应类型，两个空数组不触发任何输入；未配置 filter 保持原行为。过滤发生在创建/恢复会话和提交 prompt 之前，被排除的事件仍推进 last_seq，并记录 consumer_skip_filter。该配置仅控制 Consumer 触发，不改变连接器采集范围或 Agent 的 MCP 读取与调用权限。

agent 包含 command、args、绝对 cwd 和可选 env_vars。启动时解析实际可执行文件与真实工作目录并保存绑定；env_vars 指定从宿主传给 Agent 的环境变量名称，缺失时拒绝启动。PATH、HOME、USER、LOGNAME、LANG、LC_ALL、TMPDIR 随进程基础环境传递；env_vars 的值不写状态文件，凭据应通过该通道提供而不是写进 command/args。Agent 自身历史与配置被人工更换时必须按恢复规则处理。

一次只处理一个输入，补查间隔 1 秒；握手/会话操作超时 5 秒，prompt 默认超时 120 秒，turn_timeout_ms 范围 10—600000。最多保留 32 个会话关联；状态文件最多 256 KiB，ACP 单帧最多 32 MiB，为较大的 MCP 上下文和 pi-acp 转发的原始工具输出预留容量。达到上限暂停并报告，不自动丢弃历史关联。客户端不声明文件或终端委托，权限请求一律有界返回 cancelled。

consumer-state.json 使用 version=1，包含 input_id、store_id、last_seq、selection、reader、agent、agent_info、sessions、in_flight。selection 保存 source_prefix、event_types、最大年龄与已配置的 filter；未配置时不写 filter，兼容原有状态。reader 保存 api.events.readScope() 得到的主体与来源范围；agent 保存实际 command、args、cwd、env_vars 名称；agent_info 保存已观察的名称/版本或 null。sessions 是完整可信会话 source 到 ACP sessionId 的映射，in_flight 为 source/id/seq/conversation/session_id 或 null。位置全部为十进制字符串。

当前 M1 的 filter 新增、移除或名单成员变化沿用 consumer_binding_changed 暂停；名单排序或重复项不影响绑定。离线恢复保留原 filter，不改变输入范围。M2 经管理入口完成第 12 节的受控应用后可接受新绑定，手工改文件造成不一致仍暂停。

读取范围、主体、Agent 程序/工作目录等绑定改变时暂停；in_flight 非空时不启动 Agent 重投。新进程只有成功协商并执行 session/load 后才可使用旧会话。正文不写本地消费状态；诊断输出 input_id 和事件引用摘要，消息、凭据与远端异常正文不进入日志。

Linux stdio 使用 tini 0.19.0 的 subreaper 模式包裹监督进程，再通过显式标准流与 IPC 启动 Agent。Agent 异常退出或其后代脱离原进程组时，孤儿进程由专属 tini 接管，监督进程清理并检查所有后代，tini 负责回收。宿主控制通道关闭后也继续清理；缺少 tini 时拒绝启动该 Consumer。终止与升级终止后检查进程已经退出，清理未完成则报告 stop_failed。部署仍以受信 Agent 和既有本地权限为前提，不提供恶意代码隔离。

Consumer 等待 api.whenReady() 确认 HTTP/MCP 已监听后才读取并投递，避免较晚初始化的插件拖延监听使首轮失败。ACP 过程通知不参与消费确认，直接丢弃；无效报文和未知响应 ID 在 SDK 前拒绝，阻断 SDK 将原始通知或 ID 写入异常日志的路径。

## 10. M2 运行态观测（待实现）

Admin 展示 Consumer 的事实投影：available=true 且 in_flight=null 为 idle；available=true 且非空为 processing；available=false 且非空为 suspended_in_flight；available=false 且为空为 stopped_or_error。后两者结合实际生命周期、停止过程与错误原因解释，不能把正常处理或正在停止都说成模型卡死。

展示当前事件引用、ACP session、处理开始时间、耗时和最近错误。序号距离 latest_seq − last_seq 不是待处理消息条数。正常不回复可以完成消费，不能按没有 reply 调用判为失败；缺少模型细节时报告未提供，不伪造进度。

<a id="m2-recovery"></a>

## 11. M2 在线处置与单会话重置（待实现）

在线处置保持宿主运行，由宿主协调目标 Consumer，不在 Admin 内直接执行持 data_dir/.lock 的离线 CLI。处置对象包含实例、store_id、未决 seq 和原事件引用，服务端核对与当前状态相同；不能由旧页面按钮推进另一条输入。

1. 停止目标 Consumer 后续投递，结束并确认相关 Agent 工作已停止。其他插件、HTTP、OneBot 与管理入口持续运行。
2. 根据原事件、可关联的 call_id 和平台证据核验现场。正常 processing 不是可直接跳过的异常；有未决责任才进入确认/放弃流程。
3. 记录操作者与原因，先保存含原状态的备份，再原子替换持久消费状态。确认处理与放弃均只推进当前未决 seq 并清除该标记，不修改 calls。
4. 同步内存状态与会话恢复状态，再恢复后续消费。失败时保留可核验结果，不提前返回已恢复。

放弃是结束该输入的自动处理责任，不撤销已发生的发送。unknown 保留原事实，不因确认消费完成就被改为 succeeded，也不换 ID 重发。离线与在线入口可复用状态变换及备份逻辑，但互斥方式分别由离线锁和宿主协调保证。

单会话重置以完整可信 source 定位，仅当该会话无活跃轮次且无未处置 in_flight 时可执行。解除持久与内存中的 session/loaded 关联，并处理实际 Agent 恢复状态；不删除原会话记录。其他会话关联和 last_seq 保持。缺少恢复能力时向操作者解释需重置的原因，不自动清空全部映射。

<a id="m2-config"></a>

## 12. M2 filter 轮次边界应用（待实现）

管理入口仅编辑 filter.group_ids 与 filter.private_user_ids，OR 匹配、空名单不放行等规则不变。它不修改 OneBot 采集名单或 Principal 授权；扩大到未采集/未授权范围时显示该限制，不虚报已可接收。

新值校验后可保存待应用。已有正常轮次继续使用旧配置、旧超时和旧过滤规则；正常 end_turn 且检查点持久保存后，暂停下一条投递，在磁盘与内存中更新配置绑定，再继续后续输入。已经预读但尚未处理的页内记录也要按新规则筛选，不能只在下一次拉取页面时切换。

应用保留 last_seq 与会话证据，不重新回放已经完成或跳过的历史；新规则只作用于检查点后的未处理输入。有异常未决项时拒绝应用，须先确认/放弃；配置保存不能消除输入责任。

持久配置与绑定一致后才报告已应用。写入/同步失败或部分更新时保持可诊断的待应用/失败状态并停止不确定的新投递，不伪报成功或自动重置。完成受控应用后普通重启可恢复新绑定；手工改文件导致的绑定不一致继续沿用拒绝静默恢复的规则。
