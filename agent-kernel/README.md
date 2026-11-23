# Agent Kernel

轻量、可独立运行的 TypeScript/Bun agent 内核。实现模型与工具循环、AgentBot 所需的自主执行、subagent，以及简化的 superagent 工单调度。

运行时只依赖 Bun 内建的 fetch、流处理和 SQLite。无需 pi 或 DeepSeek Harness 源码树，也没有第三方运行依赖。开发时使用 TypeScript 和 Bun 类型定义。

内核可独立运行；本 Alpha 已通过 `../pc-server/kernel-engine/` 接入桌面端。桌面适配负责原生协议、多模态载荷、OAuth、工具审批及 UI 事件，内核负责循环、预算、取消、subagent 和任务图。独立的 `OpenAIProvider` 支持 OpenAI 兼容 `chat/completions`；桌面端还复用宿主的 Claude/Gemini 协议序列化。详细支持范围见 `../ALPHA.md`。

## 运行

需要 Bun 1.4.2 或更新版本。无需安装依赖即可运行示例和测试：

```powershell
bun run demo
bun test
```

示例默认使用本地模拟模型，不联网、不读取 API key。设置 `MODEL_ENDPOINT`、`MODEL_NAME` 和可选的 `MODEL_API_KEY` 后使用真实模型；endpoint 是完整的 `/chat/completions` URL。

类型检查的开发依赖可以通过 `bun install --ignore-scripts` 安装，然后运行 `bun run typecheck`。现有工作区验证时直接使用了桌面项目已安装的 TypeScript 与类型定义，没有下载新的依赖。

## 普通聊天与 AgentBot

```ts
import { AgentRuntime, KernelStore, OpenAIProvider, answerOf } from "./src/index.ts";

const store = new KernelStore("agent.sqlite");
const runtime = new AgentRuntime({
  store,
  provider: new OpenAIProvider({
    endpoint: "https://api.deepseek.com/chat/completions",
    apiKey: () => process.env.MODEL_API_KEY ?? "",
  }),
  tools: [{
    name: "lookup",
    description: "Look up an item by its ID.",
    parameters: {
      type: "object", properties: { id: { type: "string" } },
      required: ["id"], additionalProperties: false,
    },
    readOnly: true,
    execute: async (args, context) => {
      context.signal.throwIfAborted();
      return { content: JSON.stringify(args) };
    },
  }],
  onEvent: event => console.log(event),
});

// 启动前执行一次；仅单进程拥有数据库。
runtime.recover();
const run = await runtime.start({
  model: "deepseek-chat", input: "Look up item 42 and explain it.",
  tools: ["lookup", "subagent"],
});
console.log(run.status, answerOf(run));
store.close(); // 关闭前先结束所有正在运行的调用。
```

AgentBot 使用相同 Runtime，由聊天、IM 或定时任务投递输入，无需再启一套 agent。内核不内置 QQ/GitHub/飞书客户端、UI 或宿主文件工具。

主要 Interface：

- `create/start`：创建 Run；`resume`：推进到完成、受限、审批或后台等待。
- `inspect`：读取持久快照；`send`：排队输入。`steer` 在下一次模型请求前进入，`followup` 等当前任务结束后进入。
- `approve`：批准或拒绝待审批工具，然后调用 `resume`；同批任何待审批调用都会使整批等待。
- `cancel`：向当前 Run 和后代传播取消信号；工具及自定义 Provider 必须响应信号。
- `completeTool`：提交后台工具结果，再调用 `resume`。后台工具通过 `{ content, waitFor: jobId }` 返回等待状态。
- `recover/resolveInterrupted`：启动恢复；进程中断时正在执行的工具标为不确定，必须核对并提交结果后才能续跑，避免自动重放副作用。

普通完成、失败、取消和预算受限都是当前 Run 的终局；继续新任务请创建新 Run，可以传入已完成的历史。`draft` 保留异常结束时已经收到的部分文本，不能当作完整助手回复重放。

## 子 agent

在父 Run 的 `tools` 中启用 `subagent`。模型调用形状：

```json
{"input":"完成一个明确子任务，并附关键证据","tools":["lookup"],"model":"deepseek-chat"}
```

子 Run 使用干净上下文，默认继承父工具范围和模型，可缩减工具；不复制全部父历史。父子共用持久请求/token 预算。默认只允许一层，`maxDepth` 可显式调高。达到深度后不再向子 agent 提供 `subagent` 工具。

