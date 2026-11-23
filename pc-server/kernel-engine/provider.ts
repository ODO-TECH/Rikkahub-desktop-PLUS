import type { Json, Message, ModelEvent, ModelProvider, ModelRequest } from "../../agent-kernel/src/types";
import type { EngineRunContext } from "../engines";
import type { ApiMessage } from "../foundation/types";
import { message } from "../foundation/utils";
import { applyCustomBody, applyRequestHeaders } from "../model-providers";
import { resolveProviderAuthForProvider, applyShaping } from "../model-providers/auth";
import { endpointFor } from "../model-providers/checks";
import { openAiMaxTokensField } from "../model-providers/request-dialect";
import { readOpenAIResponse, ProviderError } from "../../agent-kernel/src/openai";
import { requiredOutputCap } from "../model-providers/model-limits";
import { effectiveMaxTokens, effectiveTopP } from "../inference-engine/sampling";
import { modelsDevCache } from "../inference-engine/providers";
import { runWithLlmRequestLog, llmLogContextFor } from "../inference-engine/llm-request-log";
import { buildGoogleRequestBody, googleToolsFromFunctionTools } from "../inference-engine/conversation-encoding";
import { claudeMessagesFromApiMessages, claudeSystemContent, claudeToolsFromOpenAiTools,
  hostOfProvider, reasoningPayloadForProvider, responseApiFunctionTool, isModelAllowTemperature,
  claudeThinkingPayload, supportsAbility, responseApiReasoningForProvider, responseApiIncludeForProvider } from "../inference-engine/message-builder";
import { reasoningLevelNormalized } from "../model-providers/request-dialect";
import { readOpenAiResponseIntoMessage, readClaudeStreamingRound, readClaudeJsonRound,
  readGoogleStreamingRound, readGoogleJsonRound } from "../inference-engine/providers";

export function fromApi(m: ApiMessage): Message {
  return { role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
    native: m.content as Json,
    ...(m.reasoning_content ? { reasoning: m.reasoning_content } : {}),
    ...(m.tool_call_id ? { toolCallId: m.tool_call_id } : {}),
    ...(m.tool_calls?.length ? { toolCalls: m.tool_calls.map((c: any) => ({id:c.id,name:c.function.name,arguments:c.function.arguments || "{}"})) } : {}) };
}
function toApi(m: Message): ApiMessage {
  return { role: m.role, content: m.native ?? m.content, _kernelWire:m.wire,
    ...(m.reasoning ? {reasoning_content:m.reasoning} : {}),
    ...(m.toolCallId ? {tool_call_id:m.toolCallId} : {}),
    ...(m.toolCalls?.length ? { tool_calls:m.toolCalls.map(c => ({id:c.id,type:"function",function:{name:c.name,arguments:c.arguments}})) } : {}) };
}

