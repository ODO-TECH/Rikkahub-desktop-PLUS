import type { Assistant, Model } from "../foundation/types";
import { conversationFunctionTools, openAiSkillTools, openAiMcpTools } from "../tools/bound";
import { listSkills, readSkillContent, parseSkillFrontmatter, safeSkillFile } from "../tools/skills";
import { existsSync } from "node:fs";
import { state } from "../persistence/json-store";
import { appControlDeclaration } from "./app-control";

export function chatCapabilities(assistant: Assistant) {
  const skills = new Set(listSkills().filter(skill => {
    const metadata = parseSkillFrontmatter(readSkillContent(skill.name) ?? "");
    if(metadata["requires-workspace"] === "false")return true;
    const scripts=safeSkillFile(skill.name,"scripts");
    return metadata["requires-workspace"] !== "true" && !(scripts && existsSync(scripts)) &&
      !skill.allowedTools.some(name => /^(?:bash|shell|exec|read|write|edit|read_files|glob|grep)(?:$|[(:,])/i.test(name));
  }).map(skill => skill.name));
  const blocked = new Set(state.settings.mcpServers.filter((s:any)=>s.requiresWorkspace === true || s.commonOptions?.requiresWorkspace === true).map((s:any)=>s.id));
  const scoped = {...assistant,enabledSkills:assistant.enabledSkills.filter(name=>skills.has(name)),
    mcpServers:assistant.mcpServers.filter(id=>!blocked.has(id))};
  // MCP is app scoped by default; an extension can explicitly require a workspace.
  const mcp = openAiMcpTools(scoped);
  const skillTools=openAiSkillTools(scoped).map(tool=>({...tool,function:{...tool.function,
    parameters:{...tool.function.parameters,properties:{...tool.function.parameters.properties,
      name:{...tool.function.parameters.properties.name,enum:scoped.enabledSkills}}}}}));
  return [...skillTools,...mcp];
}

export function hostCapabilities(agent:boolean,assistant:Assistant,model?:Model) {
  return agent ? [...conversationFunctionTools(assistant,model),appControlDeclaration] : chatCapabilities(assistant);
}
