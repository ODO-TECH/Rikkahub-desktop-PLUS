import type { Assistant } from "../foundation/types";
import { state } from "../persistence/json-store";
import { updateSettings } from "../app-config";
import { patchDebugSettings, redactDebug } from "../debug/settings-control";
import { invalidateContextSnapshots } from "../inference-engine/context-snapshots";

export const appControlDeclaration = {
  type: "function" as const,
  function: {
    name: "app_control",
    description: "Manage this RikkaHub app through its native settings/extension API. Use this instead of editing state.json or guessing localhost ports. Read settings, patch any settings, install skills and enable them, configure/sync MCP. API paths start with skills or settings. Install: POST skills/import-github {repoUrl}; enable: POST settings/assistant/skills {assistantId,enabledSkills}; MCP: POST settings/mcp-server/import {json}, settings/mcp-server/sync {serverId}. Settings changes refresh capabilities before the next model request. Never disclose credentials.",
    parameters: { type:"object", properties: {
      action: {type:"string",enum:["read_settings","patch_settings","api"]},
      keys: {type:"array",items:{type:"string"}},
      patch: {type:"object",additionalProperties:true},
      path: {type:"string"}, method:{type:"string",enum:["GET","POST","PATCH","DELETE"]},
      body: {type:"object",additionalProperties:true},
    },required:["action"],additionalProperties:false },
  },
};

export async function runAppControl(args: Record<string, any>, assistant: Assistant) {
  if (args.action === "read_settings") {
    const keys: string[] = args.keys ?? ["assistantId","assistants","mcpServers","agentLoop","subagent","workspaceTools"];
    const settings = Object.fromEntries(keys.map(key => [key, (state.settings as any)[key]]));
    return redactDebug({currentAssistantId:assistant.id, settings});
  }
  if (args.action === "patch_settings") {
    updateSettings(patchDebugSettings(state.settings, args.patch));
    invalidateContextSnapshots();
    return {status:"saved",keys:Object.keys(args.patch),effective:"next model request"};
  }
  if (args.action !== "api") throw new Error("Unknown app_control action");
  const path = String(args.path ?? "").replace(/^\/?api\//, "").replace(/^\//, "");
  if (!/^(?:settings|skills)(?:\/|$)/.test(path) || /[?#]|\.\./.test(path)) throw new Error("Only native settings and skills API paths are supported");
  const url = new URL("/api/"+path,"http://localhost");
  const method = args.method ?? "GET";
  const { routeApi } = await import("../api/router");
  const response = await routeApi(new Request(url,{method,headers:{"content-type":"application/json"},
    ...(!["GET","HEAD"].includes(method)?{body:JSON.stringify(args.body ?? {})}:{})}),url);
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(redactDebug(result)));
  invalidateContextSnapshots();
  return redactDebug(result);
}
