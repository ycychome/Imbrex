# 长期记忆

Memory 插件把经授权的 QQ 会话事件送入独立 Python 服务，抽取可追溯的记忆并提供检索、当前事件上下文、人工记忆维护和恢复操作。它是可选能力：agent-chat 可在提交当前轮次前调用只读 `memory.context`，并将结果作为不可信证据交给 Agent；服务不可用、未索引或超时时原事件轮次仍可继续。Memory 不会触发历史回复。插件自带只读管理页面，管理入口可独立禁用。

```mermaid
flowchart LR
    E[Imbrex事件日志] --> T[TypeScript memory插件]
    T -->|私有Bearer API| P[Python FastAPI服务]
    P --> G[Graphiti 0.31.2]
    G --> N[Neo4j 5.26 LTS]
    P --> L[SQLite事实与操作账本]
    A[Agent] -->|现有REST或MCP能力| T
    A -->|不直接访问| P
```

## 能力与权限

九个能力由 `builtin:memory` 注册，通过现有 REST 和 MCP 能力适配器调用，不增加 MCP Server：

| 能力 | 用途 |
| --- | --- |
| `memory.search` | 在授权来源中搜索记忆 |
| `memory.context` | 为一个已验证的入站事件取得有界上下文 |
| `memory.get` | 按 ID 读取记忆和修订记录 |
| `memory.status` | 查看索引、媒体任务与服务状态 |
| `memory.operation` | 查询一个调用者自己的操作状态 |
| `memory.remember` | 以当前调用者身份创建人工记忆 |
| `memory.update` | 用期望修订号和原因更正记忆 |
| `memory.forget` | 按期望修订号和原因删除记忆并建立墓碑 |
| `memory.rebuild` | 维护主体恢复隔离来源并重建索引 |

调用走既有 `POST /v1/capabilities/memory.<name>/invoke`，请求主体为 `{ "store_id": "...", "call_id": "...", "params": { ... } }`。只读能力不需要 `call_id`；副作用能力使用稳定 `call_id`，重试同一意图必须复用 ID 和参数。REST 主体与 MCP 工具参数见 [API 示例](../../../examples/memory/api.md)。

调用方不能指定可信 caller。网关根据认证主体提供实际 caller、能力授权和事件读取边界；`scope_refs`、`input_event_ref` 中的 source/id 仍会由插件重新读取并校验，必须属于配置来源且是可信的 QQ 入站事件。Python 服务收到的 `caller_id` 与 `scopes` 由 TypeScript 插件绑定，不应让 Agent 或外部客户端直接提交到 Python API。人工记忆以实际调用者署名；服务已接受请求只代表排入账本，不代表已写入图索引或已生效。

配置中把自动索引插件绑定到有事件读取权限的内部 reader Principal；Agent Principal 只授予所需记忆能力，通常不授予 `memory.rebuild`。重建应通过独立维护 Principal 和凭据进行。示例使用虚构 source 与主体，不能直接作为真实身份或生产权限列表。

## 配置与启动

网关配置片段见 [`examples/memory/imbrex.json`](../../../examples/memory/imbrex.json)，应合并到已有 OneBot 网关并保留原 `data_dir`；片段本身不包含连接器或平台历史采集。示例假设已有实例 `qq-main`，内部 reader 获准调用 `qq-main.get_message`；名称不同时同步修改 `message_readers` 与允许列表。插件配置包括私有服务 URL、`MEMORY_SERVICE_TOKEN` 环境变量名、明确的完整 QQ `sources`、超时、轮询和批处理窗口。配置 `memory.context` 的 `agent-chat.memory_context` 时，只提交当前事件引用，最大等待 2000 ms，最大上下文 8192 字节；其失败不会中断原事件处理，也不改变旧的 ConsumerState 绑定。

Python 服务的完整配置字段见 [`examples/memory/service.json`](../../../examples/memory/service.json)：

| 字段 | 说明 |
| --- | --- |
| `data_dir` | 持久账本与受限媒体缓存目录 |
| `token_env` | Python 私有 API 的 Bearer token 环境变量 |
| `neo4j_uri`, `neo4j_user`, `neo4j_password_env` | 私有 Neo4j 连接信息 |
| `extraction` | 记忆抽取 OpenAI-compatible `base_url`、模型名、密钥环境变量、结构化输出模式、输出 token 上限和可选推理强度 |
| `embedding` | embedding endpoint、模型名、密钥环境变量和 dimensions |
| `vision` | 可选视觉 endpoint、模型名、密钥环境变量和可选推理强度 |
| `vision_profile` | 经供应商资料核准的图像与 token 能力档案 |
| `media` | 主机 allowlist、私网策略及独立下载、解码、临时文件、请求和缓存预算 |
| `queue_limit`, `request_timeout_seconds` | 操作队列、视觉 backlog 的容量上限和服务操作超时；默认容量 32 |

