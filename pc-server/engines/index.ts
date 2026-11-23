// Shared generation contracts. Desktop conversations use the built-in kernel.
import type { Assistant, Conversation, Model, Provider } from "../foundation/types";
import type { ToolBoundaryObserver } from "../foundation/tool-boundary";
import type {
  GenerationEventSink,
  GenerationTarget,
  LoopDecision,
  LoopToolObservation,
  ToolExecutor,
} from "../inference-engine/events";

/** 引擎种类(开放枚举)。新增引擎 = 追加一个字面量 + 一个 adapter + 注册一行。 */
export type EngineKind = "chat" | "pi" | "dsh" | "codex" | "claude-code" | (string & {});

/** 审批续跑语义(替代 orchestrator.ts 写死的 `!piRuntime` 二选一):
 *  - "pause-resume":聊天引擎——待审批工具整批暂停生成,用户逐卡批准后重触发续跑
 *    (resumeApprovedToolParts + hasPendingToolApproval 收尾)。
 *  - "run-and-suspend":pi 引擎——生成保持在跑,单个工具调用挂起等待审批门放行
 *    (approval-gate 汇合),不重触发整轮。
 *  子进程引擎届时按其审批模型声明。 */
export type EngineResumeSemantics = "pause-resume" | "run-and-suspend";

/** steering 能力声明(生成中补发的用户消息如何送达模型):
 *  - "boundary":引擎在「即将构建下一模型请求之前」调用 ctx.onSteerBoundary(),把返回文本
 *    作为 user turn 喂给模型(聊天引擎 = 工具轮边界 + 最终轮;pi = turn_end)。协调器在同一
 *    调用里完成数据层分裂(定格当前节点 / 落库 steer user / 新开 continuation 节点 / 换绑落点),
 *    引擎经 ctx.target 活视图自动跟随。
 *  - "none":引擎无注入位点(单次不透明请求等)。协调器不下发回调,补发消息留在 FIFO 队列由
 *    收尾派发兜底——视觉序仍是 [ai_1, user_2, ai_2],只是晚到生成结束;按构造优雅降级,
 *    不会出现半吸收状态。
 *  必填:新引擎接入时必须显式选择,忘了调回调不会静默丢能力(契约测试锁每个 "boundary"
 *  引擎的真实调用)。 */
export type EngineSteeringSupport = "boundary" | "none";

/** 引擎无关的生成输入包(编排器入口一次性装配,贯穿本次生成)。 */
export interface EngineRunContext {
  conversation: Conversation;
  /** Immutable mode for this run; conversation.executionMode belongs to the next turn. */
  executionMode?: "agent" | "chat";
  /** 流式落点(活视图,协调器持有可换绑实现)。引擎每次现读 target.node/target.message,
   *  不得解构缓存——steer 边界分裂会把落点换到新开的 continuation 节点。 */
  target: GenerationTarget;
  assistant: Assistant;
  provider: Provider;
  model: Model;
  /** 工具执行闭包(协调器注入,内部已挂生成级 signal 与部分输出回写)。 */
  executeTool: ToolExecutor;
  /** steering 轮边界(用户问题②,对齐 Codex pending_input):声明 steering:"boundary" 的引擎
   *  在「即将构建下一模型请求之前」调用,取「生成中补发」的用户消息文本(协调器已同步
   *  落库、换绑落点并通知 FIFO 队列移除)。返回空数组 = 无注入。声明 "none" 的引擎收不到
   *  此回调(协调器不下发)。 */
  onSteerBoundary?: () => string[];
  /** 自主循环(S1):轮边界观察点。所有引擎在每轮发请求前调用(聊天 = 工具循环每轮;
   *  pi = turn_start;未来引擎 = 即将发请求前)。round 从 1 起,同轮重复调用幂等。
   *  只用于运行记录计数,不得据此改生成语义(判定表是 S3 的事)。不传 = 无观测。 */
  onRunBoundary?: (round: number) => void;
  /** 自主循环(S3):工具批执行完、下一模型请求前的判定表。聊天 = 工具循环每轮工具批后;
   *  pi = turn_end(toolResults 非空)。返回 inject 的引擎负责把提示注入下一轮(聊天 = 附加
   *  user turn;pi = session.steer),返回 halt 的以 AgentLoopHaltError 收尾。不传 = 无判定。 */
  onToolRoundEnd?: (observations: LoopToolObservation[]) => LoopDecision;
  /** 自主循环(S3):模型不调用工具、即将收尾的完成校验。聊天 = 无工具调用的最终轮;
   *  pi = turn_end(toolResults 为空)。不传 = 维持"无工具调用即答完"。 */
  onFinalCandidate?: () => LoopDecision;
  /** 多步可观测性(O4):审批最终判定处的边界观测。只有 agentLoop 开启时才注入;
   *  引擎只把它转交给审批判定,不自行解释。不传 = 无观测(行为与引入前一致)。 */
  onToolBoundary?: ToolBoundaryObserver;
}

