# HTTP 契约与示例

统一开发基线 0.3。**本文件规定 M0 已实现的线上表达，SSE 等后续接口仍未启用。** 事件行为见 [事件与存储](storage-and-recovery.md)，能力行为见 [能力契约](capabilities.md)。

M1-02 已在同一监听提供 `/v1/mcp`，采用 MCP Streamable HTTP 而非本文件的 REST 路由表达；共用领域授权、类型与调用语义，具体工具、参数及错误映射见 [Agent 接入](agent-integration.md)。此端点不启用事件订阅 SSE。

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

`GET /v1/plugins` 返回 `{store_id,plugins}`。每项包含 id、module_name、state、required、available，以及可选的脱敏 last_error。state 为 waiting/loading/active/failed/stopping/stopped；插件实例配置、访问 token 和消息正文不返回。

该接口只读；管理者通过配置与宿主重启管理加载，受信开发/测试入口可单独 start/stop，不承诺 HTTP 远程管理功能。

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
