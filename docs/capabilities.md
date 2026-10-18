# 能力注册、调用与结果

统一开发基线 0.3 · 2026-10-18。本文是 Capability 行为规范；HTTP 表达见 [HTTP 契约](contracts.md)，QQ 的具体工具见 [OneBot 接入](onebot-and-agent.md)。

## 1. 注册和身份

能力是插件提供的可调用操作，事实事件只描述已经发生的内容。内核不把重读事件自动变成执行命令。

能力 ID 固定为 `<plugin_instance_id>.<local_name>`，例如 qq-main.reply。插件实例 ID 来自配置，不能用 Cordis 临时运行编号代替。更换账号或使操作含义不兼容时使用新的实例/能力 ID，不把旧调用意图移交给另一个提供者。

注册包含 id、description、input_schema、schema_version、is_side_effectful、handler。所属实例与主体由宿主绑定；schema_version 初版是一个固定字符串版本，不建设协商平台。重复 ID 拒绝注册，不静默覆盖。注销函数幂等且只移除自己的注册。

公开描述不包含 handler、凭据、连接地址或私有配置。发现只返回当前主体获授权且当前可用的能力。插件已加载不等于外部平台在线；提供者可报告 available=false，调用时还须再次检查。

## 2. 参数与权限

- caller_id 来自已验证凭据或宿主绑定，不信任请求体自报身份。
- 列表与调用分别检查权限；能读事件不自然拥有发送能力。目标会话等业务限制由提供者核验。
- 新调用按注册 schema 校验；不强转类型、不填默认值、不移除未知字段，不从网络拉取 schema。
- handler 收到校验后的参数快照；后续修改调用者对象不改变已记录意图。读取调用参数引用的事件时，使用 invocation 上下文的 readEvent，按实际 caller 的权限检查，不能仅用连接器自身权限代替。
- HTTP 未验证值使用 unknown；JSON 结构和值的限制见 [HTTP 契约](contracts.md)。