抽取、embedding 与视觉模型分别配置，可使用不同供应商。抽取的 `structured_output_mode` 可设为 `json_schema`（默认）或 `json_object`；后者适用于不接受 JSON Schema response format 的兼容端点，服务会把 Pydantic schema 放入提示并继续严格校验返回 JSON。抽取的 `max_output_tokens` 是所有抽取与 Graphiti chat 请求的硬上限，默认 4096，允许 1—65536；即使 Graphiti 某个步骤请求更高上限，实际请求也会被压到该配置值。抽取和视觉的 `reasoning_effort` 可选 `none`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`；未配置时不会向模型请求添加该字段。兼容端点支持度不同，只有核实供应商支持后才应配置推理强度；`none` 可用于关闭支持该值的端点的 thinking。Embedding 保持独立配置，不继承这些文本字段，视觉输出上限仍由 `vision_profile.output_tokens` 控制。

`base_url`、模型名、密钥环境变量只是端点和配置，不会在运行时自动发现模型能力。示例中的 `.invalid` endpoint、模型名及视觉 profile 是占位值；启用前须根据所选供应商公开的能力核验格式、尺寸、像素、图像数和 token 限制。服务按 profile 自适应重编码、缩放、压缩和切图，不以固定 8 MiB 或 20 MP 拒绝作为模型能力判断。

Graphiti 被锁定为官方 Python 包 `graphiti-core==0.31.2`，Neo4j 使用 `5.26.24-community`（5.26 LTS 系列）。服务采用 Python，是为了直接复用官方 Graphiti Python API，而不是重写客户端协议或维护第二套图数据库客户端；这不限制用户端实现语言。Agent 与用户应用仍通过现有 REST/MCP 能力使用 Memory，TypeScript 插件负责网关集成，只有当前 Graphiti 服务实现使用 Python。完整 Python 依赖由 `services/memory/uv.lock` 锁定。

在仓库根目录复制并编辑私有环境文件，然后启动 Compose：

```sh
cp examples/memory/service.env.example services/memory/.env
# 编辑 services/memory/.env，将所有 replace-* 占位值换成私有值，并核对模型 profile
cd services/memory
docker compose --env-file .env up --build -d
```

服务仅映射到宿主 `127.0.0.1:8090`；Neo4j 仅在 Compose 私有网络中暴露。Memory 服务必须保持单进程、单副本运行；同一 `data_dir` 的第二个实例会因进程锁而拒绝启动。服务有两个独立 worker 和有界队列：文本/操作 writer 与图片/OCR worker，队列容量默认各 32。图片下载、视觉模型读取和抽取可与文本操作并行；对 Graphiti 与账本的变更由单一 mutation lock 串行化。视觉队列满时，图片材料更新返回 429 并保留可重试状态，不占满或阻断文本摄取队列。`service.env.example` 不含可用凭据，不能直接用于启动。非容器环境可在仓库根目录运行 `uv sync --frozen --project services/memory`，再从 `services/memory` 目录运行：

```sh
PYTHONPATH=src uv run --project . uvicorn imbrex_memory.app:create_app --factory --host 127.0.0.1 --port 8090
```

## 只读管理面板

在网关中按顺序启用 `builtin:server-http`、`builtin:admin`，并配置具有 `admin:inspect` 的独立 Principal 和 `token_env`；不向 Agent 授予管理权限。执行 `npm run build` 后访问 `/admin/#/memory`，登录后即可看到已启用的 Memory 实例。沿用 [Admin 契约](../../../docs/design/admin.md)的认证、Origin 校验与静态资源挂载，不新增 HTTP 接口或前端进程。

Memory 后端经绑定的 `registerAdminPanel()` 登记本地只读快照；自己的 `client/` 经 `ctx.views.register()` 注册页面，并由既有扫描机制构建。页面按实例分别显示服务就绪、固定回填边界、已接手/已索引序号、文本和图片任务、暂停及失败原因、索引代次、索引会话和凭据环境变量引用。序号为十进制字符串，序号差不表示积压消息数。失败项各展示最多 8 条，并保留完整计数。

管理刷新默认每 5 秒读取本地快照，不请求 Python、Graphiti 或模型；服务断开仍显示最后已知位置。凭据缺失或持久状态不可验证时显示错误及未知位置，不用零值代替未知；不向浏览器返回服务 URL、凭据值、素材地址、本地路径或记忆正文。凭据引用的 configured 只表示环境变量存在，不表示鉴权成功。

