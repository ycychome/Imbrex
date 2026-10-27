# 配置、权限与运行运维

统一开发基线 0.3。首版为单所有者部署，本机默认监听；无多租户、自动故障转移或在线数据库替换。配置使用 version 2 与显式协议插件；托管配置和在线处置的操作边界见第 8 节。

## 1. 配置来源

使用一个显式 JSON 配置文件，config_version=2。相对数据路径以配置文件目录为基准；插件模块只从 builtin 映射、已安装包或明确本地文件加载，不在线下载安装代码。无效字段、未知插件、重复实例 ID、未知主体或不支持的配置在启动前报错；server-http 的 host/port 在配置解析阶段校验，其他插件模块的结构化配置在对应插件装配时校验。

配置的 JSON 值受 256 KiB 与 32 层嵌套上限约束。server-http 插件的 config.port 为 0 时由系统分配临时端口，适用于本地测试；固定部署使用明确端口。配置校验、主体认证、模块加载与进程启动由宿主与 server-http 插件承担。

配置示例用于本地演示；可运行文件见 [examples/demo.json(../../examples/demo.json)，启动步骤见[开发指南](development.md#m0-run)：

```json
{
  "config_version": 2,
  "data_dir": "./data",
  "external_writes_enabled": false,
  "principals": [
    {
      "id": "demo-agent",
      "token_env": "IMBREX_DEMO_AGENT_TOKEN",
      "permissions": ["events:read", "capabilities:list", "capabilities:invoke", "calls:read"],
      "read_sources": [{"prefix": "imbrex://fixture/"}],
      "write_sources": [],
      "invoke_capabilities": ["mock.echo"]
    },
    {
      "id": "fixture-source",
      "permissions": ["events:write"],
      "read_sources": [],
      "write_sources": [{"exact": "imbrex://fixture/messages"}],
      "invoke_capabilities": []
    },
    {
      "id": "transform-app",
      "permissions": ["events:read", "events:write"],
      "read_sources": [{"exact": "imbrex://fixture/messages"}],
      "write_sources": [{"exact": "imbrex://fixture/derived"}],
      "invoke_capabilities": []
    },
    {
      "id": "protocol",
      "permissions": [],
      "read_sources": [],
      "write_sources": [],
      "invoke_capabilities": []
    },
    {
      "id": "mock-provider",
      "permissions": [],
      "read_sources": [],
      "write_sources": [],
      "invoke_capabilities": []
    },
    {
      "id": "operator",
      "token_env": "IMBREX_OPERATOR_TOKEN",
      "permissions": ["runtime:inspect"],
      "read_sources": [],
      "write_sources": [],
      "invoke_capabilities": []
    }
  ],
  "plugins": [
    {"id": "http", "module": "builtin:server-http", "principal_id": "protocol", "required": true, "enabled": true, "config": {"host": "127.0.0.1", "port": 8080}},
    {"id": "rest", "module": "builtin:api-rest", "principal_id": "protocol", "required": true, "enabled": true, "config": {}},
    {"id": "mcp", "module": "builtin:adapter-mcp", "principal_id": "protocol", "required": true, "enabled": true, "config": {}},
    {"id": "fixture", "module": "builtin:fixture", "principal_id": "fixture-source", "required": true, "enabled": true, "config": {}},
    {"id": "transform", "module": "builtin:transform", "principal_id": "transform-app", "required": true, "enabled": true, "config": {}},
    {"id": "mock", "module": "builtin:mock", "principal_id": "mock-provider", "required": true, "enabled": true, "config": {}}
  ]
}
```

HTTP 监听由 server-http 插件提供；api-rest、adapter-mcp、admin 在各自作用域登记入口，必须排在 HTTP 服务之后。api-rest 与 adapter-mcp 的 config 为空对象。普通配置修改通过重启生效；不提供远程安装插件或任意代码无损热替换。

启用管理后台时，另配一个显式 `admin:inspect` 主体并增加 `builtin:admin` 插件。admin 插件 `config` 为 `{}` 时默认按包名解析 `@imbrex/ui-contract` 的 `dist`，不需要写绝对路径；`assets_dir` 仅用于覆盖外部构建目录，必须为绝对目录。未构建或资产缺失时 `/admin` 返回 404，admin API 与宿主继续运行，不因 UI 缺失阻止启动。

### 1.1 旧配置迁移

version 1 和旧 builtin:acp-consumer/observer 不再作为运行入口接受。升级前正常停止旧宿主并备份配置及运行数据，保留原凭据环境变量；构建后执行：

```sh
npm --silent run config:migrate -- /absolute/path/v1.json /absolute/path/v2.json
npm start -- --config /absolute/path/v2.json
```

迁移只读取旧配置并创建权限 0600 的新文件，目标必须不存在；失败不覆盖旧文件。迁移只做结构和名称校验，不要求导出 token_env；新配置启动时仍需原凭据环境变量。data_dir 与相对插件模块按原配置位置转换为绝对路径；HTTP 拆成显式协议插件，协议主体无业务或管理权限。业务实例 ID、主体、Agent 程序/工作目录/filter 保留，acp-consumer 仅改为 agent-chat，observer 配置移除但旧数据不删除。

数据库 store_id、data_dir/plugins/<原实例ID>/consumer-state.json、消费位置和会话均不由配置迁移工具修改。状态仍为 version=1；绑定不匹配或未决输入沿用暂停规则。工具不会添加管理员身份或提升原 operator/Agent 权限。

## 2. 主体与授权

有 token_env 的主体可通过对应 bearer token 接入 HTTP；没有 token_env 的主体仅供宿主绑定的插件使用。环境变量缺失、空值或重复 token 均拒绝启动。真实 token 不写入配置样例、源码或日志。

生成 token 使用足够随机的 256 bit 值，服务端使用摘要映射与受控比较。token 是认证材料，caller_id 是稳定主体 ID；轮换 token 不更改已有调用记录所属主体。具体实现复用 Node crypto，不自行设计加密协议。

权限为显式集合：events:read、events:write、capabilities:list、capabilities:invoke、calls:read、runtime:inspect、admin:inspect、admin:operate。来源规则使用 exact 或字面 prefix，规则间 OR；空列表拒绝。调用能力按完整 ID 允许列表匹配。

已认证主体可以读取 info，其中的 store_id/latest_seq 是本单所有者元数据域公开给接入方的信息；本版不隐藏全局流量规模。事件正文仍按读取权限过滤，发布还须匹配 write_sources；parents 引用的来源须获读取授权，但不要求父事件存在。

拥有 calls:read 只查询自己的调用，现有 /v1 没有跨主体调用列表；runtime:inspect 可查询脱敏插件状态。M2 的 admin:inspect 通过独立管理入口提供跨主体调用审计和脱敏配置，admin:operate 执行管理动作，不扩大原接口或 Agent 的权限。注册能力属于宿主赋予该插件实例的职责，不需要把内部注册权限暴露成远程 API。

每次请求重新校验当前凭据和授权；权限配置通过受控重启生效。M2 的 Consumer filter 在线编辑不联动修改 Principal 或连接器范围。插件服务绑定使用相同规则，但不能把同进程接口纪律当作对恶意代码的沙箱。

M1 的 MCP 入口复用上述主体与授权。Agent 使用专用 token，ACP Consumer 通过绑定 API 读取，其实际输入范围必须与接收输入的 Agent 授权范围一致或更窄，避免经 prompt 绕开读取限制。MCP 会话不能替代认证。ACP 可执行文件、参数、工作目录、模型凭据和 pi 的 MCP 配置属于实际接入配置，在 M1 实现时补充可运行示例；上面的 M0 示例不包含这些未实现字段。

## 3. 启动与就绪

启动顺序：校验配置与模块 → 取得数据目录唯一实例锁 → 打开数据库 worker、校验/迁移 schema → 标记旧 in_progress 为 unknown → 注册内核服务 → 装配 HTTP 和业务插件 → 允许对外请求。

首版部署目标为本地 Linux，采用 util-linux flock 的非阻塞、no-fork 启动包装，让实际宿主持有 data_dir 下专用锁文件的排他锁。正式入口先校验配置并创建所需目录，再取得锁，取得前不打开业务数据库。锁竞争时拒绝第二实例，不通过猜测 PID 或强删锁文件接管。

M0 验证包装入口、崩溃释放和 worker 失败后的整个宿主退出；不得把锁描述符传给独立后台后代进程而使宿主退出后仍被持有。缺少 flock 或非 Linux 平台先明确不支持，不静默跳过锁。[R10](references.md#r10)

正式命令为 npm start -- --config <file>。launcher 校验配置与模块后，以 flock --nonblock --no-fork 启动实际宿主，并传入规范化的数据目录；子进程再次核对目录，避免配置更改后打开未加锁的数据库。锁竞争退出码为 75，其他启动/关闭失败为非零。SIGINT/SIGTERM 传递给实际宿主，正常关闭为 0。src/cli/run 是包装器内部入口；直接嵌入 Host 的受信调用方负责保持同样的实例锁约束。

required 插件模块/初始化失败导致启动失败并释放已创建资源；optional 插件失败使实例降级且状态可见。运行中的外部连接可用性与 Cordis 加载状态分别报告；required 不表示远端永远在线。

M1 装配时须先让 MCP 入口可供 Agent 使用，Consumer 核对自己的持久状态、完成 ACP 协商和会话恢复后才提交输入；避免让首条 prompt 等待尚未开放的工具入口。发现 in_flight 时保持暂停并报告，不能按“进程重启”自动续跑。

## 4. 关闭与单插件停用

1. 拒绝新的业务请求和新调用，不再发起来源读取或应用读取。
2. 等待已经进入的数据库命令和已派发调用；按调用超时记录 unknown，不把客户端断开当作撤销。
3. 释放插件监听、定时器、能力注册和网络连接，等待受控后台循环退出。
4. 最后关闭 SQLite worker、HTTP 资源并释放实例锁。

单插件停用时内核继续运行。插件停止未完成时不得启动同实例的新循环；出现不能合作退出的代码应报告 stop_failed，必要时关闭宿主，而不是误报已清理。Cordis 的资源作用域用于装配清理，业务停止顺序由插件与宿主明确实现。

agent-chat 还须停止 ACP 投递、保留未决输入，并关闭标准流、计时器与其拥有的 pi-acp/pi 进程；需要验证后代进程回收和锁描述符不继承，不把独立进程当作权限沙箱。详见 [Agent 资源生命周期](../../src/plugins/agent-chat/README.md)。

## 5. 诊断

启动输出程序/依赖版本、数据目录、store_id、schema_version、SQLite 版本、有效 PRAGMA 及已装配插件 ID，不输出 token、模型密钥和消息全文。

运行日志使用 request_id、call_id、plugin_instance_id 与事件 source/id 定位行为；正文和参数的调试输出默认关闭。插件状态区分 waiting/loading/active/failed/stopping/stopped，并另有 available 与最近脱敏错误。

记录数据库队列拒绝、追加失败、读取错误、来源断线、能力不可用、unknown 调用和停止失败。server-http 监听服务器的运行时 error 只记录 http_server_error，不改变插件可用性；可用性由监听与路由生命周期决定。首版用结构化日志及只读状态接口即可，不先搭建监控平台。

## 6. 备份与手工恢复

本版不建设在线备份服务，但运维须遵守 SQLite 的机制：可以使用受支持的备份 API，或停止宿主并正确关闭连接后复制一致的存储；不能在 WAL 活跃时只拿主 .db 文件当完整备份。[R3](references.md#r3)

备份网关不等于备份 Agent 自己的会话、Consumer 进度与 in_flight、插件私有状态、凭据或附件。第一次依赖真实重要数据前，用户明确故障域、保留和恢复目标，另做对应演练。

恢复旧副本时：先停止相关组件并禁用外部写，备份当前状态；把恢复副本作为新的存储历史并更新 store_id；分别检查应用进度、Consumer 未决输入、Agent 会话及原 in_progress/unknown 调用；选择新起点或只读核验，确认后才启用明确范围的外部写。不要只改 store_id 或清除 in_flight 后自动重播原 prompt。Consumer 的逐条人工处置见[应用消费](../design/applications.md)。

普通启动无法辨识文件是原库还是旧备份，这项流程是显式运维前置。首版没有自动回滚恢复保证。

### 6.1 单条人工处置（`consumer:recover`）

Consumer 的逐条处置使用离线命令，不使用管理页面，也不与运行中的宿主争锁。

先构建（`npm run build`）。查看参数：

    npm --silent run consumer:recover -- --help

统一使用 `--silent` 关闭 npm 自身的参数回显；普通 `npm run` 会把 `--reason` 的内容打印到 stdout。也可直接运行 `node dist/src/cli/recover.js`，参数相同。输出脱敏不代替对本地命令历史和进程参数的访问控制，`--reason` 中仍不得包含凭据或消息全文。

**前置条件**

- 先用原 Agent 主体通过 `imbrex_get_call` 或单条 calls HTTP 接口查询实际 `store_id` / `call_id`，并核对 Agent 会话与平台接收记录。operator 没有跨主体调用查询权限；猜测的 `call_id` 查不到不等于没有发送。无法建立输入与调用的关联时保持未确认。
- 正常停止整个宿主，确认其 Agent、监督进程及 tini 已退出。命令会取得 `data_dir/.lock`；仅停用插件而保持宿主运行会被拒绝。不要删除锁文件。
- `--data-dir` 相对当前工作目录解析，必须指向宿主实际的数据目录。私有状态位于 `data_dir/plugins/<instance>/consumer-state.json`。

**处置动作**

确认该条已处理：

    npm --silent run consumer:recover -- \
      --data-dir data/acp --instance agent \
      --store-id "$EXPECTED_STORE_ID" --seq "$EXPECTED_PENDING_SEQ" \
      --action processed --reason '已核对原调用与会话记录，确认本条处理结束'

放弃该输入并为它的会话选择新的 ACP session：

    npm --silent run consumer:recover -- \
      --data-dir data/acp --instance agent \
      --store-id "$EXPECTED_STORE_ID" --seq "$EXPECTED_PENDING_SEQ" \
      --action abandoned --new-session --reason '保留未知调用，放弃本条自动处理并启用新会话'

Agent 无法恢复旧 session 时，须已无 `in_flight`，并用当前 `last_seq` 作为 `EXPECTED_LAST_SEQ`：

    npm --silent run consumer:recover -- \
      --data-dir data/acp --instance agent \
      --store-id "$EXPECTED_STORE_ID" --seq "$EXPECTED_LAST_SEQ" \
      --action reset-sessions --reason '原会话不可恢复，保留进度并显式重新建立会话'

`processed` 与 `abandoned` 都只推进到保存的未决 seq 并清除 `in_flight`，不修改 calls、不补发、不重跑模型。`--new-session` 只删除该输入所属会话的映射，其他映射保留。需要为新的明确意图发送时另按能力契约操作，不能把 `abandoned` 当作重试开关。`reset-sessions` 清空全部会话关联和观察到的 Agent 名称/版本，保留消费位置、输入选择、主体与程序/工作目录绑定。

命令不负责更换存储、调整读取范围、回退位置或修复损坏状态；这些情况按应用恢复规则确定新起点。这不是存储回滚、任意改位置或补发工具。

**持久记录与错误**

命令只读打开现有 SQLite，不执行普通启动时的 `in_progress → unknown` 恢复。它核对 `schema_version`、`store_id`、`last_seq` / `in_flight` 及未决事件的真实序号；位置、会话关联或实际事件不一致时拒绝。

更新前先在 `plugins/<instance>/recovery/<operation_id>.json` 保存准备记录：`version`、`operation_id`、`prepared_at`、`operator_uid`、`instance`、`action`、`new_session`、`expected_seq`、`reason` 和 `before`（完整旧状态）。目录权限 `0700`，文件权限 `0600`；先写临时文件、fsync、rename、同步目录，再用同样顺序替换状态。`reason` 非空、最多 2048 UTF-8 字节，保存在本地私有记录中。

备份记录只证明已准备处置，不能单独证明状态已经替换。成功返回 `consumer_recovered`、最终 `last_seq` 和相对数据目录的 backup 路径；不输出原因、会话或消息正文。退出码 0 表示完成，75 表示实例锁正在使用，其他失败为 1。

| 错误码 | 处理 |
| --- | --- |
| `recovery_invalid_arguments` | 核对必填参数、规范十进制序号和非空原因 |
| `recovery_state_invalid` / `recovery_store_unavailable` | 保留原文件，核对格式、路径和数据库可读性，禁止自动重置 |
| `recovery_store_mismatch` / `recovery_position_mismatch` / `recovery_event_mismatch` | 对照实际存储和状态重新核验，命令没有推进进度 |
| `recovery_backup_write_failed` | 备份未确认持久保存，命令未开始替换状态；检查磁盘与私有目录权限 |
| `recovery_state_write_uncertain` | 备份已保存但状态替换/目录同步失败；按返回路径检查备份与当前文件，不能盲目重试或复制旧状态回去 |

进程被信号中断、命令输出丢失或磁盘故障也可能发生在状态替换之后；同样先核对当前 `last_seq` / `in_flight` 和准备记录。普通完成后再次提交旧未决 seq 会被拒绝。此流程不保证断电或磁盘损坏恢复，也不消除平台 `unknown`。

## 6.2 首次接入顺序

把 OneBot、Consumer 与 Agent 接到同一个获准范围，按阶段推进，每阶段通过后再进入下一阶段。

**准备**

1. 在项目忽略的 `data/` 下生成本地配置，从 `examples/agent/acp.json` 开始，按 [Agent 协议接入](../../src/plugins/agent-chat/README.md) 设置 Agent 绝对工作目录与环境变量名称。
2. 先保持 `external_writes_enabled=false`。
3. OneBot 的 `ws_url` / `account_id` / `identity_namespace`、允许会话、Consumer `source_prefix` 与 Agent `read_sources` 必须指向同一个获准范围。切换服务身份时使用显式新命名空间，不复用未证实连续的原生消息身份。
4. 真实凭据通过环境变量或 Agent 自己的配置提供，不粘贴进 PR 或聊天。

**阶段**

1. 在模拟 OneBot 上运行真实 Agent，分别验证上下文读取、回复和不回复。保留 MCP 实际调用与 Action 记录，不能只记录工具发现成功。
2. 切到真实 OneBot，先禁写核验账号元数据、入站映射、范围过滤、重复输入与断线重连。此阶段不开自动回复。
3. 明确启用约定范围的外部写，在模拟平台的手动阶段通过后，验证真实新输入由 ACP 自动触发。对不应回复的输入同时检查模型记录、calls 与平台 Action。
4. 验证会话隔离、旧消息与自发回流过滤。核对恢复/重启前后的 prompt 次数和 `call_id`，而不只看界面有无响应。
5. 只有受控故障演练获准时才制造丢响应或中断。保存 `unknown` 与原 `call_id`，核验真实平台，再按 6.1 处置；不得为了让结果成功而自动换 ID 重发。

## 7. 部署边界

默认只监听 loopback；远程访问需要配置经过验证的 TLS 入口，token 不出现在 URL。OneBot 服务连接地址与访问 token 属于部署配置；不自动发现并连接用户账号。

数据目录占用由操作者监看，首版不自动删除。以后需要保留窗口、多个宿主、强隔离或持续采集完整性时，先明确目标再扩展；不以当前演示成功推导长期可用性。

## 8. 管理与配置应用

管理页面 /admin 与 API /api/admin/* 由 admin 插件登记，使用显式管理员 Principal 和 token_env 引用 Bearer 凭据。admin:inspect 用于全局观测，admin:operate 用于配置应用和受控管理动作。所有管理 API 请求重新鉴权，loopback 不免密；静态页面不嵌入管理数据或凭据。原 operator/Agent 凭据不自动升级。完整范围见 [Admin 契约](../design/admin.md)。

使用通用能力测试器或以 OneBot 自携视图读取 QQ 目录时，管理员 Principal 还必须具备 capabilities:invoke、events:read、相应具体能力及覆盖目标的 read_sources；外部写另需全局外部写开关。诊断选择其他主体只用于查看授权交集，不会改变实际执行身份。

托管配置位于 Imbrex 专属数据目录，包含独立 Agent 工作目录、PI_CODING_AGENT_DIR 和 HOME。MCP 地址及凭据引用由该配置同步生成，不修改用户全局 pi 环境，不回显秘密；不得假定 pi-acp 支持未经验证的 --cwd 参数。迁移已有目录时保留会话映射、进度和凭据引用，具体说明随实现更新。

| 修改 | 生效方式 |
| --- | --- |
| Consumer filter.group_ids / filter.private_user_ids | 保存待应用，当前轮完成并持久保存检查点后更新绑定，以新规则继续；不回放已跳过历史，不扩大采集和授权范围 |
| 托管模型、上下文窗口、系统提示词 | 保存为待重启，空闲且无异常未决项时只重启 pi-acp/pi；原会话关联保留，恢复失败单独报告 |
| 其他宿主配置、连接器采集或 Principal 授权 | 不纳入上述热更新承诺，沿用明确的配置与受控部署流程 |

异常未决输入先按[应用恢复](../../src/plugins/agent-chat/README.md#m2-recovery)处置，再应用配置。管理入口不能借修改配置清空未决记录。配置保存值、已应用值、运行时观察事实分开展示；写入一部分或重启失败时不能提示已生效。

在线恢复由宿主协调目标 Consumer 与 Agent、核验输入、备份并更新状态，不调用离线 CLI 与 data_dir/.lock 争锁。正常运行中的一轮不得当成故障项跳过。受控 Agent 重启和恢复期间，宿主、HTTP、OneBot 连接与其他插件保持运行；是否已经回复仍由原 calls 与平台证据判断。

M2-01 更名模块与拆分 HTTP 配置时，保留稳定实例/主体、store_id、消费进度和会话证据；提供明确迁移步骤，不通过删除数据目录完成升级。生产使用先安装依赖并构建，单个网关启动命令同时提供 API 与 Vue 后台，无需另跑前端开发服务器。

管理操作使用 POST /api/admin/panels/<instance>/actions/<action>，先读取对应面板的 store_id、generation 和 management.revision。保存配置后重新读取 saved/applied/pi_status/filter_status；resumed:false 或 inspect_required:true 时保留现场，核对私有 recovery/ 备份与当前消费状态，不能按 HTTP 200 推断已经恢复。精确请求和错误示例见 contracts.md 第 12 节。

在线 recover-input 仅用于异常暂停中的当前输入，processed 与 abandoned 都保留原 calls，包括 unknown。恢复加载失败时原会话继续保留，可在无该会话活跃/未决责任时用 reset-session 精确解除 source/session_id，再显式重启托管 Agent。客户端重试前核对实际状态；备份不是证明最终状态已写入的收据。
