# HTTP 契约与示例

统一开发基线 0.3。**本文件规定线上表达；SSE 等后续接口未启用。** 事件行为见 [事件与存储](storage-and-recovery.md)，能力行为见 [能力契约](capabilities.md)。

M1-02 已在同一监听提供 `/v1/mcp`，采用 MCP Streamable HTTP 而非本文件的 REST 路由表达；共用领域授权、类型与调用语义，具体工具、参数及错误映射见第 13 节。此端点不启用事件订阅 SSE。

协议由 api-rest 与 adapter-mcp 插件提供，/v1 行为保持不变。管理入口使用 /api/admin/*，具体接口与权限见第 12 节。

## 1. 公共约定

- 路径前缀 `/v1`，请求/响应为 UTF-8 application/json；发布封装内部 event 才是 CloudEvent。
- 全部接口要求 bearer 认证；caller_id 不接受请求体填写。默认 loopback 部署。
- 协议对象未知字段、重复查询参数、非法序号或超限内容返回错误；event.data 内的业务字段不由内核解释。
- JSON 使用普通解析后的值，拒绝非有限值、非 JSON 对象和超过结构限制的值；精确 ID/大数使用字符串，不承诺原始 JSON 字节保真。
- 身份、类型、URI、查询及配置的文本字段必须是良构 Unicode，拒绝未配对的 UTF-16 代理项，避免 UTF-8/SQLite 转码造成身份碰撞。事件 data 仍按 JSON 值透传并存为 JSON 文本。
- 内部序号为 bigint；所有线上 seq、after_seq、through_seq、next_after_seq、latest_seq 均为规范十进制字符串，范围 0 到 9223372036854775807。
- 服务端生成时间为 UTC 毫秒 ISO 字符串。来源 event.time 保留有效 RFC 3339 表达；未知时省略。
- 状态性数据操作绑定 store_id：写请求放在 body，读请求放在 query。info、capabilities 和 plugins 的查询无需预先提供，但响应带当前 store_id。
- 客户端可以忽略响应新增的可选字段；未知状态不能默认为成功。

## 2. 统一上限与测试默认

这些是统一开发基线 0.3 的初版值，尚未经生产验证。实现集中定义，文档和错误消息引用同一值。

| 项 | 初版值 |
| --- | --- |
| HTTP 请求体 | 最大 256 KiB；首版不接压缩请求体 |
| 序列化 `{event,parents}` | UTF-8 最大 64 KiB；普通 JSON 表示，不是 JCS |
| 能力参数 / 结果 | 各最大 64 KiB |
| OneBot 原始 WebSocket 帧 | 最大 64 KiB；过大帧拒绝并报告来源覆盖风险 |
| 能力 schema / 已注册能力数 | 每份最大 16 KiB / 最多 128 个 |
| 能力 description / schema_version | 最大 4096 / 128 UTF-8 字节 |
| handler reason.code / reason.message | 最大 128 / 4096 UTF-8 字节 |
| source、dataschema | 各最多 1024 UTF-8 字节 |
| event.id、type、subject | 各最多 256 UTF-8 字节 |
| parents | 最多 16 个，重复 EventRef 拒绝 |
| JSON 嵌套 | 最多 32 层 |
| limit | 默认 50，范围 1—100 |
| call_id | 1—128 ASCII 字符，字母数字及 `._:-` |
| 插件/主体/来源身份命名空间 ID | 1—64 字符，以小写字母开头，其余小写字母、数字、下划线或短横线 |
| local capability name | 1—64 字符，以小写字母开头，其余小写字母、数字或下划线 |
| 数据库待处理命令 / 活跃 HTTP 数据请求 | 各最多 32 个 |
| 同时执行的能力 handler | 最多 8 个；不增加无界调用队列 |
| 能力派发超时 | 测试默认 15 秒 |
| 参考消费者补查 / 自动回复消息年龄 | 测试默认 1 秒 / 5 分钟 |

请求和单条内容上限在派发前检查；按最大页和最大记录可计算有界响应规模，本版不再引入独立扫描预算和分页字节游标。业务运行规模扩大时以实际内存与延迟测量调整这些参数。

## 3. 资源表

| 方法与路径 | 权限 | 结果 |
| --- | --- | --- |
| GET /v1/info | 已认证主体 | 实例标识与当前日志边界 |
| POST /v1/events | events:write + 来源允许 | 201 created 或 200 duplicate_identity 回执 |
| GET /v1/events | events:read | 200 有界读取页 |
| GET /v1/events/lookup | events:read + 来源允许 | 200 当前记录；不存在为 404 |
| GET /v1/capabilities | capabilities:list | 200 当前获授权且可用的能力 |
| POST /v1/capabilities/{id}/invoke | capabilities:invoke + ID 允许 | 只读结果，或持久调用状态 |
| GET /v1/calls/{call_id} | calls:read，且记录属于当前主体 | 200 调用记录 |
| GET /v1/plugins | runtime:inspect | 200 脱敏插件运行状态 |

首版没有 subscription、ACK、reset-purpose、GC、远程插件安装或调用自动重试 API。SSE 未启用时不提供流接口；不能返回占位成功。

## 4. 实例信息

`GET /v1/info`：

```json
{
  "store_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "version": "0.1.0-dev",
  "latest_seq": "100",
  "features": {"capabilities": true, "call_records": true, "sse": false}
}
```

version 是运行程序的构建版本；这里是示例，不是已发布版本。latest_seq 是读取当时的边界，后续可能增长。

## 5. 发布事件

`POST /v1/events` 请求：

```json
{
  "store_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "event": {
    "specversion": "1.0",
    "source": "imbrex://fixture/messages",
    "id": "message-001-created",
    "type": "fixture.message.created",
    "datacontenttype": "application/json",
    "time": "2026-10-18T00:00:00Z",
    "data": {"text": "hello"}
  },
  "parents": []
}
```

新建返回 HTTP 201；重复身份返回 HTTP 200，并只把 status 改为 duplicate_identity、使用原序号。两种情况结构一致：

```json
{
  "status": "created",
  "store_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "seq": "101",
  "accepted_at": "2026-10-18T00:00:01.000Z",
  "event_ref": {"source": "imbrex://fixture/messages", "id": "message-001-created"}
}
```

parents 省略时为空；元素只有 source/id。上层 event 的可选字段为 time、subject、dataschema。data 中的精确数字由生产者编码，不能把已舍入值当原始数值证明。

## 6. 读取和查单条

`GET /v1/events` 必填 store_id、after_seq；可选 limit、source_prefix、type。首版不接受其他过滤操作。

例如 after_seq=100、source_prefix=imbrex://fixture/：

```json
{
  "store_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "records": [
    {
      "seq": "101",
      "accepted_at": "2026-10-18T00:00:01.000Z",
      "event": {
        "specversion": "1.0",
        "source": "imbrex://fixture/messages",
        "id": "message-001-created",
        "type": "fixture.message.created",
        "datacontenttype": "application/json",
        "time": "2026-10-18T00:00:00Z",
        "data": {"text": "hello"}
      },
      "parents": []
    }
  ],
  "through_seq": "105",
  "next_after_seq": "105",
  "caught_up": true
}
```

此例假定 102—105 没有获授权的匹配事件。caught_up 只对当前过滤、权限及 through_seq 成立；应用保存进度的时机见[应用消费](applications.md)。达到条数上限且还有匹配时，候选位置停在最后一条已返回记录。

`GET /v1/events/lookup` 必填 store_id、source、id。先检查来源读取权限，再查记录。响应为 `{store_id, record}`，record 与读取页中的元素相同。不存在返回 event_not_found，不证明该原生事件从未发生。

## 7. 能力发现

`GET /v1/capabilities` 返回 store_id 与 capabilities 数组，每项如下：

```json
{
  "id": "mock.echo",
  "plugin_instance_id": "mock",
  "description": "返回给定文本，用于验证工具调用连接。",
  "schema_version": "1",
  "is_side_effectful": false,
  "input_schema": {
    "type": "object",
    "properties": {"text": {"type": "string", "maxLength": 2000}},
    "required": ["text"],
    "additionalProperties": false
  }
}
```

handler 和私有配置不出网关。列表结果不保证下一瞬间仍在线，执行前再次检查。

## 8. 调用能力

只读 mock.echo 请求 `POST /v1/capabilities/mock.echo/invoke`：

```json
{
  "store_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "params": {"text": "hello"}
}
```

成功 HTTP 200：

```json
{
  "store_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "kind": "result",
  "capability_id": "mock.echo",
  "result": {"text": "hello"}
}
```

外部写请求增加必填 call_id。`POST /v1/capabilities/qq-main.reply/invoke` 的示例请求如下；只有真实范围明确、能力注册并获授权后才可执行，示例不表示当前已连接 QQ。

```json
{
  "store_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "call_id": "reply-decision-001",
  "params": {
    "input_event_ref": {"source": "imbrex://qq/123456/main/group/987654", "id": "message-001-created"},
    "text": "收到。"
  }
}
```

外部写响应及 `GET /v1/calls/{call_id}?store_id=...` 的查询响应均为：

```json
{
  "store_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "kind": "call",
  "call": {
    "call_id": "reply-decision-001",
    "capability_id": "qq-main.reply",
    "schema_version": "1",
    "params": {
      "input_event_ref": {"source": "imbrex://qq/123456/main/group/987654", "id": "message-001-created"},
      "text": "收到。"
    },
    "status": "unknown",
    "reason": {"code": "provider_timeout", "message": "尚未获得可确认的发送结果。"},
    "created_at": "2026-10-18T00:01:00.000Z",
    "updated_at": "2026-10-18T00:01:15.000Z"
  }
}
```

call.status 为 in_progress/succeeded/failed/unknown。succeeded 必有 result；failed/unknown 必有 reason；in_progress 没有终结结果。GET 查询成功总是 200；POST 得到 in_progress 时为 202，其余已记录状态为 200。200 不等于远端发送成功。

查询参数和结果只对当前主体公开。新调用可用性与已有记录查询分别处理，原插件卸载不删除记录。

call_id 是不透明标识，路径段百分号解码一次后保留原值，点号和双点号也是合法 ID。查询这类 ID 时客户端须保留实际请求路径，不能在发送前把点段归一化；服务端不将其解释成文件路径。

## 9. 插件状态

`GET /v1/plugins` 返回 `{store_id,plugins}`。每项包含 id、module_name、enabled、state、required、available，以及可选的 client_entry 和脱敏 last_error。state 为 waiting/loading/active/failed/stopping/stopped；client_entry 是插件自携前端 ESM 的同源静态路径（/admin/plugins/<module>/<entry>），仅表示可加载入口，不代表视图已注册或权限通过。插件实例配置、访问 token 和消息正文不返回。

该接口继续只读；当前 M1 通过配置与宿主重启管理加载。M2 管理动作使用专属 /api/admin/* 入口及管理权限，不改变 /v1/plugins 的语义，也不把 runtime:inspect 升级为操作权限。

## 10. 错误契约

所有有结构响应的失败使用以下形状：

```json
{
  "error": {
    "code": "store_mismatch",
    "message": "请求属于另一份存储，请显式检查读取或调用状态。"
  },
  "request_id": "request-001"
}
```

| HTTP | code | 客户端含义 |
| --- | --- | --- |
| 400 | invalid_request / invalid_event / invalid_params / invalid_position | 修正输入；尚未据此执行操作 |
| 401 | unauthorized | 凭据缺失或无效 |
| 403 | forbidden / writes_disabled | 当前授权或配置拒绝新操作 |
| 404 | not_found / event_not_found / capability_not_found / call_not_found / feature_unavailable | 当前资源不可用；不能跨未知历史推断从未执行 |
| 409 | store_mismatch / position_ahead / call_conflict | 显式核对存储、位置或原调用参数 |
| 413 | payload_too_large | 请求或内容超过本版上限 |
| 429 | busy | 在接纳前拒绝排队或新执行，使用同一逻辑身份重试 |
| 503 | storage_unavailable / provider_unavailable | 基础设施不可用；查询原事件/调用，不自动换新身份 |
| 500 | internal_error | 未分类失败；不能由此推断远端没有执行 |

写调用一旦被记录并可能派发，结果优先表示为 call 状态；网络断开或记录更新失败仍可能没有结构响应。客户端对这些情况保留同一 call_id。HTTP 的 4xx/5xx 不是新的业务意图。

## 11. 类型与生成文档

实现以共享领域类型和运行时校验器承载本契约，HTTP 适配层负责 bigint/字符串和字段命名映射。M0 类型稳定后可生成 OpenAPI/客户端，不另外手写一套与运行实现独立演进的完整 schema。OneBot 原始协议报文只属于连接器，不透传为 Imbrex 的外部调用契约。

## 12. 管理 API

管理 API 位于 /api/admin/*，静态资产配置见 [Admin 契约](admin.md)。以下只读资源已提供；操作资源随对应功能补齐，不为未实现操作返回占位成功。

GET /api/admin/info 不接受 query 或业务 body。每次请求须有 Bearer 凭据及 admin:inspect；Origin 存在时须等于实际监听 origin，不使用 Cookie 或 loopback 免密。200 响应：

```json
{"store_id":"9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d","latest_seq":"4","version":"0.1.0-dev","plugins":[]}
```

store_id 为数据库身份；latest_seq 沿用规范十进制字符串；version 为产品版本，与 config_version 和文档基线分别管理。缺失或无效凭据返回 401 unauthorized，权限/Origin 不符返回 403 forbidden，多余 query 返回 400 invalid_request，未加载 Admin 时返回 404 not_found。错误信封和 x-request-id 沿用第 10 节。

所有管理查询均要求 admin:inspect，响应设置 Cache-Control: no-store。admin:operate 不包含读取权限。除下表声明的参数外，重复或多余 query 一律拒绝。事件与 calls 来自原持久数据，不通过通知拼接历史。

| GET 资源 | 参数 | 200 响应 |
| --- | --- | --- |
| /api/admin/info | 无 | store_id、latest_seq、version、plugins；plugins 与 /v1/plugins 的状态字段相同（含 enabled、可选 client_entry） |
| /api/admin/panels | 无 | {store_id, panels:[{instance_id,module,generation,title,icon}]} |
| /api/admin/panels/:instance | 无 | {store_id,instance_id,module,generation,data:{status:{tone,label},metrics:[{label,value,hint?}],data:{...}}}；读取失败时以 error:{code,message} 替代 data |
| /api/admin/events | store_id、after_seq 必填；limit、source_prefix、type 可选 | 与 /v1/events 相同的记录和分页字段，管理权限可读本网关全局事件 |
| /api/admin/capabilities | 无 | {store_id,capabilities:[...]}；既有能力描述加 available，包含仍登记但不可用的能力 |
| /api/admin/calls | store_id 必填；limit 默认 50、最大 100；caller_id、status、after_caller_id、after_call_id 可选 | {store_id,calls:[...],next}；每条 call 添加 caller_id，next 为 {caller_id,call_id} 或 null |
| /api/admin/configuration | 无 | {config_version,external_writes_enabled,mcp_url,principals,plugins} |

面板列表最多 128 项，单实例 data 最多 64 KiB、读取截止 5 秒；status.tone 仅允许 ok/warning/error/idle/unknown，metrics 最多 32 项，label/value 为非空字符串，hint 可选，data 为 JSON 对象。读取失败只返回该实例的 admin_panel_read_failed，不返回原始异常。相同实例已有读取未结束时返回 429 busy。generation 是本次登记的不透明标识，Admin 重启不变，业务实例重新登记后改变；不替代实例 ID 或 store_id。Shell 不按 module 或实例类型分支；各插件视图只消费自身面板的 status/metrics/data，module 用于插件定位自己的面板。不符合声明式格式的数据回退为原始 JSON。未登记或已卸载实例返回 404。

调用审计按 (caller_id,call_id) 的 SQLite BINARY 字典序分页，两项 after 参数必须同时出现，从 next 原样填入；不是时间排序。status 仅允许 in_progress/succeeded/failed/unknown。各页为新的查询视图，状态可改变，新调用可插入旧位置之前；刷新从头查询可观察新变化，不承诺跨页快照。普通 /v1/calls/{call_id} 仍只能由所属主体查询。

configuration 的 principals 包含 id、permissions、read_sources、write_sources、invoke_capabilities、credential；credential 为 {name,configured} 或 null，只说明 token_env 引用及是否已加载。plugins 包含 instance_id、module、principal_id、enabled、required、configuration；外部模块名统一为 external，不回显任意参数。OneBot configuration 提供采集范围和凭据引用；Agent 提供触发范围，独立 pi 配置在对应面板内查询。mcp_url 为 HTTP origin 的 /v1/mcp 地址，不承诺该协议插件当前可用。

其他管理交互遵守以下已定稿边界：

| 管理交互 | 权限与不变量 |
| --- | --- |
| 全局/插件状态、事件浏览、能力清单、跨主体调用审计、脱敏配置 | admin:inspect；有界查询和十进制序号；不复用 calls:read 绕过主体限制；不回传秘密 |
| 执行已注册的插件管理动作 | admin:operate；服务端验证输入 schema、稳定实例和当前运行状态；不能凭按钮可见性授权 |
| 保存/应用 filter 或托管 Agent 配置 | admin:operate；区分保存与生效，按轮次边界或受控 Agent 重启应用 |
| 确认/放弃当前未决输入、单会话重置 | admin:operate；匹配 store_id、实例、输入引用/seq 或完整会话 source，保留备份与原因，不修改原 calls 状态 |

宿主尚未完成所有启用插件的初始化时，已监听的 REST/MCP/Admin 入口返回 503 provider_unavailable，不派发业务请求。请求错误记录公共错误码和 request_id，日志失败不影响响应。

身份通过显式 Principal 的 token_env 引用 Bearer 凭据确定，不接受请求体指定管理员身份，不因 loopback 免认证。Admin 停用后撤销路由，普通 Agent Token 不可调用管理操作。管理操作不发布为 Agent 的 MCP 工具。

状态或配置写入失败不能报告成功；旧页面提交的操作若不再对应当前未决项，应拒绝而不推进其他输入。管理请求断开不等于操作取消，后续应查询实际状态；不得把重新提交操作解释成新的外部发送意图。

## 13. MCP 入口

`/v1/mcp` 由 adapter-mcp 插件提供，在进程内直接复用 events、capabilities、access，保持 core 不依赖 MCP、Cordis 或 HTTP 框架。上下文与动作使用同一个 MCP Server。

### 13.1 暴露范围

| 交互 | 复用的责任边界 |
| --- | --- |
| 实例信息、事件分页与按引用查询 | 现有 info/read/lookup；来源读取授权、store_id 与十进制序号不变 |
| 能力发现 | 只列当前主体获授权且可用的能力，参数 schema 来自现有注册 |
| 能力调用 | 再次校验主体、能力、参数与外部写开关；reply 的目标由可信原事件得出 |
| 调用结果查询 | 使用稳定 call_id，只读本主体记录；保留 in_progress/succeeded/failed/unknown |

只读查询可映射为 Tools，适合资源读取的上下文可映射为 Resources；按实际需要实现，不强制给同一操作提供两套入口。事件正文及其元数据受既有来源授权限制；info 的 store_id/latest_seq 沿用单所有者共享规则。原始平台 Action 不整体映射成工具。

首版沿用静态 bearer token 与 Principal 配置；外部调用方用专用主体。每个请求重新鉴权，MCP session ID 不能替代认证或在主体间复用。发现过滤和真正执行同时受核心授权约束，不能仅靠隐藏名称或模型提示限制工具；暂不另建权限中间层。

外部写必须携带 store_id、稳定 call_id 与能力参数。MCP 请求 ID 不充当 call_id，收到协议成功响应不等于动作成功；响应丢失后查原调用，unknown 不换 ID 自动补发。

### 13.2 工具清单

tools/list 按每次请求的主体权限过滤以下工具。能力清单由 imbrex_list_capabilities 返回，只包含当前获授权且可用的核心注册，保留其完整 input_schema；schema 的根可以是数组、标量或对象。

| MCP 工具 | 必填参数 | 可选参数 / 对应结果 |
| --- | --- | --- |
| imbrex_info | 无 | 与 HTTP info 一致的 store_id、latest_seq 和 features |
| imbrex_read_events | store_id、after_seq | limit、source_prefix、type；与 HTTP 读取页一致 |
| imbrex_lookup_event | store_id、source、id | 返回 store_id、record |
| imbrex_list_capabilities | 无 | 返回 store_id、capabilities，字段与 HTTP 能力发现一致 |
| imbrex_invoke | store_id、capability_id、params | 外部写必填 call_id，只读能力省略；返回核心 result 或 call |
| imbrex_get_call | store_id、call_id | 返回本主体的核心 call；原插件离线后仍可查 |

参数 schema 由 tools/list 提供，未知业务参数拒绝；store_id 为字符串，位置是规范十进制字符串，limit 是 1—100 的整数。字符串、JSON 大小与深度限制沿用第 2 节。SDK 转换前检查原始工具请求，业务 schema 校验使用保留的原始 arguments，不因 SDK 删除字段而放行非法请求。工具发现只是一份当前视图，执行重新检查权限、存储身份、参数与提供者状态，不凭模型提示授权。没有事件写入、原始平台 Action 或任意收件人工具。

工具响应的 content 文本与 structuredContent 提供相同 JSON。核心错误返回 isError=true 和 error.code/message、request_id；外部写结果为 failed、unknown 或 in_progress 时也标记 isError=true，并保留完整 call。查询未知调用成功仅表示查询成功，必须继续检查 call.status；不能从 MCP 协议成功或查询的 isError=false 推断远端动作成功。

### 13.3 传输、认证与清理

采用官方 SDK 的 stateless 模式，每次 POST 创建独立 Server/transport，返回 JSON。客户端正常执行 initialize、notifications/initialized 和后续工具请求；SDK 协商初始化版本，校验后续 MCP-Protocol-Version，未携带版本时使用 SDK 的 2025-03-26 兼容默认。服务端不保存客户端初始化状态，不生成 MCP session ID，身份始终来自当前请求的 Bearer 凭据。

POST 的 Accept 须包含 application/json 与 text/event-stream；初始化后的通知返回 202。GET、DELETE 等其他方法返回 405/Allow: POST；MCP session ID、Last-Event-ID 与批请求拒绝，不提供恢复流、资源订阅或 MCP Tasks。鉴权、Origin、HTTP 请求体失败沿用本文件错误结构；SDK 处理的协议失败使用 JSON-RPC 错误，业务失败使用上节的工具结果。

无 Origin 的本地 CLI 请求可用；携带 Origin 时必须精确等于配置监听地址与实际端口构成的 HTTP origin，不能借请求 Host 头放行其他网站。首接 CLI 不需要额外浏览器跨域配置。请求体最多 256 KiB、JSON 深度最多 32、活跃 HTTP 数据请求最多 32、核心并发 handler 最多 8，所有限制与 REST 共用。

响应完成或客户端断开后关闭该请求的协议实例。已经开始的核心调用继续保存结果，占用的请求预算在收尾完成后释放；断开不触发自动重试或回滚。宿主停用时沿用核心 drain 与 HTTP 关闭流程。
