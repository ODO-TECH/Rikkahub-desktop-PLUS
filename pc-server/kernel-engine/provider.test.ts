import {expect,test} from "bun:test";
import {DesktopProvider} from "./provider";
import {defaultAssistant} from "../assistants";
import {model,provider} from "../model-providers";
import type {EngineRunContext} from "../engines";
import type {Message,ModelEvent,ModelRequest} from "../../agent-kernel/src/types";

async function scenario(kind:"claude"|"google",response:unknown,assertReplay:(body:any)=>void) {
  const bodies:any[]=[];
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){bodies.push(await req.json());return Response.json(response);}});
  const selected=model("fake","Fake");const host=provider({id:"native-test",name:"Native test",type:kind,baseUrl:`http://127.0.0.1:${server.port}/v1`,apiKey:"test",models:[selected]});
  const ctx={provider:host,assistant:defaultAssistant(),model:selected,conversation:{id:"test",executionMode:"agent"}} as unknown as EngineRunContext;
  const adapter=new DesktopProvider(ctx,()=>{});
  const input:ModelRequest={model:"fake",messages:[{role:"user",content:"work"}],tools:[{name:"inspect",description:"read",parameters:{type:"object"}}],maxOutputTokens:1024};
  try {
    const events:ModelEvent[]=[];for await(const e of adapter.stream(input,new AbortController().signal))events.push(e);
    const result=events.at(-1) as Extract<ModelEvent,{type:"response"}>;
    expect(result.finish).toBe("tools");expect(result.message.toolCalls).toHaveLength(1);
    const call=result.message.toolCalls![0];
    const messages:Message[]=[...input.messages,result.message,{role:"tool",toolCallId:call.id,content:"proof"}];
    for await(const _event of adapter.stream({...input,messages},new AbortController().signal)){}
    assertReplay(bodies[1]);
  }finally{server.stop(true);}
}
test("Claude signed thinking and tool-use blocks survive a kernel tool round",async()=>{
  await scenario("claude",{content:[{type:"thinking",thinking:"reason",signature:"claude-signature"},{type:"tool_use",id:"c1",name:"inspect",input:{}}],stop_reason:"tool_use",usage:{input_tokens:12,output_tokens:4}},body=>{
    const assistant=body.messages.find((m:any)=>m.role==="assistant");
    expect(assistant.content[0].signature).toBe("claude-signature");expect(assistant.content[1].id).toBe("c1");
    expect(body.messages.at(-1).content[0].tool_use_id).toBe("c1");
  });
});
test("Gemini function-call thought signature survives a kernel tool round",async()=>{
  await scenario("google",{candidates:[{content:{role:"model",parts:[{functionCall:{name:"inspect",args:{}},thoughtSignature:"gemini-signature"}]},finishReason:"STOP"}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:4}},body=>{
    const assistant=body.contents.find((m:any)=>m.role==="model");
    expect(assistant.parts[0].thoughtSignature).toBe("gemini-signature");
    expect(body.contents.at(-1).parts[0].functionResponse.name).toBe("inspect");
  });
});
test("pure chat rejects unsolicited tool calls before execution",async()=>{
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:"bad",function:{name:"artifact_read",arguments:"{}"}}]},finish_reason:"tool_calls"}]})+'\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}});}});
  const selected=model("fake","Fake");
  const ctx={provider:provider({id:"chat-test",name:"Chat test",baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[selected]}),assistant:defaultAssistant(),model:selected,conversation:{id:"chat",executionMode:"chat"}} as unknown as EngineRunContext;
  try {
    const work=async()=>{for await(const _ of new DesktopProvider(ctx,()=>{}).stream({model:"fake",messages:[{role:"user",content:"hi"}],tools:[],maxOutputTokens:1024},new AbortController().signal)){}};
    await expect(work()).rejects.toThrow("纯对话模式拒绝工具调用");
  }finally{server.stop(true);}
});

