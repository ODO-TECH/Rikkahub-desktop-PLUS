import {afterAll,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
process.env.RIKKAHUB_PC_DATA_DIR=mkdtempSync(join(tmpdir(),"alpha-app-control-"));
const {runAppControl}=await import("./app-control");
const {hostCapabilities,chatCapabilities}=await import("./capabilities");
const {defaultAssistant}=await import("../assistants");
const store=await import("../persistence/json-store");
const {setState}=store;
const {defaultState}=await import("../app-config/defaults");
const priorState=store.state;
let state=defaultState();
beforeEach(()=>{state=defaultState();setState(state);});
afterAll(()=>setState(priorState));
const {skillsDir}=await import("../foundation/paths");
const {skillMetadataFromFile,parseSkillFrontmatter}=await import("../tools/skills");
const {executeToolCall}=await import("../tools/execution");

test("native install/enable is immediately reflected in tool capabilities and execution",async()=>{
  const assistant=defaultAssistant();state.settings.assistants=[assistant];
  const dir=join(skillsDir,"folder-name");mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,"SKILL.md"),"---\nname: display-name\ndescription: |\n  Read a document.\n  Return its key points.\n---\nReturn CONTROL_READY.");
  expect(skillMetadataFromFile("folder-name")?.name).toBe("folder-name");
  expect(parseSkillFrontmatter("---\ndescription: |\n  First line.\n  Second line.\n---\n").description).toBe("First line. Second line.");
  await runAppControl({action:"api",method:"POST",path:"settings/assistant/skills",body:{assistantId:assistant.id,enabledSkills:["folder-name"]}},assistant);
  // Settings routes may replace the state object; assert against the live binding.
  const current=store.state.settings.assistants[0];
  expect(current.enabledSkills).toContain("folder-name");
  expect(hostCapabilities(true,current).some((t:any)=>t.function.name==="use_skill")).toBe(true);
  expect(chatCapabilities(current).map((t:any)=>t.function.name)).toContain("use_skill");
  const result=await executeToolCall({function:{name:"use_skill",arguments:'{"name":"folder-name"}'}},assistant);
  expect((result as any).content).toContain("CONTROL_READY");
  const settings=await runAppControl({action:"read_settings",keys:["assistants"]},assistant);
  expect(settings.currentAssistantId).toBe(assistant.id);
});

test("chat hides workspace skills and only keeps workspace independent MCP",()=>{
  const assistant=defaultAssistant();assistant.enabledSkills=["workspace-skill"];
  const dir=join(skillsDir,"workspace-skill");mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"SKILL.md"),"---\nname: workspace-skill\ndescription: edit files\nrequires-workspace: true\n---\nbody");
  assistant.mcpServers=["safe","workspace"];
  state.settings.mcpServers=[{id:"safe",commonOptions:{enable:true,tools:[{name:"echo",inputSchema:{type:"object"}}]}},{id:"workspace",requiresWorkspace:true,commonOptions:{enable:true,tools:[{name:"write_file",inputSchema:{type:"object"}}]}}];
  expect(chatCapabilities(assistant).map((t:any)=>t.function.name)).toEqual(["mcp__echo"]);
  const dirWithScripts=join(skillsDir,"script-skill");mkdirSync(join(dirWithScripts,"scripts"),{recursive:true});
  writeFileSync(join(dirWithScripts,"SKILL.md"),"---\nname: script-skill\ndescription: execute scripts\n---\nbody");
  assistant.enabledSkills=["script-skill"];
  expect(chatCapabilities(assistant).some((t:any)=>t.function.name==="use_skill")).toBe(false);
});