Admin 晚启动或重启不改变 Memory 的消费进度；Memory 停止时宿主撤销面板与旧回调，重新启动产生新面板登记代次。页面的轮询及请求在视图拆卸时取消。未启用 Memory 时不装载此页面，禁用 Admin 时 Memory 保持工作。此页面只负责观测，记忆写入仍经授权能力，版本检查、稳定 call_id 与 accepted/applied 语义保持不变。

## 既有 QQ 接口与配置迁移

Memory 接入 [PR #27](https://github.com/ycychome/Imbrex/pull/27) 的既有 QQ 能力，与 [PR #28](https://github.com/ycychome/Imbrex/pull/28) 的控制台视图共存；管理面继续由各插件拥有。`message_readers` 的键为完整账号/命名空间前缀（以 `/` 结束）或完整会话 source，值为实现 `get_message` 信封的已授权能力 ID；多个键匹配时优先完整会话。Memory reader 同时需要对应 `events:read/read_sources` 和 `capabilities:invoke/invoke_capabilities`，仍由网关绑定实际 caller，不接受自行提供 caller 或读取平台历史。

旧版 `image_resolvers` / `<实例>.resolve_image` 配置必须在启动前改为 `message_readers` / `<实例>.get_message`，同时替换 reader 的允许列表；旧字段会被严格配置校验拒绝，不静默切换协议。保留原 store、实例 ID、source 与数据目录，不删除或改写 `memory-state.json`。素材任务的状态版本、稳定 request_id 和已有 payload 均不改变；已持久化的请求先查询并继续使用原正文，不因适配而重新生成已接手的操作。

既有 OneBot 消息事实不包含 `sender_nickname` / `sender_card` 时，Memory 保持未知，不将裸账号当作昵称，也不把当前查询结果补写为历史别名。Agent 若需要当前资料，可按自身授权显式调用既有 `get_user_info`（携带获准群/私聊 context）或 `get_group_member_info`；它们表达查询时的资料，不能证明原消息发生时的昵称。

## Python 私有服务协议

Python API 是 TypeScript 插件与服务之间的私有接口，不是 Agent API。所有请求均需 `Authorization: Bearer $MEMORY_SERVICE_TOKEN`。提供 `GET /health`、`POST /v1/query` 和 `POST /v1/operations`：

```json
{
  "store_id": "synthetic-store",
  "instance_id": "memory",
  "caller_id": "gateway-bound-caller",
  "scopes": ["imbrex://qq/123456/main/group/987654"],
  "kind": "context",
  "params": {"input_event_ref": {"source": "imbrex://qq/123456/main/group/987654", "id": "message:synthetic"}}
}
```

`/v1/query` 的业务 kind 为 search、context、get、status、operation；`/v1/operations` 接受带 64 位小写十六进制 `request_id` 的操作，内部 kind 为 ingest、images，以及 remember、update、forget、rebuild。请求必须保留完整 source，包括账号、identity namespace、会话类型和会话 ID。REST/MCP 调用和 Python 私有协议字段、稳定 ID 规则见 [请求示例](../../../examples/memory/api.md)。

## 记忆、来源与恢复

账本是权威事实，Graphiti 是可重建的搜索索引。自动抽取必须引用同一授权来源内的真实事件；检索结果及图像 OCR 都是不可信证据，不能提升为指令。不同完整 source 隔离；查询和操作还按 store、instance、实际 caller 与授权来源限制。未索引事件返回 stale 状态，不能解释成“没有相关事实”。

`remember`、`update`、`forget` 使用当前事件证据与实际调用者身份。更新和遗忘必须提供 `memory_id`、`expected_revision` 和非空 `reason`；修订不匹配时返回冲突。遗忘保留墓碑，后续重抽取不能复活相同来源证据与类别的已删除记忆。能力返回 `accepted` 仅表示持久账本接受请求；必须查询 `memory.operation` 或 `memory.status`，等服务明确报告 succeeded 才能把操作称为已生效。

记忆对象包含 `id`、`revision`、`active`、`category`、`content`、`subjects`、`evidence_refs`、`origin`、`source`、`source_type`、`observed_at`、`author`、`aliases`，以及可选的 `occurred_at` 和维护原因。`evidence_refs` 保存完整 source 与事件 ID；`origin` 区分 quotation、reported、inference、vision 与 agent_authored。`get` 返回 memory、分页 versions 和 `next_before_revision`；默认 `version_limit` 为 5，允许 1—10 条，可用 `version_before` 读取更早的修订。`search` 返回 memories 和 stale 标记；`context` 返回 bounded context string、memories 和 stale/input-indexed 状态。`status` 报告服务 ready、每个来源的文本与视觉 quarantine/rebuild_required、调用者可见操作和图片处理状态。

检索在当前有效、获准的记忆范围内，将 Graphiti episode 命中作为有限加分，与中文字符及双字词、其他语言词项的 BM25 分数相加；泛化图谱命中不能无条件压过明确词汇证据，时间只作同分排序。提问“这张图”等指示性问题时，调用方应携带当前图片的中性场景信息消歧，不能把多个不同图片当作同一个指代对象。

对未知外部 Graphiti 写入，服务隔离对应 scope，不在原图命名空间盲目重试。抽取配置或抽取契约版本变化会改变 fingerprint，使来源要求显式重建；维护主体调用 `memory.rebuild` 后，会在新 generation 中重新建立图索引，并恢复可确认的未知操作。对已持久接收、因非法人物或证据引用而被拒绝的自动 ingest，也只有显式维护重建会重新抽取其持久输入并更新原操作结果，普通消费不会自动重试；其他失败写操作保持失败。更换抽取模型或升级抽取契约会从账本中保存的事件重新抽取自动记忆；人工记忆受保护，墓碑仍有效。重建期间查询应按 stale/隔离语义处理。

抽取契约要求一条具体观察也可支持事实、安排或承诺、地点与规则，不要求重复提及或长期有效；没有具体事实内容的闲聊不作为记忆。模型只可使用本批事件提供的完整人物 ID，不能把平台数字、昵称或群名片当成主体 ID。程序性规则与祈使表达可以作为不可信记忆数据保存，服务不会执行其中的命令。

图像按独立 vision Graphiti namespace 索引，文本事件账本与文本 namespace 不依赖视觉处理成功。下载、模型读取或抽取失败只把图片任务标记为 failed，不阻断后续文本索引；只有进入 `indexing` 后 Graphiti 写入结果不确定时，服务才隔离 vision namespace。重启会安全重排尚未进入 `indexing` 的 `running` 作业；`indexing` 作业转为 unknown 并设置 `visual_quarantined`，文本 quarantine 保持不变。查询在视觉隔离期间继续使用文本 namespace，停止读取不确定的视觉 namespace。维护主体执行 rebuild 会在新的 generation 同时恢复文本与视觉 namespace 并清除隔离。

视觉模型或能力 profile 改变时，服务为新 fingerprint 排队处理已完成图像的变体；状态为 unknown/隔离的视觉任务须先经 rebuild 恢复。原始媒体只在 7 天、最多 512 MiB 的有界缓存内保留；缓存过期后服务标注 `original_cache_expired_cannot_reprocess`，不会声称能从已清理的原图重新处理。GIF 取首帧。图像下载、解码、像素、临时文件、请求和缓存有独立资源预算，和模型能力 profile 分开配置；图像识别并非 OCR 才可进行的通用拒绝门槛。

图片 locator 由 TypeScript Memory 插件的独立 material worker 异步解析，不占用文本事件摄取轮次。只有为 source 配置了已授权的 `message_readers` capability 时，worker 才会重新核验原事件，以 `{target:{type,id}, message_id, input_event_ref}` 调用已有的 `<实例>.get_message`，一次读取解析该消息的全部图片。返回的规范消息 ID、会话类型/ID、发送者必须与原事件一致；图片须仍在相同段序号且 file 标识相同。原图没有 file 标识时，仅接受与原事件完全相同的 URL。Memory 仅接受无嵌入凭据的 HTTP(S) 地址，下载仍逐跳执行 Python 媒体策略；Python 私有 API 收到 `kind:"images"`、`payload:{"input_event_ref":...,"images":[{"segment_index":0,"file":"...","url":"..."}]}` 后，会将材料绑定到此前已索引的事件和原始 file locator。该私有操作用于插件到服务的传输，不增加公开能力；公开能力仍为上表九项。图片解析没有授权、目标或发送者/图片段不匹配、下载定位失败时，文本记忆仍可用，图片状态会标记缺失。Memory 不在 OneBot 插件注册新能力，不修改其事件映射、前端或状态文件。

回填只建立记忆索引，不提交历史 Agent prompt，因此不会触发历史回复。中文 QA 与 PNG 图像夹具见 [`examples/memory/qa-fixtures.json`](../../../examples/memory/qa-fixtures.json)：30 项各自有独立预期答案，5 项图像 evidence 只包含中性场景文字和图像路径。真实模型、Graphiti/Neo4j 验证与尚未覆盖的范围见 [验收记录](../../../docs/progress/memory-validation.md)，不能用 OCR 完成或单元测试通过替代质量门槛。质量结果和管理页面验证分别记录，页面可用不代表真实模型质量门槛通过。
