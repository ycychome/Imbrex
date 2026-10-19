# 插件开发契约与演示模板

统一开发基线 0.3。使用 Cordis 插件形式，Imbrex 提供已实现的绑定 API；类型见 src/host/plugin-api.ts，尚未独立发布 SDK 包。

## 1. 插件是什么

插件通过配置中的实例 ID、module、principal_id、enabled、required 和 config 装配。一个模块可配置多个实例，分别拥有身份、数据目录和注册资源。无需继承 Imbrex 基类，也不强制创建数据库。

配置实例 ID 在重启后保持；数据目录为 data/plugins/<instance_id>，不以 Cordis 临时运行编号命名。插件更换账号等不兼容身份时创建新实例，不把旧调用记录解释成新账号的动作。

Cordis 的 apply、inject、Context 与 effect 负责依赖和作用域。本方案不再创建另一套插件状态机来替代它；host 仅将 Cordis 状态和插件外部可用性映射到诊断。

## 2. 绑定的业务 API

宿主注册 imbrex 服务，并保存已装配插件上下文与配置实例/主体的对应关系。插件通过 `ctx.imbrex.forPlugin(ctx)` 获取绑定客户端；未登记的上下文拒绝绑定，子作用域继承同一实例身份。caller 和实例 ID 不来自插件传入的任意字符串。

| API | 本方案签名/行为 |
| --- | --- |
| `api.storeId` | 当前绑定存储的只读 string |
| `api.instanceId` / `api.dataDir` | 宿主分配的实例与私有目录 |
| `api.signal` | 停止时触发的 AbortSignal；不等于远端撤销 |
| `api.events.info()` | 返回 storeId 与 latestSeq: bigint |
| `api.events.append({event, parents?})` | 使用绑定主体与 storeId，返回接纳回执；seq 为 bigint |
| `api.events.read({afterSeq, limit?, sourcePrefix?, type?})` | 返回 records、throughSeq、nextAfterSeq、caughtUp |
| `api.events.lookup({source,id})` | 按读取授权返回当前记录 |
| `api.events.onAvailable(callback)` | 注册短小的唤醒函数，返回幂等注销函数；不交付业务正文 |
| `api.capabilities.register(definition)` | 绑定所属实例，生成完整能力 ID，返回幂等注销函数 |
| `api.capabilities.invoke(id, params, {callId?})` | 使用绑定主体；遵循能力契约中的只读/外部写规则 |
| `api.capabilities.getCall(callId)` | 查询本主体有权查看的记录 |
| `api.setAvailable(boolean, reason?)` | 更新该插件对外服务可用性，不伪造业务成功 |

所有公开对象使用 JSON 值与基本领域类型，只有内部位置使用 bigint。API 不暴露网关 SQL、全局 token、其他应用状态或任意主体 impersonation。需要恢复的插件启动后先核对自己保存的 store_id，再继续调用绑定客户端。

## 3. 一个最小只读工具插件

以下形式已由内置 mock 插件编译并运行；另有可直接复制的 [uppercase 模板](../examples/plugins/uppercase.ts)，通过实际配置加载及 HTTP 调用验证：

```typescript
import type { Context } from 'cordis';

export const name = 'demo-echo';
export const inject = ['imbrex'];

export function apply(ctx: Context) {
  const api = ctx.imbrex.forPlugin(ctx);

  ctx.effect(() => api.capabilities.register<{ text: string }, { text: string }>({
    localName: 'echo',
    description: '返回输入文本，用于检查工具调用链路。',
    schemaVersion: '1',
    isSideEffectful: false,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 2000 } },
      required: ['text'],
      additionalProperties: false
    },
    handler: async ({ text }) => ({ text })
  }));
}
```

配置实例 ID 为 mock 时，此工具的完整 ID 是 mock.echo。配置 principal_id 决定插件调用其他服务时的主体；工具被调用时，handler 的 caller 仍是实际调用方。泛型只提供开发时类型，运行时仍按 inputSchema 校验。

定义字段在 SDK 使用 camelCase，在 HTTP 描述中转换为 snake_case；两者指向同一注册定义，不维护两份业务 schema。插件不得直接返回函数、bigint 或其他非 JSON 结果。

## 4. 外部写 handler

外部写注册使用 isSideEffectful=true。handler 除参数外可获得受信 invocation 上下文：callerId、callId、storeId、停止信号、受限日志及 `readEvent({source,id})`。readEvent 使用实际调用者的读取权限和本次 storeId，而不是连接器自身的较大权限；因此回复工具可以核验调用者有权读取其引用的输入。上下文不能接受任意 caller 覆盖，也不能绕过网关自动重复发送同一请求。

handler 返回可分类结果：

- `succeeded` 与合法 JSON result：实际操作协议已返回确定成功。
- `failed` 与 reason：有足够证据表明本次明确失败，不能用普通 throw 代替所有判定。
- `unknown` 与 reason：可能发生效果，结果不明。

