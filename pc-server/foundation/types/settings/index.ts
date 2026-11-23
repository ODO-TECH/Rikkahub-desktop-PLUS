import type { AgentLoopSettings } from "./agent-loop-config";
import type { AppConfig } from "./app-config";
import type { ContextBudgetConfig } from "./context-budget-config";
import type { ContextToolsConfig } from "./context-tools-config";
import type { DebugServerConfig } from "./debug-server-config";
import type { ImAccessSlice } from "./im-access";
import type { MediaGenerationConfig } from "./media-generation-config";
import type { MemoryConfig } from "./memory-config";
import type { MemoryExperimentConfig } from "./memory-experiment-config";
import type { MemoryVectorConfig } from "./memory-vector-config";
import type { ModelConfig } from "./model-config";
import type { MoodExperimentConfig } from "./mood-experiment-config";
import type { ModelLayerConfig } from "./model-layer";
import type { PromptConfig } from "./prompt-config";
import type { NetworkConfig } from "./proxy-config";
import type { PtcConfig } from "./ptc-config";
import type { ResultClipConfig } from "./result-clip-config";
import type { SearchConfig } from "./search-config";
import type { SshConfig } from "./ssh-config";
import type { StorageConfig } from "./storage-config";
import type { SubagentConfig } from "./subagent-config";
import type { ToolConfig } from "./tool-config";
import type { VoiceConfig } from "./voice-config";
import type { WorkspaceToolsConfig } from "./workspace-tools-config";

/** 聚合 Settings 接口。state.json 的序列化格式由它保证，新增/拆分 slice 时不可删除或重命名字段。 */
export interface Settings
  extends AppConfig,
    ModelConfig,
    PromptConfig,
    SearchConfig,
    VoiceConfig,
    ModelLayerConfig,
    ToolConfig,
    StorageConfig,
    NetworkConfig,
    MemoryConfig,
    MemoryVectorConfig,
    MemoryExperimentConfig,
    MoodExperimentConfig,
    SshConfig,
    ImAccessSlice,
    MediaGenerationConfig {
  /** PC-only：子智能体派遣设置（见 subagent-config.ts）。导出安卓备份时剥离。 */
  subagent: SubagentConfig;
  /** PC-only：工作区工具面契约开关(行号读取/重读去重/动态工具发现)。导出安卓备份时剥离。 */
  workspaceTools: WorkspaceToolsConfig;
  /** PC-only：自主循环(运行底座/判定表/传输重试)。默认关闭，导出安卓备份时剥离。 */
  agentLoop: AgentLoopSettings;
  /** PC-only：上下文预算窗口与工具输出老化。默认关闭，导出安卓备份时剥离。 */
  contextBudget: ContextBudgetConfig;
  /** PC-only：模型驱动的上下文工具面(仅工作区会话)。默认关闭，导出安卓备份时剥离。 */
  contextTools: ContextToolsConfig;
  /** PC-only：本地调试端口(重启/实时日志/状态树)。默认关闭，导出安卓备份时剥离。 */
  debugServer: DebugServerConfig;
  /** PC-only：工具结果进上下文前的头尾裁剪。默认开启，导出安卓备份时剥离。 */
  resultClip: ResultClipConfig;
  /** PC-only：程序化工具面(PTC,run_code 硬沙箱)。默认开启，导出安卓备份时剥离。 */
  ptc: PtcConfig;
}

export type * from "./agent-loop-config";
export type * from "./app-config";
export type * from "./context-budget-config";
export type * from "./context-tools-config";
export type * from "./debug-server-config";
export type * from "./im-access";
export type * from "./media-generation-config";
export type * from "./memory-config";
export type * from "./memory-experiment-config";
export type * from "./memory-vector-config";
export type * from "./model-config";
export type * from "./ptc-config";
export type * from "./mood-experiment-config";
export type * from "./model-layer";
export type * from "./prompt-config";
export type * from "./proxy-config";
export type * from "./result-clip-config";
export type * from "./search-config";
export type * from "./ssh-config";
export type * from "./storage-config";
export type * from "./subagent-config";
export type * from "./tool-config";
export type * from "./voice-config";
export type * from "./workspace-tools-config";
