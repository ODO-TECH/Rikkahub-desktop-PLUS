import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntime, KernelStore, Superagent, answerOf } from "../../agent-kernel/src/index";
import {Semaphore,ToolScheduler} from "../../agent-kernel/src/concurrency";
import type { Schema, Tool } from "../../agent-kernel/src/types";
import type { EngineRunContext } from "../engines";
import type { GenerationEventSink, LoopToolObservation } from "../inference-engine/events";
import { dataDir } from "../foundation/paths";
import { state } from "../persistence/json-store";
import { conversationMessagesForApi } from "../inference-engine/conversation-encoding";
import { contextWindowFor, internalOutputCap } from "../model-providers/model-limits";
import { modelsDevCache } from "../inference-engine/providers";
import { hostCapabilities } from "./capabilities";
import { runAppControl } from "./app-control";
import type { Run } from "../../agent-kernel/src/types";
import { openAiWorkspaceTools } from "../workspace/runtime";
import { initialApprovalState } from "../tools/approval";
import { gateToolApproval } from "../inference-engine/approval-flow";
import { gateAskUser } from "../inference-engine/ask-user-flow";
import { normalizeAskUserQuestions, serializeAskUserAnswer } from "../tools/ask-user";
import { openAiToolOutput } from "../tools/format";
import { prepareMemoryRecall } from "../memory/recall";
import { prepareDynamicRecall } from "../memory/dynamic-recall";
import { prepareMoodInjection } from "../mood/injection";
import { DesktopProvider, fromApi } from "./provider";
import { desktopKernelLimits } from "./limits";

let store: KernelStore | undefined;
let recovered=false;
const modelSlots=new Semaphore(3);
const backgroundModelSlots=new Semaphore(2);
const liveRuns=new Map<string,Run>();
const toolScheduler=new ToolScheduler(2);
function kernelStore() {
  if (!store) { mkdirSync(dataDir,{recursive:true}); store=new KernelStore(join(dataDir,"agent-kernel.sqlite")); }
  return store;
}

/** Validate the kernel subset locally; retain the full host schema for the model/MCP server. */
export function kernelSchema(raw: any): Schema {
  if(!raw || typeof raw !== "object") return {};
  const result: any={};
  for(const key of ["type","description","required","enum","minimum","maximum","minLength","maxLength","minItems","maxItems"])
    if(raw[key] !== undefined && !(key === "type" && Array.isArray(raw[key]))) result[key]=raw[key];
  if(typeof raw.additionalProperties === "boolean") result.additionalProperties=raw.additionalProperties;
  if(raw.properties) result.properties=Object.fromEntries(Object.entries(raw.properties).map(([k,v])=>[k,kernelSchema(v)]));
  if(raw.items && !Array.isArray(raw.items)) result.items=kernelSchema(raw.items);
  return result;
}

