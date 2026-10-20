# M2 管理控制台契约

本文规定 M2 的管理行为。当前 admin 插件提供只读观测、实例面板、配置查询与外部静态资产挂载；配置编辑和在线处置按[开发计划](development-plan.md#m2)扩展，具体线上表达见 [HTTP 契约](contracts.md#12-管理-api)。

## 1. 交付范围与组成

管理后台面向单所有者网关，按“先观测，后控制”交付。前端使用 Vue 3 + Vite + TailwindCSS，构建产物由 server-http 在 /admin 与 /admin/* 提供；管理 API 使用 /api/admin/*。不需要独立前端运行进程，不新增第二消费者或事件副本作为后台前置。

admin 插件配置为 {} 或 {"assets_dir":"/absolute/path/to/external/build"}。assets_dir 可选且必须为绝对目录；配置后提供 GET/HEAD /admin 与 /admin/*，未配置时对应路径返回 404。目录应仅包含部署者提供的静态构建资产，不嵌入凭据或管理数据。扩展名缺失的路由回落 index.html，缺失显式文件返回 404；不列目录，拒绝路径穿越和根目录外符号链接。

| 组成 | 职责 |
| --- | --- |
| server-http | 共享监听、路由和静态资源生命周期、请求限额与连接清理 |
| 宿主 AdminRegistry | 保存按实例绑定的管理描述，随实例清理；无 HTTP 入口时仍可登记 |
| admin | 管理认证与动作派发、数据聚合、页面和静态资源注册 |
| onebot-v11 / agent-chat | 提供自身状态、指标、详情和受控操作，不在 Admin 中复制业务判断 |

注册表不依赖 Admin 插件是否启用。Admin 晚启动可以读取现有登记；重启或卸载 Admin 仅影响管理入口，不重启 OneBot、Agent 或其他业务插件。描述本身保留在内存中，不承诺无成本，也不创建后台事件数据库。

## 2. 管理身份和权限

| 权限 | 允许的范围 |
| --- | --- |
| admin:inspect | 本单所有者网关的全局管理状态、插件面板、事件/能力视图、跨主体调用审计和脱敏有效配置 |
| admin:operate | 执行服务端已登记的管理动作、保存和应用托管配置、在线处置未决输入、受控重启及会话重置 |

管理员 Principal 显式配置所需权限，通过现有 token_env 引用静态 Bearer 凭据。可同时授予两个权限，admin:operate 不隐式代替 admin:inspect。普通 Agent 凭据不因此获得管理权限，管理动作不注册为其 MCP 可调用能力。

管理 API 每次请求认证和检查对应权限。loopback 仅限制监听地址，不提供免密身份；浏览器管理请求的来源校验与认证共同生效。凭据不进入 URL、前端构建产物或诊断正文。配置页面展示秘密是否已配置及引用位置，不返回 Token、密码或私钥明文。

现有 /v1/calls/{call_id} 继续只能读取调用主体自己的记录，/v1/plugins 继续是 runtime:inspect 的只读接口。新增管理员跨主体查询只在管理入口执行，不改变既有 Agent 与 REST 客户端的授权规则。

## 3. 插件管理描述

插件通过绑定 API 的 registerAdminPanel 登记管理描述。当前接受 title、icon 和 read()，每个实例登记一份描述；动作入口随在线控制功能增加。实例身份由 api.instanceId 注入，不能由描述中的任意字符串冒充其他实例。

状态和详情使用可序列化的有界数据，序号继续为十进制字符串。一次读取失败显示该实例读取错误，不影响其他面板或改变业务事务结果。仅展示已采集到的指标；例如未取得心跳延迟就显示未提供，不用 0 伪装正常。

动作包含实例内 ID、名称、输入 schema、可选的确认提示以及执行入口。服务端先鉴权、校验参数并核对当前状态，再派发给实际所有者；danger/confirmText 只是界面提示。登记应返回注销函数并绑定实例生命周期；卸载后不留旧回调，多个同类插件独立登记。

停止、重启、恢复等需要跨越目标插件生命周期的动作，由宿主协调。不能在插件已卸载后继续调用其旧闭包，也不能让 Admin 直接修改插件状态文件或 SQLite。

## 4. 观测页面与事实语义

| 页面 | 必须能回答的问题 |
| --- | --- |
| 全局概览 | 当前 store_id、最新序号、插件可用性和最近错误是什么 |
| 事件浏览 | 哪条输入被接纳，属于哪个来源，何时进入，正文是什么 |
| 能力与调用 | 注册了哪些能力和 schema；调用属于谁，参数、结果与 unknown 证据是什么 |
| OneBot 面板 | 当前连接、账号核验、可获得的心跳/收发指标和断线原因是什么 |
| Agent 面板 | 当前输入与 ACP 会话、处理开始时间和耗时、运行阶段、检查点及未决原因是什么 |
| 配置面板 | 模型、上下文窗口声明、提示词、MCP 地址与凭据引用、Consumer filter 的保存值与生效状态是什么 |

历史事件/调用按有界分页查询，不能只靠临时通知构造完整记录。位置与事件引用沿用既有类型和权限规则。序号距离 latest_seq − last_seq 不等于积压消息条数，不把它标成“待处理消息数”。

Consumer 状态投影如下，不另建消费状态机：

| available | in_flight | 显示状态 |
| --- | --- | --- |
| true | null | idle：空闲等待 |
| true | 非空 | processing：正在处理，显示已耗时与当前输入 |
| false | 非空 | suspended_in_flight：未决暂停，显示原因并进入核验 |
| false | null | stopped_or_error：停止或启动/连接错误，结合插件生命周期与错误说明 |

正常模型不回复是合法结果，不能标为失败。最终 end_turn 仅表示该轮完成；回复是否发送成功仍按 calls 和平台证据判断。没有取得模型或工具阶段信息时明确显示未知，不从“进程仍在”推断模型正在工作。

### 4.1 实例数据字段

OneBot data：connected 表示当前连接已核验且在线；account_verified 是当前连接账号校验结果；account_id、identity_namespace、binding 为配置及实际核验身份；started_at 为本次插件开始时间；last_error 为公共原因码或 null。accepted_events、duplicate_events 是本次插件运行内的十进制计数；queued_events 是当前待入库队列长度。connection_metrics 为当前连接的 received_frames、sent_requests 十进制计数及 heartbeat_rtt_ms，无连接时为 null。未测量 RTT 时返回 null，帧/请求计数含协议握手，不表示消息条数。

Agent data：status、available、phase、last_error 描述处理投影；input_id、store_id、last_seq、in_flight、sessions、agent_info 对应消费状态。turn_started_at 为实际 prompt 开始时间，elapsed_ms 从其计算；无计时依据时为 null。phase 为 starting/idle/session/prompt/checkpoint/error/stopping；model_stage 当前为 null，不猜测模型细节。正常 end_turn 且检查点成功后回到 idle。

Agent configuration 包含 filter（未配置为 null）、source_prefix、max_event_age_seconds、turn_timeout_ms、reader、agent_environment 和 pi。reader 是 Consumer 读取授权；agent_environment 只返回变量名和是否存在。pi 只检查显式传入的绝对 PI_CODING_AGENT_DIR，不读取默认用户 HOME；status 为 unmanaged/configured_unverified/unavailable。saved 为 {provider,model,context_window,system_prompt,mcp} 或 null，applied/observed 当前为 null。缺少声明时返回 null，不推断 provider 默认值。MCP 只返回无嵌入凭据的地址及环境引用，不回传 headers、密钥或 shell 命令。单个配置文件最大 64 KiB，损坏/超限返回 unavailable。

## 5. 配置查看、编辑和应用

M2-02 提供只读配置全景，M2-03 增加编辑和受控应用。首版可编辑项包括 Consumer filter，以及托管 pi 的模型选择、上下文窗口和系统提示词。本文不扩展为任意宿主参数或任意 Agent 的无损热更新。

filter 的完整规则以[应用消费](applications.md#m2-config)为准：当前轮使用旧配置，完成并持久保存进度后应用新规则，已完成或跳过的历史不回放；异常未决先处置。filter 不扩大 OneBot 采集范围或 Principal 授权，页面必须分开展示这些范围。

模型、窗口与提示词保存后显示“待重启生效”。应用时仅受控重启 pi-acp/pi；宿主、HTTP、OneBot 和其他插件保持运行。会话关联与证据保留，恢复能力不足时报告并使用明确的会话重置入口。具体规则见[Agent 接入](agent-integration.md#m2-managed-agent)。

UI 分开呈现已保存配置、已应用配置和运行时观察值。声明 500K 上下文只代表本地设置，不能伪报已经验证远端容量。保存成功但应用未完成、失败或受未决状态阻止，都不能显示“已生效”。

## 6. 在线异常处置

操作对象必须包含稳定实例、store_id 和当前未决输入的引用/seq，防止旧页面处置了另一条输入。只有停止该 Consumer 的新投递并确认相关 Agent 工作结束后，才能修改其持久责任状态。宿主、连接器和管理入口继续运行。

- **确认处理**：核验后推进该未决输入的检查点并清除标记，不改变对应 calls 的结果含义。
- **放弃输入**：记录原因并结束该输入的自动处理责任，不声称撤销已发出的动作。
- **重置会话**：以完整可信 source 定位，只在该会话无活跃轮次、无未处置未决项时解除映射，不删除旧会话证据。
- **核验 unknown**：展示原调用和证据，可记录人工核验说明；不自动修改 call.status、换 ID 或补发。

备份、持久更新、恢复消费和失败结果按[应用消费](applications.md#m2-recovery)执行。在线入口不调用需要独占整个数据目录锁的离线 CLI。操作完成应返回实际处置结果，不能先提示“已恢复”再异步尝试。

## 7. 打包与交付边界

生产构建将 SPA 资产随网关提供；完成依赖安装与构建后，一个网关启动命令同时提供 API 和后台。仍需安装已声明的运行依赖，不承诺从未构建的源码仅运行 npm start 即可工作。

前端体积预算为压缩后静态资产总大小约 1–2 MB，验收记录实际构建结果和压缩方式。目标版本 v0.2.0 在 M2-04 验收后冻结；本文不代表已经发布该版本。

不包含插件市场、iframe 自定义后台生态、远程安装包、通用工作流或自动恢复未知外部发送。M2 的管理是明确授权下的观测与操作，不扩大已验证的来源完整性、平台幂等或高可用保证。