/** 引擎无关的压缩输入包(编排器压缩入口装配,与 EngineRunContext 同哲学:
 *  只含引擎无关输入,引擎专属决策由各 adapter 内部解析)。 */
export interface EngineCompactContext {
  conversation: Conversation;
  assistant: Assistant;
  provider: Provider;
  model: Model;
  /** 执行摘要的模型(「设置 → 模型 → 场景模型」的压缩模型,公共基础设施:配置即对
   *  所有引擎生效;未配置=会话模型)。与 provider/model 的角色分工:后者是"压缩对象
   *  的视角"——窗口锚定/富化裁决/上下文极限都按会话模型算,摘要文本由 summarizer
   *  生成。引擎用不了此模型时(如 pi 映射失败)由 adapter 自行回退会话模型——
   *  公共设置是偏好不是硬约束,压缩必须总能进行。 */
  summarizer: { provider: Provider; model: Model };
  /** 用户附加指示(compress 框的 additionalPrompt)。 */
  customInstructions: string;
}

/** 引擎原生压缩的产出(展示/日志用途)。压缩记录落库(conversation.engineCompactions)
 *  是各引擎注入实现的义务——与生成路径的压缩捕获同一落点、同一 helper。 */
export interface EngineCompactionResult {
  summary: string;
  tokensBefore: number;
  /** 引擎对压缩后上下文的估算(拿不到为 null)。 */
  estimatedTokensAfter: number | null;
}

export interface EngineAdapter {
  readonly kind: EngineKind;
  /** 路由判定:该会话是否由本引擎接管。注册表按序取首个命中;chat 恒 true 兜底。 */
  matches(conversation: Conversation, assistant: Assistant): boolean;
  readonly resumeSemantics: EngineResumeSemantics;
  readonly steering: EngineSteeringSupport;
  /** 驱动一次生成,经 sink 发出 GenerationEvent,返回最终文本(steer 分裂后为当前段口径)。 */
  run(ctx: EngineRunContext, sink: GenerationEventSink, signal?: AbortSignal): Promise<string>;
  /** 可选能力:引擎原生压缩(压引擎记忆,UI 历史不动)。每个引擎的压缩机制独立设计
   *  (prompt/切点语义各异),但共享同一调用面与 engine_status 瞬态状态通道(经 sink,
   *  广播与终局清条由调用方统一负责)。未声明 = 该引擎无原生压缩,调用方回落
   *  UI 历史压缩。 */
  compact?(ctx: EngineCompactContext, sink: GenerationEventSink, signal?: AbortSignal): Promise<EngineCompactionResult>;
}

/** 路由:遍历注册表取首个 matches() 命中的 adapter;数组恒含 chat 兜底,不会空。 */
export function resolveEngine(
  registry: EngineAdapter[],
  conversation: Conversation,
  assistant: Assistant,
): EngineAdapter {
  return registry.find((adapter) => adapter.matches(conversation, assistant)) ?? registry[registry.length - 1]!;
}