父 Run 等待子 Run 时不占模型或工具执行槽，单槽配置也能运行。子任务需要审批时，父任务进入 `waiting`；通过 `pendingTools[].childRunId` 找到子任务，处理审批后再恢复父任务。取消父任务会同时取消后代。

## 简化 superagent

```ts
import { Superagent } from "./src/index.ts";

const superagent = new Superagent({
  runtime,
  maxWorkers: 2,
  maxReplans: 2,
  // 可选：验证测试报告、产物或业务事实；未提供时只检查 Run 完成。
  verify: async task => ({ ok: Boolean(task.result), evidence: "Result is present" }),
});
const ticket = superagent.accept({
  source: "chat", triggerId: "stable-message-id", model: "deepseek-chat",
  prompt: "分析两份资料并总结", tools: ["lookup"],
  tasks: [
    { id: "a", prompt: "分析资料 A" },
    { id: "b", prompt: "分析资料 B" },
    { id: "summary", prompt: "总结两份分析", dependsOn: ["a", "b"] },
  ],
});
await superagent.advance(ticket.id);
await superagent.flush(async delivery => {
  // 宿主投递到对应聊天或其他渠道；用 delivery.id 做渠道幂等键。
  console.log(delivery.content);
});
superagent.complete(ticket.id); // 验收 ready 工单。
```

`source + triggerId` 去重，同一事件重复接入返回同一工单。每个工单包含持久任务图；独立任务并行、依赖完成后推进。工单所有任务及其子 Run 共用总预算。`advance` 遇到审批或后台等待后返回，宿主在结果到达时再次调用；无空闲模型轮询。

`replan` 显式替换失败/等待工单的计划，并受次数限制；可由宿主、注册工具或模型策略调用，不强制增加 planner 模型调用。完成记录和结果投递 outbox 在同一 SQLite 事务中写入；投递失败保持待发送。恢复进程后 `recover`，再对未完成工单调用 `advance`，对待发送结果调用 `flush`。

第一版未实现自动接单研判、Thread 订阅、Mandate 策略、自动任务拆解、完整 Assignment 历史、渠道连接和管理面板。来源准入、用户身份、工具执行权限和工作区隔离由宿主负责。任务失败可显式重规划；不把模型自称完成视为业务验收通过。

## 默认限制与效率取舍

| 项目 | 默认值 |
| --- | --- |
| 并发模型请求 / 工具槽 | 3 / 4 |
| 单 Run 模型步骤 | 64 |
| 根任务及后代总请求次数 / token 预算 | 256 / 500,000 |
| 模型上下文 / 单次最大输出 | 64,000 / 4,096 token |
| 摘要后保留近期上下文 | 约 12,000 token |
| 子任务深度 | 1 |
| 工具输出预览 | 16,000 字符；全文存 SQLite 产物 |
| 连续相同整批工具错误 | 3 次后停止 |
| superagent 并发 worker / 重规划次数 | 2 / 2 |

`readOnly: true` 的工具可有限并行；其他工具在一个 Runtime 内使用全局写屏障，与读取也不重叠。共享工作区调用必须复用同一个 Runtime；`readOnly` 由工具作者正确声明，内核不推断 shell 命令安全性。该策略较保守，避免引入复杂资源调度和路径分析。

请求开始前预留输入估算与最大输出预算，实际 usage 到达后校正；无 usage 或失败请求保留预留计费。默认 token 计数是 UTF-8 字节估算，不能保证供应商账单的精确硬上限；需要严格控制时注入适配模型的 `countTokens`。真实 usage 超过估算后会阻止后续预算不足的请求。

仅对零流式输出的可重试错误进行有限指数退避，不重放工具。流式输出一旦可见，失败即保留 draft 并结束，避免重复文本和副作用。HTTP 错误不把上游响应正文写入错误。

上下文超限时进行一次模型摘要，保留系统提示词、近期步骤及完整工具调用/结果组，原历史存为产物。过大的单条输入、近期结果或无效摘要会明确停止；不无限摘要、不静默丢弃工具结果。长工具输出有 `artifact_read` 分页读取，模型只能读取同一根任务的产物。

数据库目前不自动清理历史，宿主需管理归档与保留策略。一个数据库只由一个进程/Runtime 拥有；不包含多机 worker 租约。外部投递无法与本地事务原子提交，目标渠道不支持幂等键时可能重复；源码不承诺端到端 exactly-once。

测试使用确定性的模型与工具模拟，不调用付费模型，也不向外部发送消息。当前性能取舍以减少依赖、模型轮次和调度复杂度为主，尚未完成与 pi 的任务基准对比。
