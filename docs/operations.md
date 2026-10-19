# 配置、权限与运行运维

统一开发基线 0.3 · 2026-10-18。首版为单所有者部署，本机默认监听；无多租户、自动故障转移或在线数据库替换。

## 1. 配置来源

使用一个显式 JSON 配置文件，config_version=1。相对数据路径以配置文件目录为基准；插件模块只从 builtin 映射、已安装包或明确本地文件加载，不在线下载安装代码。无效字段、未知插件、重复实例 ID、未知主体或不支持的配置在启动前报错。

配置的 JSON 值受 256 KiB 与 32 层嵌套上限约束。http.port 为 0 时由系统分配临时端口，适用于本地测试；固定部署使用明确端口。配置校验、主体认证、模块加载与进程启动均已实现。

配置示例用于本地演示；可运行文件见 [examples/demo.json](../examples/demo.json)，启动步骤见[开发指南](development.md#m0-run)：

```json
{
  "config_version": 1,
  "data_dir": "./data",
  "http": {"host": "127.0.0.1", "port": 8080},
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
      "id": "observer-app",
      "permissions": ["events:read"],
      "read_sources": [{"prefix": "imbrex://fixture/"}],
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
    {"id": "fixture", "module": "builtin:fixture", "principal_id": "fixture-source", "required": true, "enabled": true, "config": {}},
    {"id": "transform", "module": "builtin:transform", "principal_id": "transform-app", "required": true, "enabled": true, "config": {}},
    {"id": "observer", "module": "builtin:observer", "principal_id": "observer-app", "required": false, "enabled": true, "config": {}},
    {"id": "mock", "module": "builtin:mock", "principal_id": "mock-provider", "required": true, "enabled": true, "config": {}}
  ]
}
```

HTTP 与内核适配是宿主必需组件，不从业务插件配置中卸载。业务插件配置可禁用；普通配置修改通过重启生效。宿主内部提供受信的 start/stop 操作给测试和本地集成，不在首版建设远程安装、热更新或管理控制台。

## 2. 主体与授权

有 token_env 的主体可通过对应 bearer token 接入 HTTP；没有 token_env 的主体仅供宿主绑定的插件使用。环境变量缺失、空值或重复 token 均拒绝启动。真实 token 不写入配置样例、源码或日志。

生成 token 使用足够随机的 256 bit 值，服务端使用摘要映射与受控比较。token 是认证材料，caller_id 是稳定主体 ID；轮换 token 不更改已有调用记录所属主体。具体实现复用 Node crypto，不自行设计加密协议。

权限为显式集合：events:read、events:write、capabilities:list、capabilities:invoke、calls:read、runtime:inspect。来源规则使用 exact 或字面 prefix，规则间 OR；空列表拒绝。调用能力按完整 ID 允许列表匹配。

已认证主体可以读取 info，其中的 store_id/latest_seq 是本单所有者元数据域公开给接入方的信息；本版不隐藏全局流量规模。事件正文仍按读取权限过滤，发布还须匹配 write_sources；parents 引用的来源须获读取授权，但不要求父事件存在。

拥有 calls:read 只查询自己的调用；首版不提供跨主体调用列表。runtime:inspect 可查询脱敏插件状态。注册能力属于宿主赋予该插件实例的职责，不需要把内部注册权限暴露成远程 API。

每次请求重新校验当前凭据和授权；权限配置通过受控重启生效。插件服务绑定使用相同规则，但不能把同进程接口纪律当作对恶意代码的沙箱。

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

M1 的 acp-consumer 还须停止 ACP 投递、保留未决输入，并关闭标准流、计时器与其拥有的 pi-acp/pi 进程；需要验证后代进程回收和锁描述符不继承，不把独立进程当作权限沙箱。详见 [Agent 资源生命周期](agent-integration.md)。

## 5. 诊断

启动输出程序/依赖版本、数据目录、store_id、schema_version、SQLite 版本、有效 PRAGMA 及已装配插件 ID，不输出 token、模型密钥和消息全文。

运行日志使用 request_id、call_id、plugin_instance_id 与事件 source/id 定位行为；正文和参数的调试输出默认关闭。插件状态区分 waiting/loading/active/failed/stopping/stopped，并另有 available 与最近脱敏错误。

记录数据库队列拒绝、追加失败、读取错误、来源断线、能力不可用、unknown 调用和停止失败。首版用结构化日志及只读状态接口即可，不先搭建监控平台。

## 6. 备份与手工恢复

本版不建设在线备份服务，但运维须遵守 SQLite 的机制：可以使用受支持的备份 API，或停止宿主并正确关闭连接后复制一致的存储；不能在 WAL 活跃时只拿主 .db 文件当完整备份。[R3](references.md#r3)

备份网关不等于备份 Agent 自己的会话、Consumer 进度与 in_flight、插件私有状态、凭据或附件。第一次依赖真实重要数据前，用户明确故障域、保留和恢复目标，另做对应演练。

恢复旧副本时：先停止相关组件并禁用外部写，备份当前状态；把恢复副本作为新的存储历史并更新 store_id；分别检查应用进度、Consumer 未决输入、Agent 会话及原 in_progress/unknown 调用；选择新起点或只读核验，确认后才启用明确范围的外部写。不要只改 store_id 或清除 in_flight 后自动重播原 prompt。Consumer 的逐条人工处置见[应用消费](applications.md)。

普通启动无法辨识文件是原库还是旧备份，这项流程是显式运维前置。首版没有自动回滚恢复保证。

Consumer 的单条人工处置已提供离线命令 npm --silent run consumer:recover。它使用正式入口同一数据目录 flock，锁占用退出 75；只读核对数据库，不执行 in_progress → unknown 的普通启动恢复。备份在插件私有 recovery/ 目录中先于消费状态更新持久保存，成功输出备份路径和新位置，失败不输出原始状态或原因。用法、恢复语义及输出丢失/目录同步失败时的检查步骤见 [M1-05 运行记录](experiments/m1-operations.md)。这不是存储回滚、任意改位置或补发工具。

## 7. 部署边界

默认只监听 loopback；远程访问需要配置经过验证的 TLS 入口，token 不出现在 URL。OneBot 服务连接地址与访问 token 属于部署配置；不自动发现并连接用户账号。

数据目录占用由操作者监看，首版不自动删除。以后需要保留窗口、多个宿主、强隔离或持续采集完整性时，先明确目标再扩展；不以当前演示成功推导长期可用性。