具体结果形状为 `{status: 'succeeded', result}` 或 `{status: 'failed' | 'unknown', reason: {code, message}}`。这三个类别是 handler 报告给内核的结果，最终调用状态还要持久保存。内核未能保存结果时不得向调用者返回“已记录成功”。普通异常默认按副作用不确定处理。

能力可用性来自插件的外部连接状态；断线时 setAvailable(false)，恢复后只接受新的获授权调用，不能扫描 unknown 自动补发。

## 5. 消费事件的插件

参考插件采用一个读取循环，不在通知回调内跑模型或网络重业务。启动时补读，周期补查，通知只触发唤醒。忙时合并提示，不重入。

插件保存自己的输入范围、store_id 和位置；涉及外部动作或非确定结果时，按实际恢复策略先保存必要责任状态。M1 的 acp-consumer 在提交 prompt 前保存未决输入，结果不确定时暂停；模型决定和历史交给现成 Agent。读取出来不等于处理完成，候选 nextAfterSeq 不能在业务责任尚未成立时整体提交，规则见[应用消费](applications.md)。

fixture-transform 是受控特例：只处理 fixture 的已知短 ID，按确定规则生成稳定派生身份和内容。重启后重试同一输出不会新增事件；不把这个样例宣称为任意应用通用的恰好一次变换器。

## 6. 资源登记与停止

注册、监听、定时器和连接的清理通过 ctx.effect 或等价 Cordis 作用域登记。使用外部库创建的 socket/Promise 循环不会自动成为可取消资源；插件必须响应 api.signal，并返回有意义的清理函数。

停止顺序通常为：不再接收/启动新工作 → 等待已有本地提交 → 结束或明确记录在途调用 → 注销能力和监听 → 关闭连接与自己的数据库。需要顺序的动作放入一个有序清理过程，不依赖一组并行 disposer 的注册顺序。

required 指插件模块与初始化必须成功，不保证外部平台一直在线。初始化若等待网络必须有界；运行时断开通过 available=false 表达。不能把 ACTIVE 等同为账号在线或数据完整。

host.startPlugin/stopPlugin 是受信内部控制入口，首版用于生命周期测试和本地集成；普通部署通过配置与宿主重启管理。停止未完成则报告失败，禁止同实例重复启动后台循环。

初次装配按配置顺序进行，提供被依赖服务的插件应排在消费者前；缺少服务时初始化失败。模块支持命名导出的 apply 或默认 apply 函数/对象，可带 Config（Cordis Standard Schema）与字符串数组 inject。内置四个演示插件的 config 为空对象。加载/停止期间的重复管理操作拒绝；生命周期等待默认上限 15 秒。运行中依赖卸载使用 Cordis 原生作用域，宿主同步撤销旧绑定与能力，依赖恢复后重新建立绑定。

## 7. 首版插件清单

| 插件 | 输入与输出 | 验证价值 |
| --- | --- | --- |
| fixture | 有限可重复的 fixture.message.created 事件 | 无需账号验证事件发布与重复身份 |
| transform | 读取 fixture，发布稳定派生事件 | 验证应用可同时消费和生产 |
| mock | 注册 mock.echo；测试环境另配可控副作用提供者 | 验证发现、schema、授权与调用记录 |
| observer | M0 按范围读取并保存位置；事件副本在 M2 完成 | 验证第二消费者最小读取和暂停恢复 |
| onebot-v11 | 通过标准 v11 接口接纳 QQ 事实与封装 reply | 验证不同服务实现可复用同一插件 |
| acp-consumer | 读取入站事件，通过 ACP stdio 驱动现成 Agent | 验证会话关联、自动触发与未决暂停；不自建模型循环 |

前四种为演示与测试提供稳定入口；onebot-v11 和 acp-consumer 在 M1 实现。MCP 是同阶段的协议 adapter，直接复用核心服务。插件全部走相同业务 API，不能给演示插件开放绕过权限或事务的“测试捷径”。测试专用故障点只在受控测试构建中使用。

## 8. 插件开发完成条件

模板能编译并被配置加载；类型与 schema 一致；非法配置有明确错误；start/stop/start 不重复注册或泄漏循环；拥有实际运行命令和最小配置；所声明恢复行为有对应测试。新增插件应修改自己的代码与配置，正常情况下无需修改内核业务逻辑。

## 9. 协议插件的兼容边界

实现品牌不是插件角色。onebot-v11 的通信、事件映射和工具 schema 不依赖 NapCat 或 SnowLuma SDK；差异处理放入该插件内部的显式兼容适配，默认 generic，未知 profile 拒绝启用。不要为了兼容多种实现预先创建空的适配框架或多份连接器副本。

账号、身份命名空间与稳定实例 ID 属于持久绑定；切换实现不能把旧 native_message_id 或未决调用直接交给新服务，具体规则见 [OneBot 接入](onebot-and-agent.md)。