采用 Draft 2020-12 的有限子集：object/properties/required/additionalProperties、array/items、有界长度与数值约束、enum/const 及受控的组合。首版不支持远程引用、自定义可执行关键词或任意插件编译代码。M0 根据实际校验器锁定受支持词汇，未支持的 schema 在注册时失败，不能静默跳过。[R5](references.md#r5)

当前词汇白名单为 $schema（仅 Draft 2020-12）、title、description、type、properties、required、additionalProperties、items、minItems、maxItems、uniqueItems、minLength、maxLength、minimum、maximum、exclusiveMinimum、exclusiveMaximum、multipleOf、enum、const、allOf、anyOf、oneOf、not；允许布尔 schema。其余关键词（包括 $ref、format、pattern、default）拒绝注册，不执行外部加载或静默忽略。

参数校验只考虑 JSON 自有属性。锁定版 Ajv 不执行 properties 中 __proto__ 的约束，因此这种属性定义在注册时明确拒绝，避免悄悄跳过校验。

## 3. 只读能力与外部写

只读能力 `is_side_effectful=false` 可直接运行并返回 JSON result，不保存持久调用记录；首版请求不携带 call_id，防止暗示它拥有写调用的去重语义。

产生外部副作用的能力必须带 call_id，且新调用要求配置启用外部写、调用者获授权、提供者可用。mock.echo 是只读演示工具；测试调用记录时可在测试配置中加载有副作用的假提供者。

默认 call_id 由应用生成并持久保存，范围是当前 store_id 与 caller_id。相同意图必须复用，相同 ID 不可改参数或能力。网关不推导两个不同 call_id 是否在业务上表达同一次回复。

## 4. 调用记录

持久表结构统一见[存储 schema](storage-and-recovery.md#database-schema)。calls 保存 caller_id/call_id、能力 ID 与 schema 版本、参数快照、状态、结果/原因及创建更新时间；主键为 `(caller_id,call_id)`。

store_id 属于整个数据库，不另建全局调用账本。params_json 保存校验后的原参数快照。结构相等的定义是：对象键次序无关，数组顺序有关，缺失与 null 不同；数字按已接受的 JSON 数值比较，0 与 -0 相等。不计算参数指纹，也不承诺原始 JSON 文本一致。

## 5. 执行顺序

1. 核验主体、请求结构、store_id 和该能力 ID 的当前调用授权。
2. 如果 `(caller_id,call_id)` 已存在，按原能力及已保存参数比较。相同则返回原记录，不要求原插件仍在线；不同返回 call_conflict。比较已有调用不依赖后来变更的 schema。
3. 对新调用查当前注册、检查可用性与禁写开关、校验参数，并取得当前注册引用。并发额度不足时在记录前返回 busy。
4. 短事务原子插入 in_progress。并发同键请求只有插入成功者获准派发；其他请求走已有记录路径。保存失败时不得调用平台。
5. 结束事务后调用一次 handler。注册被停用且尚未派发时可明确失败；一旦可能派发，取消或断线不表示远端已取消。
6. 根据结果写 succeeded、failed 或 unknown；返回的是持久化后的调用记录。保存结果失败不能冒充成功，客户端仍查询原 call_id。

## 6. 状态的精确含义

| 状态 | 含义 | 后续自动行为 |
| --- | --- | --- |
| in_progress | 本进程已记录，尚无确定结果 | 同键请求只查询；一个执行者继续工作 |
| succeeded | 提供者返回其协议定义的成功结果，且结果已保存 | 返回原结果，不再次派发 |
| failed | 有足够证据确认本次操作失败且没有需要保留的不确定执行 | 返回原失败，不自动换 ID 重试 |
| unknown | 可能执行，也可能未执行，无法判定 | 不自动再次派发 |

受信适配器可返回确定拒绝；任意 handler 抛错、输出无效/超限、发送后超时或连接丢失，不能一律归为 failed。外部效果可能发生时归为 unknown。只读错误没有远端写的持久记录要求。

外部调用测试默认超时 15 秒；计时从派发开始。超时不等于远端取消。原进程稍后获得可关联到同一次执行的确定响应时，可将 unknown 更新为确定结果；不得因此再次派发。已终结结果不能被旧超时回调覆盖。

启动时把残留 in_progress 标为 unknown，再允许外部请求进入。不自动重试这些记录，即使实际崩溃发生在发送前。这是本方案明确接受的“不确定时可能漏发”的取舍。

## 7. 查询、停用和保留

`GET /v1/calls/{call_id}` 只读当前主体有权查看的记录，不触发执行，不要求能力在线。停止插件先拒绝新调用，再等待或记录正在执行调用的结果，最后释放连接。

首版不删除调用记录，也不提供“清理后仍幂等”的承诺。恢复旧备份或手工删除记录会破坏原来的去重事实，必须按运维流程处置；call_not_found 不能跨未知恢复历史证明远端没有执行。

旧 unknown 的人工核验与补发可以先通过查询和人工操作完成，首版不提供一键自动改写历史状态的 API。若确认需要新的发送意图，由用户明确发起新决定，并保留与旧记录的关系。

## 8. 能力组合的边界

插件可注册工具，Agent 可发现并调用；工具描述用于理解，不授予权限，也不构成执行安全证明。JSON Schema 只验证结构，账号、会话、事件可信来源仍由实际 handler 检查。

首版接入一个具体 Agent 协议。MCP 或其他模型工具格式以后作为适配器复用本契约，不内置通用工作流、动作自动重试、跨提供者事务或永久审计系统。

事件、应用决定、调用结果可以通过 EventRef/call_id 关联，但关联本身不保证原子提交。发送成功事实如需再发布，应由连接器用稳定身份补充；不能仅因该补充发布失败就重新发送 QQ 消息。