test("next-turn mode cannot change an active pure-chat request or inject custom tools",async()=>{
  let body:any;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){body=await request.json();return new Response('data: '+JSON.stringify({choices:[{delta:{content:"ok"},finish_reason:"stop"}]})+'\n\n',{headers:{"content-type":"text/event-stream"}});}});
  const selected=model("fake","Fake"),assistant=defaultAssistant();
  assistant.customBodies=["tools","tool_choice","functions","function_call","toolConfig","tool_config"].map(key=>({key,value:JSON.stringify([{name:"unexpected"}])}));
  const ctx={provider:provider({id:"test",name:"test",baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[selected]}),assistant,model:selected,conversation:{id:"mixed",executionMode:"agent"},executionMode:"chat"} as unknown as EngineRunContext;
  try {
    for await(const _ of new DesktopProvider(ctx,()=>{}).stream({model:"fake",messages:[{role:"user",content:"hi"}],tools:[],maxOutputTokens:1024},new AbortController().signal)){}
    for(const key of ["tools","tool_choice","functions","function_call","toolConfig","tool_config"])expect(body[key]).toBeUndefined();
  }finally{server.stop(true);}
});

async function captureSettings(kind:"openai"|"responses"|"claude"|"google",options:{topP?:number;modelId?:string;reasoning?:string}={}) {
  let body:any,url="";
  const response=kind === "claude" ? {content:[{type:"text",text:"SETTINGS_OK"}],stop_reason:"end_turn"}
    : kind === "google" ? {candidates:[{content:{role:"model",parts:[{text:"SETTINGS_OK"}]},finishReason:"STOP"}]}
    : kind === "responses" ? {object:"response",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"SETTINGS_OK"}]}]}
    : {choices:[{message:{role:"assistant",content:"SETTINGS_OK"},finish_reason:"stop"}]};
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){url=req.url;body=await req.json();return Response.json(response);}});
  const selected=model(options.modelId ?? "fake","Fake");
  if(options.reasoning)selected.abilities=["REASONING"];
  const assistant=defaultAssistant();
  Object.assign(assistant,{streamOutput:false,temperature:0,topP:options.topP ?? 0.8,maxTokens:0,reasoningLevel:options.reasoning ?? "AUTO"});
  const host=provider({id:"settings-test",name:"Settings",type:kind === "responses" ? "openai" : kind,
    baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[selected],useResponseApi:kind === "responses"});
  const ctx={provider:host,assistant,model:selected,conversation:{id:"settings",executionMode:"agent"}} as unknown as EngineRunContext;
  try {
    const events:ModelEvent[]=[];
    for await(const event of new DesktopProvider(ctx,()=>{}).stream({model:selected.modelId,messages:[{role:"user",content:"check settings"}],tools:[],maxOutputTokens:1024},new AbortController().signal))events.push(event);
    const result=events.at(-1) as Extract<ModelEvent,{type:"response"}>;
    expect(result.message.content).toBe("SETTINGS_OK");
    return {body,url};
  }finally{server.stop(true);}
}

for(const kind of ["openai","responses","claude","google"] as const) {
  test(`${kind}: assistant non-streaming and sampling settings reach the provider`,async()=>{
    const {body,url}=await captureSettings(kind);
    const sampling=kind === "google" ? body.generationConfig : body;
    expect(sampling.temperature).toBe(0);
    expect(sampling[kind === "google" ? "topP" : "top_p"]).toBe(0.8);
    if(kind === "google") {
      expect(url).toEndWith(":generateContent");
      expect(sampling.maxOutputTokens).toBeUndefined();
    }else {
      expect(body.stream).toBe(false);
      expect(body.stream_options).toBeUndefined();
      if(kind !== "claude") {
        expect(body.max_tokens).toBeUndefined();
        expect(body.max_output_tokens).toBeUndefined();
      }
    }
  });
}

test("unset top P and sampling-locked models retain the shared request rules",async()=>{
  const {body:unset}=await captureSettings("openai",{topP:0});
  expect(unset.top_p).toBeUndefined();
  const {body:locked}=await captureSettings("openai",{modelId:"o3"});
  expect(locked.temperature).toBeUndefined();expect(locked.top_p).toBeUndefined();
});

test("Claude thinking settings exclude incompatible temperature",async()=>{
  const {body}=await captureSettings("claude",{reasoning:"HIGH"});
  expect(body.thinking.type).toBe("adaptive");expect(body.output_config.effort).toBe("high");
  expect(body.temperature).toBeUndefined();
  const {body:off}=await captureSettings("claude",{reasoning:"OFF"});
  expect(off.thinking.type).toBe("disabled");expect(off.temperature).toBe(0);
});

test("Responses thinking level uses the shared reasoning dialect",async()=>{
  const {body}=await captureSettings("responses",{reasoning:"HIGH"});
  expect(body.reasoning.effort).toBe("high");
  expect(body.store).toBe(false);
});