export async function runKernelGeneration(ctx: EngineRunContext, sink: GenerationEventSink, signal?: AbortSignal): Promise<string> {
  const {conversation,assistant,model}=ctx;
  const agent=(ctx.executionMode ?? conversation.executionMode) !== "chat";
  await prepareMemoryRecall(conversation,assistant);
  await prepareDynamicRecall(conversation,assistant,signal);
  await prepareMoodInjection(conversation,assistant);
  const history=conversationMessagesForApi(conversation,assistant,ctx.provider.includeHistoryReasoning !== false,true,true).map(fromApi);
  const signatures=conversation.messages.flatMap(n=>(n.messages[n.selectIndex]?.annotations ?? [])).filter((a:any)=>a?.type === "kernel_wire") as unknown as {callIds:string[];wire:import("../../agent-kernel/src/types").Json}[];
  for(const row of history) if(row.toolCalls?.length) {
    const signature=signatures.find(s=>s.callIds.join(",") === row.toolCalls!.map(c=>c.id).join(","));
    if(signature) row.wire=signature.wire;
  }
  const last=history.at(-1)?.role === "user" ? history.pop()! : {role:"user" as const,content:"请继续。",native:undefined};
  // Keep multimodal payload in the user message while using the kernel's text input API.
  const currentAssistant=()=>state.settings.assistants.find(a=>a.id===assistant.id) ?? assistant;
  const declarationsFor=()=>[...hostCapabilities(agent,currentAssistant(),model),...(agent?openAiWorkspaceTools(conversation):[])];
  const declarations:any[]=declarationsFor();
  const unique=new Map(declarations.filter(d=>d.function?.name !== "subagent_dispatch").map(d=>[d.function.name,d.function]));
  const observations: LoopToolObservation[]=[];
  const pendingResults=new Set<string>();
  const registered=new Set<string>();
  let rootId="",runtime:AgentRuntime,round=0;
  const hostTool=(d:any):Tool=>({name:d.name,description:d.description ?? "",parameters:kernelSchema(d.parameters),
    // Approval/question waiting must not monopolize the shared execution scheduler.
    // Actual host operations enter it only after approval has completed.
    orchestrator:true,
    // Unknown/MCP tools remain exclusive. Explicit file reads can overlap.
    readOnly:["read","read_files","get_time_info"].includes(d.name),
    async execute(args,context) {
      const callId=context.callId;
      const approval=initialApprovalState(d.name,currentAssistant(),conversation,JSON.stringify(args));
      if(d.name !== "ask_user") await gateToolApproval(approval,{conversationId:conversation.id,toolCallId:callId,sink,signal:context.signal,toolName:d.name});
      let output:any[];
      if(d.name === "ask_user") {
        const normalized=normalizeAskUserQuestions((args as any).questions);
        if("error" in normalized) throw new Error(normalized.error);
        const answer=await gateAskUser({conversationId:conversation.id,toolCallId:callId,sink,signal:context.signal});
        if(answer.kind !== "answered") throw new Error("问题未得到答复");
        output=[{type:"text",text:serializeAskUserAnswer(answer.answers)}];
      } else if(d.name === "app_control") {
        if(context.runId !== rootId) throw new Error("App settings are managed by the main agent only");
        output=[{type:"text",text:JSON.stringify(await runAppControl(args as any,currentAssistant()))}];
      } else {
        if(!agent && !hostCapabilities(false,currentAssistant(),model).some((t:any)=>t.function.name===d.name)) throw new Error("Tool is unavailable in chat mode");
        output=(await toolScheduler.run(["read","read_files","get_time_info"].includes(d.name),context.signal,()=>ctx.executeTool({id:callId,type:"function",function:{name:d.name,arguments:JSON.stringify(args)}},{
          conversationId:conversation.id,conversationTitle:conversation.title,messageNodeId:ctx.target.node.id,
          signal:context.signal,userApproved:true,
        }))).output;
      }
      const content=openAiToolOutput(output);
      const isError=output.some(p=>p.type === "error" || "error" in p);
      sink({kind:"tool_result",toolCallId:callId,output}); pendingResults.add(callId);
      if(context.runId === rootId) observations.push({toolCallId:callId,toolName:d.name,arguments:JSON.stringify(args),outputText:content,errorSignature:isError?content:null});
      return {content,isError};
    },
  });
  const tools:Tool[]=[...unique.values()].map(hostTool);
  let capabilitySignature=JSON.stringify(declarations);
  const supervised = new Map<string, Superagent>();
  if(agent) tools.push({
    name:"superagent", orchestrator:true,
    description:"Execute a small task graph (up to six tasks). Independent tasks run concurrently; dependencies receive predecessor results. Returns a durable ticket and results. Use for multi-stage delegated work, not simple questions.",
    parameters:{type:"object",properties:{prompt:{type:"string",minLength:1},tasks:{type:"array",minItems:1,maxItems:6,items:{type:"object",properties:{id:{type:"string",minLength:1},prompt:{type:"string",minLength:1},dependsOn:{type:"array",items:{type:"string"}}},required:["id","prompt"],additionalProperties:false}}},required:["prompt","tasks"],additionalProperties:false},
    async execute(args,context) {
      const current=runtime.inspect(context.runId);
      if(current.depth > 0 || context.runId !== rootId) return {content:"Superagent is available to the main agent only.",isError:true};
      const supervisor=new Superagent({runtime,maxWorkers:2,maxReplans:2});
      const input=args as unknown as {prompt:string;tasks:{id:string;prompt:string;dependsOn?:string[]}[]};
      const ticket=supervisor.accept({source:conversation.id,triggerId:context.callId,model:model.modelId,prompt:input.prompt,tasks:input.tasks,
        budgetId:current.rootId,tools:[...unique.keys(),"artifact_read"],limits:current.limits,
        system:current.messages.filter(m=>m.role === "system").map(m=>m.content).join("\n")});
      supervised.set(ticket.id,supervisor);
      const cancel=()=>supervisor.cancel(ticket.id);
      context.signal.addEventListener("abort",cancel,{once:true});
      try {
        const result=await supervisor.advance(ticket.id);
        if(result.status === "ready") supervisor.complete(ticket.id);
        return {content:JSON.stringify({ticketId:ticket.id,status:supervisor.inspect(ticket.id).status,tasks:result.tasks}),isError:result.status !== "ready"};
      } finally {context.signal.removeEventListener("abort",cancel);supervised.delete(ticket.id);}
    },
  });
  const provider=new DesktopProvider(ctx,request=>{
    for(const t of request.tools) if(unique.has(t.name)) t.parameters=unique.get(t.name).parameters;
  },id=>id===rootId);
  runtime=new AgentRuntime({store:kernelStore(),provider,tools,modelSlots,backgroundModelSlots,toolScheduler,artifactPaging:agent,childModels:[model.modelId],
    beforeStep(run) {
      liveRuns.set(run.id,run);
      if(run.id !== rootId) return;
      const next=declarationsFor().filter((d:any)=>d.function?.name !== "subagent_dispatch");
      const signature=JSON.stringify(next);
      if(signature !== capabilitySignature) {
        capabilitySignature=signature;unique.clear();
        for(const d of next as any[]) unique.set(d.function.name,d.function);
        runtime.refreshTools(run,[...unique.values()].map(hostTool),[...unique.keys(),...(agent?["subagent","superagent","artifact_read"]:[])]);
      }
      if(!agent) {
        const marker="[RikkaHub conversation mode]";
        const content=`${marker} Chat mode is active until the user switches back to Agent. Workspace/file/shell tools, subagents and app settings actions are disabled. Available independent Skill/MCP tools: ${run.tools.join(", ") || "none"}. Prior tool calls are history only. Use only the currently declared tools; if a requested tool is unavailable, explain briefly in ordinary conversation. Never simulate a tool call as text or claim it ran.`;
        const existing=run.messages.find(m=>m.role==="system" && m.content.startsWith(marker));
        if(existing)existing.content=content;
        else {const i=run.messages.findIndex(m=>m.role!=="system");run.messages.splice(i<0?run.messages.length:i,0,{role:"system",content});}
      }
      ctx.onRunBoundary?.(++round);
      const decision=observations.length ? ctx.onToolRoundEnd?.(observations.splice(0)) : undefined;
      if(decision?.action === "halt") throw new Error(decision.reason);
      if(decision?.action === "inject") run.messages.push({role:"user",content:decision.text});
      for(const content of ctx.onSteerBoundary?.() ?? []) run.messages.push({role:"user",content});
    },
    onFinal(run) {
      if(run.id !== rootId || !agent) return [];
      const texts=ctx.onSteerBoundary?.() ?? [];
      if(texts.length) return texts;
      const decision=ctx.onFinalCandidate?.();
      if(decision?.action === "halt") throw new Error(decision.reason);
      return decision?.action === "inject" ? [decision.text] : [];
    },
    maxRetries:state.settings.agentLoop?.transportRetry === false ? 0 : 2,
    onEvent(event) {
      if(event.type === "delta") {
        if(event.runId === rootId) sink({kind:event.kind === "text"?"text_delta":"reasoning_delta",text:event.text});
        return;
      }
      if(event.type === "model_state") {
        const view=liveRuns.get(event.runId);
        if(view)(view as any).modelState={phase:event.phase,at:event.at,...(event.queuedMs!==undefined?{queuedMs:event.queuedMs}:{})};
        if(event.phase === "request")console.log(`[kernel-timing] run=${event.runId} queue=${event.queuedMs}ms`);
        return;
      }
      const run=runtime.inspect(event.runId);
      if(event.type === "compacted" && event.runId === rootId) sink({kind:"engine_status",status:{busy:false}});
      if(event.type === "tool") {
        const tool=run.pendingTools.find(t=>t.call.id === event.callId);
        if(!tool) return;
        if(!registered.has(event.callId)) {
          registered.add(event.callId);
          sink({kind:"tool_call_created",toolCallId:event.callId,toolName:tool.call.name,input:tool.call.arguments,
            approvalState:initialApprovalState(tool.call.name,currentAssistant(),conversation,tool.call.arguments),
            ...(event.runId !== rootId?{metadata:{kernelChildRunId:event.runId,kernelRootRunId:rootId}}:{})});
        }
        if(tool.status === "done" && !pendingResults.has(event.callId)) {
          pendingResults.add(event.callId);
          sink({kind:"tool_result",toolCallId:event.callId,output:[{type:"text",text:tool.output?.content ?? ""}]});
        }
      }
    },
  });
  if(!recovered) {runtime.recover();recovered=true;}
  const context=Math.max(8192,contextWindowFor(modelsDevCache,ctx.provider,model.modelId) ?? 64000);
  rootId=runtime.create({model:model.modelId,input:last.content || "[附件]",history,tools:agent?[...unique.keys(),"subagent","superagent"]:[...unique.keys()],
    limits:desktopKernelLimits(agent,context,internalOutputCap(modelsDevCache,ctx.provider,model.modelId,assistant.maxTokens || 4096),unique.size>0)});
  const initial=runtime.inspect(rootId);
  initial.messages[initial.messages.length-1].native=last.native;
  runtime.store.save(initial);
  ctx.target.message.annotations.push({type:"kernel_run",id:rootId});
  let run:Run;
  try {run=await runtime.resume(rootId,signal);}
  finally {for(const [id,view] of liveRuns)if(view.rootId===rootId)liveRuns.delete(id);}
  sink({kind:"usage",usage:{promptTokens:run.usage.inputTokens,completionTokens:run.usage.outputTokens,totalTokens:run.usage.inputTokens+run.usage.outputTokens}});
  if(signal?.aborted) throw new DOMException("Generation stopped","AbortError");
  if(run.status !== "completed") throw new Error(run.error || `Agent 已停止：${run.status}`);
  return answerOf(run);
}