/** Protocol adapters do one model request. The kernel alone owns retries, budgets and tools. */
export class DesktopProvider implements ModelProvider {
  constructor(private ctx: EngineRunContext, private beforeRequest: (request: ModelRequest) => void, private isRoot: (id?:string)=>boolean = ()=>false) {}
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    this.beforeRequest(request);
    const queue: ModelEvent[] = [];
    let done = false, failure: unknown, wake: (() => void) | undefined;
    const push = (e: ModelEvent) => { queue.push(e); wake?.(); };
    const work = this.round(request, signal, push).catch(e => {failure=e;}).finally(() => {done=true;wake?.();});
    try {
      while (!done || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>(resolve => {wake=resolve;});
      }
      if (failure) throw failure;
    } finally { await work; }
  }
  private async round(request: ModelRequest, signal: AbortSignal, push: (event: ModelEvent) => void) {
    const {provider,assistant,model,conversation}=this.ctx;
    const executionMode=this.ctx.executionMode ?? conversation.executionMode;
    const stream=assistant.streamOutput !== false;
    const outputCap=effectiveMaxTokens(assistant.maxTokens);
    const topP=effectiveTopP(assistant.topP);
    const sampling=isModelAllowTemperature(model) ? {
      ...(assistant.temperature != null ? {temperature:assistant.temperature} : {}),
      ...(topP != null ? {top_p:topP} : {}),
    } : {};
    const auth=await resolveProviderAuthForProvider(provider,{signal});
    const headers=applyRequestHeaders({"Content-Type":"application/json",...auth.headers},assistant,provider,model,conversation.id);
    let url=endpointFor(provider,auth.baseUrl);
    const messages=request.messages.map(toApi);
    const tools=request.tools.map(t => ({type:"function",function:{name:t.name,description:t.description,parameters:t.parameters}}));
    let body: Record<string,any>;
    if(provider.type === "claude") {
      if(provider.authMode !== "oauth") headers["x-api-key"]=provider.apiKey;
      headers["anthropic-version"]="2023-06-01";
      const thinkingActive=supportsAbility(model,"REASONING") && reasoningLevelNormalized(assistant.reasoningLevel) !== "off";
      body={model:request.model,stream,max_tokens:Math.min(request.maxOutputTokens,requiredOutputCap(modelsDevCache,provider,request.model,outputCap)),
        ...(assistant.temperature != null && !thinkingActive ? {temperature:assistant.temperature} : {}),
        ...(topP != null ? {top_p:topP} : {}),
        ...claudeThinkingPayload(model,assistant.reasoningLevel),
        system:claudeSystemContent(messages.filter(m=>m.role==="system").map(m=>m.content).join("\n"),provider),
        messages:claudeMessagesFromApiMessages(messages,provider),tools:claudeToolsFromOpenAiTools(tools as any,provider)};
      const native=messages.filter(m=>m.role === "assistant" && (m.content || m.tool_calls?.length));
      let i=0;
      for(const row of body.messages) if(row.role === "assistant") {
        const source=native[i++];
        if(source?._kernelWire?.protocol === "claude") row.content=source._kernelWire.blocks;
      }
    } else if(provider.type === "google") {
      if(provider.useInteractionsApi) throw new Error("Alpha Agent 暂不支持 Gemini Interactions，请关闭该供应商的 Interactions 开关。");
      if(provider.authMode !== "oauth") headers["x-goog-api-key"]=provider.apiKey;
      const names=new Map(request.messages.flatMap(m=>(m.toolCalls ?? []).map(c=>[c.id,c.name] as const)));
      for(const m of messages) if(m.role === "tool" && m.tool_call_id) m.name=names.get(m.tool_call_id) ?? "";
      body=buildGoogleRequestBody(messages,model,assistant,conversation.id);
      body.tools=googleToolsFromFunctionTools(tools as any,model);
      const native=messages.filter(m=>m.role === "assistant");
      let i=0;
      for(const row of body.contents) if(row.role === "model") {
        const source=native[i++];
        if(source?._kernelWire?.protocol === "google") row.parts=source._kernelWire.blocks;
      }
      body.generationConfig={...body.generationConfig,...(outputCap?{maxOutputTokens:request.maxOutputTokens}:{})};
      const operation=stream ? "streamGenerateContent?alt=sse" : "generateContent";
      url=`${(auth.baseUrl ?? provider.baseUrl).replace(/\/$/,"")}/models/${encodeURIComponent(request.model)}:${operation}`;
    } else if(provider.useResponseApi) {
      const input: any[]=[];
      for(const m of messages) {
        if(m.role === "tool") input.push({type:"function_call_output",call_id:m.tool_call_id,output:m.content});
        else {
          if(m.content) input.push({role:m.role,content:m.content});
          for(const c of m.tool_calls ?? []) input.push({type:"function_call",call_id:c.id,name:c.function.name,arguments:c.function.arguments});
        }
      }
      body={model:request.model,input,stream,store:false,...sampling,
        ...(outputCap?{max_output_tokens:request.maxOutputTokens}:{}),tools:tools.map(responseApiFunctionTool),
        reasoning:responseApiReasoningForProvider(provider,model,assistant.reasoningLevel),
        include:responseApiIncludeForProvider(provider,model)};
    } else body={model:request.model,messages:messages.map(({_kernelWire,...m})=>m),stream,
      ...(stream?{stream_options:{include_usage:true}}:{}),...sampling,
      ...(outputCap?{[openAiMaxTokensField(hostOfProvider(provider))]:request.maxOutputTokens}:{}),
      ...reasoningPayloadForProvider(provider,model,assistant.reasoningLevel),...(tools.length?{tools,tool_choice:"auto"}:{})};
    // Chat retains only host-approved independent Skill/MCP declarations after custom overrides.
    if(provider.authMode === "oauth" && provider.oauth) applyShaping(provider.oauth.flow,headers,body,provider.oauth.credential,{
      lastMessageRole:messages.at(-1)?.role,hasImages:messages.some(m=>Array.isArray(m.content))});
    const declaredTools=body.tools;
    body=applyCustomBody(body,assistant,model);
    if(executionMode === "chat") {
      for(const key of ["tools","tool_choice","functions","function_call","toolConfig","tool_config"])delete body[key];
      if(tools.length)body.tools=declaredTools;
    }
    const allowedChatCalls=(calls:{name:string}[])=>executionMode !== "chat" || calls.every(call=>request.tools.some(tool=>tool.name===call.name));
    const startedAt=Date.now();
    const deadline=new AbortController();
    const timer=setTimeout(()=>deadline.abort(new ProviderError("等待模型响应头超时（600 秒）",true)),600_000);
    let response:Response;
    try {response=await runWithLlmRequestLog(llmLogContextFor({...provider,baseUrl:url}),()=>fetch(url,{method:"POST",headers,body:JSON.stringify(body),signal:AbortSignal.any([signal,deadline.signal])}));}
    catch(error) {
      if(signal.aborted)throw signal.reason;
      if(deadline.signal.aborted)throw deadline.signal.reason;
      throw new ProviderError(error instanceof Error?error.message:"模型连接失败",true);
    }
    finally {clearTimeout(timer);}
    console.log(`[kernel-timing] model=${request.model} headers=${Date.now()-startedAt}ms`);
    if(!response.ok) throw new ProviderError(`HTTP ${response.status}: ${(await response.text()).slice(0,1600)}`,[408,429].includes(response.status) || response.status >= 500);
    const draft=message("ASSISTANT",[]);
    const hooks:any={message:draft, sink:(e:any)=>{
      if(e.kind === "text_delta") push({type:"text",delta:e.text});
      if(e.kind === "reasoning_delta") push({type:"reasoning",delta:e.text});
    }};
    const streaming=response.headers.get("content-type")?.includes("text/event-stream");
    if(provider.type === "openai" && !provider.useResponseApi && streaming) {
      let first=true;
      for await(const event of readOpenAIResponse(response,signal)) {
        if(first && event.type !== "response" && event.delta) {first=false;console.log(`[kernel-timing] model=${request.model} firstDelta=${Date.now()-startedAt}ms`);}
        if(event.type === "response" && !allowedChatCalls(event.message.toolCalls ?? [])) throw new Error("纯对话模式拒绝工具调用，请切换到 Agent 后重试。");
        push(event);
      }
      return;
    }
    let text="",reasoning="",calls:any[]=[],wire:Json|undefined,finish:"stop"|"tools"|"length"="stop";
    if(provider.type === "claude") {
      const r=await (streaming?readClaudeStreamingRound(response,hooks,assistant,signal):readClaudeJsonRound(response,hooks,assistant));
      text=r.textOut;reasoning=r.thinkingOut;
      wire={protocol:"claude",blocks:r.blocks as Json};
      calls=r.blocks.filter(b=>b.type === "tool_use").map(b=>({id:b.id,name:b.name,arguments:JSON.stringify(b.input ?? {})}));
      if(r.stopReason === "max_tokens") finish="length";
    } else if(provider.type === "google") {
      const r=await(streaming?readGoogleStreamingRound(response,hooks,assistant,signal):readGoogleJsonRound(response,hooks,assistant));
      text=r.textOut;reasoning=r.thinkingOut;
      wire={protocol:"google",blocks:r.modelParts as Json};
      calls=r.functionCalls.map((c:any)=>({id:c.id || crypto.randomUUID(),name:c.name,arguments:JSON.stringify(c.args ?? {})}));
    } else {
      const r=await readOpenAiResponseIntoMessage(response,hooks,signal,assistant);
      text=r.content;reasoning=r.reasoning;
      calls=r.toolCalls.filter((c:any)=>c?.function?.name).map((c:any)=>({id:c.id || crypto.randomUUID(),name:c.function.name,arguments:c.function.arguments || "{}"}));
      if((r.raw as any)?.choices?.[0]?.finish_reason === "length") finish="length";
    }
    if(calls.length && finish !== "length") finish="tools";
    if(!allowedChatCalls(calls)) throw new Error("纯对话模式拒绝工具调用，请切换到 Agent 后重试。");
    if(wire && calls.length && this.isRoot(request.runId)) this.ctx.target.message.annotations.push({type:"kernel_wire",callIds:calls.map(c=>c.id),wire});
    const usage=draft.usage as any;
    push({type:"response",message:{role:"assistant",content:text,reasoning,wire,...(calls.length?{toolCalls:calls}:{})},finish,
      ...(usage?{usage:{inputTokens:usage.promptTokens ?? 0,outputTokens:usage.completionTokens ?? 0}}:{})});
  }
}
