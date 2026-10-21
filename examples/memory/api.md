# Memory 调用示例

Agent 与运维工具的入口不同：Agent 只通过 Imbrex 已有 REST/MCP 能力入口访问 `memory.*`，不能连接 Python 服务。网关从认证 Principal 取实际 caller，并按该调用者授权、Memory 配置来源和事件日志重新验证每个 source/id。JSON 中的 ref 是待验证目标，不是客户端可自证的身份或权限。

下面使用全虚构的 `store_id`、source 和消息 ID。实际调用须从可信事件读取结果取得 `scope_refs`，不能照抄示例事件引用。

## Imbrex REST / MCP 能力

所有能力使用 `POST /v1/capabilities/memory.<name>/invoke`，请求主体为 `{ "store_id": "...", "call_id": "...", "params": { ... } }`。只读调用省略 `call_id`；remember/update/forget/rebuild 等副作用调用必须用稳定 `call_id`，相同意图重试时复用它。MCP 工具暴露相同能力参数。

为已验证的当前事件取得上下文：

```sh
export IMBREX_TOKEN='从本机密钥管理器注入的网关凭据'
export IMBREX_URL='http://127.0.0.1:8080'
curl -fsS -X POST "$IMBREX_URL/v1/capabilities/memory.context/invoke" \
  -H "Authorization: Bearer $IMBREX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"store_id":"synthetic-store","params":{"input_event_ref":{"source":"imbrex://qq/123456/main/group/987654","id":"message:synthetic"},"timeout_ms":2000,"max_bytes":8192}}'
```

搜索一个来源范围：

```json
{
  "store_id": "synthetic-store",
  "params": {
    "scope_refs": [{"source":"imbrex://qq/123456/main/group/987654","id":"message:synthetic"}],
    "query": "项目成员确认过的交付日期",
    "limit": 8
  }
}
```

读取记忆时可分页查看修订历史。`version_limit` 默认 5，范围 1—10；响应的 `next_before_revision` 可作为下一次请求的 `version_before`：

```json
{
  "store_id": "synthetic-store",
  "params": {
    "scope_refs": [{"source":"imbrex://qq/123456/main/group/987654","id":"message:synthetic"}],
    "memory_id": "synthetic-memory-id",
    "version_limit": 5
  }
}
```

创建人工记忆时，调用主体是网关认证得到的实际 caller。显式 evidence refs 必须是同一授权来源内可读取的真实事件；若省略，插件会把已验证的 `scope_refs` 作为证据。以下仅示意请求形状：

```json
{
  "store_id": "synthetic-store",
  "call_id": "remember-demo-intent-001",
  "params": {
    "scope_refs": [{"source":"imbrex://qq/123456/main/group/987654","id":"message:synthetic"}],
    "category": "preference",
    "content": "演示用户偏好使用简洁的发布说明。",
    "subjects": ["qq:123456:main:111111"],
    "evidence_refs": [{"source":"imbrex://qq/123456/main/group/987654","id":"message:synthetic"}]
  }
}
```

更新同样要求当前修订号与说明原因，可只提供待更正字段：

```json
{
  "store_id": "synthetic-store",
  "call_id": "update-demo-intent-001",
  "params": {
    "scope_refs": [{"source":"imbrex://qq/123456/main/group/987654","id":"message:synthetic"}],
    "memory_id": "synthetic-memory-id",
    "expected_revision": 1,
    "reason": "用户补充了偏好细节",
    "content": "演示用户偏好简洁且包含验证结果的发布说明。"
  }
}
```

遗忘也必须附带当前 `memory_id`、`expected_revision` 和说明原因：

```json
{
  "store_id": "synthetic-store",
  "call_id": "forget-demo-intent-001",
  "params": {
    "scope_refs": [{"source":"imbrex://qq/123456/main/group/987654","id":"message:synthetic"}],
    "memory_id": "synthetic-memory-id",
    "expected_revision": 2,
    "reason": "用户要求删除这条记忆"
  }
}
```