/** Scoped to roots referenced by the selected conversation branches. Never returns system/auth data. */
export function kernelRunViews(rootIds:string[]) {
  return kernelStore().runs([...new Set(rootIds)]).map(saved=>{
    const run=liveRuns.get(saved.id) ?? saved;
    return {id:run.id,rootId:run.rootId,parentId:run.parentId ?? null,depth:run.depth,status:run.status,
      model:run.model,steps:run.steps,usage:run.usage,error:run.error ?? null,createdAt:run.createdAt,updatedAt:run.updatedAt,
      modelState:(run as any).modelState ?? null,
      input:run.messages.find(m=>m.role==="user")?.content.slice(0,8000) ?? "",
      messages:(run.id===run.rootId?[]:run.messages.filter(m=>m.role!=="system")).map(m=>({role:m.role,content:m.content.slice(0,32000),
        reasoning:m.reasoning?.slice(-16000),toolCallId:m.toolCallId,toolCalls:m.toolCalls})),
      draft:run.draft?{content:run.draft.content.slice(-32000),reasoning:run.draft.reasoning?.slice(-16000)}:null,
      pendingTools:run.pendingTools.map(t=>({call:t.call,status:t.status,childRunId:t.childRunId ?? null,
        output:t.output?{content:t.output.content.slice(-8000),isError:t.output.isError}:null})),
    };
  });
}
