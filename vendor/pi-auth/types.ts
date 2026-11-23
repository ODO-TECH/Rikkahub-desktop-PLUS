// RikkaHub alpha: only auth protocol types, avoiding the full provider SDK graph.
export type ProviderEnv = Record<string,string>;
export type ProviderHeaders = Record<string,string | null>;
export type Api = string;
export type ProviderId = string;
export type ThinkingLevelMap = Partial<Record<"minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
export interface Model<T extends Api> {
  id:string; name:string; api:T; provider:string; baseUrl:string; reasoning:boolean;
  input:("text"|"image")[]; contextWindow:number; maxTokens:number;
  cost:{input:number;output:number;cacheRead:number;cacheWrite:number};
}