副作用能力可能返回 succeeded、failed 或 unknown；unknown 时不要换 ID 重试。接受请求也不等于已经生效。用 `memory.operation` 查询该调用者自己的 operation，或用 `memory.status` 查看范围状态，等待明确的 succeeded 结果。

业务能力的完整参数 Schema 以 `src/plugins/memory/index.ts` 为准。九个能力 search、context、get、status、operation、remember、update、forget、rebuild 全部经过网关 REST/MCP 适配器和授权服务。

## Python 私有服务接口（仅运维排障）

Python 服务 API 由 TypeScript Memory 插件调用。Agent、MCP 客户端和普通 REST 客户端不得绕开网关直接访问它。它使用独立 Bearer 环境变量 `MEMORY_SERVICE_TOKEN`，并要求完整 `store_id`、`instance_id`、`caller_id`、`scopes`。这些值只有在插件代理请求时才是受信的绑定结果。下列例子只用于运维联调，不是 Agent API。

```sh
export MEMORY_SERVICE_TOKEN='从私有密钥管理器注入的服务凭据'
export MEMORY_URL='http://127.0.0.1:8090'
curl -fsS -H "Authorization: Bearer $MEMORY_SERVICE_TOKEN" "$MEMORY_URL/health"
```

查询上下文的私有请求：

```sh
curl -fsS -X POST "$MEMORY_URL/v1/query" \
  -H "Authorization: Bearer $MEMORY_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"store_id":"synthetic-store","instance_id":"memory","caller_id":"gateway-bound-caller","scopes":["imbrex://qq/123456/main/group/987654"],"kind":"context","params":{"input_event_ref":{"source":"imbrex://qq/123456/main/group/987654","id":"message:synthetic"},"max_bytes":8192}}'
```

`/v1/query` 的 kind 为 `search`、`context`、`get`、`status`、`operation`。私有操作请求中的 `request_id` 必须是 64 位小写十六进制 SHA-256 标识，和外层网关 `call_id` 是不同字段；写入内容使用 `category`、`content`、`subjects`、`evidence_refs` 等结构，不使用 `source`/`text` 代替 memory 对象：

```json
{
  "request_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "store_id": "synthetic-store",
  "instance_id": "memory",
  "caller_id": "gateway-bound-caller",
  "scopes": ["imbrex://qq/123456/main/group/987654"],
  "kind": "remember",
  "payload": {
    "category": "preference",
    "content": "演示用户偏好使用简洁的发布说明。",
    "subjects": ["qq:123456:main:111111"],
    "evidence_refs": [{"source":"imbrex://qq/123456/main/group/987654","id":"message:synthetic"}]
  }
}
```

更新与遗忘的私有 payload 都需要 `memory_id`、`expected_revision`、`reason`；update 可额外包含 `content`、`category` 或 `subjects`。forget 根据现有证据建立 tombstone。私有服务接受后返回 operation id；调用方须轮询 `POST /v1/query` 的 `kind:"operation"` 和 `params.operation_id`。只有 state 为 succeeded 才确认完成。`request_id` 重用但请求内容不同会冲突。

TypeScript 插件还会发起私有 `kind:"images"` 操作，绑定一个 `input_event_ref` 和图片 locator 数组，例如：

```json
{
  "request_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "store_id": "synthetic-store",
  "instance_id": "memory",
  "caller_id": "gateway-bound-reader",
  "scopes": ["imbrex://qq/123456/main/group/987654"],
  "kind": "images",
  "payload": {
    "input_event_ref": {"source":"imbrex://qq/123456/main/group/987654","id":"message:synthetic"},
    "images": [{"segment_index":0,"file":"synthetic-file","url":"https://images.example.invalid/image.png"}]
  }
}
```

此请求不是第十个 Agent 能力。TypeScript material worker 先通过按 source 配置的已授权 image resolver capability 解析 locator，再用 Memory 插件自身的 reader Principal 向 Python 服务传递。resolver 缺失或失败时只失去图片材料；文本索引仍继续。公开用户 API 仍只有上述九个 Memory 能力。

运维启动、模型配置、媒体限制及未知操作恢复说明见[正式 Memory 文档](../../docs/memory.md)。
