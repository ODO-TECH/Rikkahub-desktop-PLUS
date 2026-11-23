import { state, saveState } from "../persistence/json-store";
import { model as makeModel } from "../model-providers";

/** Explicit offline test fixture. No external model calls or API keys. */
export function startAlphaDemo() {
  if(!process.argv.includes("--alpha-demo") && process.env.RIKKAHUB_ALPHA_DEMO !== "1") return;
  const mock=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const body=await request.json() as any;
    const messages=body.messages ?? [];
    const latest=[...messages].reverse().find((m:any)=>m.role === "user");
    const prompt=typeof latest?.content === "string"?latest.content:JSON.stringify(latest?.content ?? "");
    const names=(body.tools ?? []).map((t:any)=>t.function?.name);
    const toolReply=messages.at(-1)?.role === "tool";
    let call:any;
    if(!toolReply && /任务图|superagent/i.test(prompt) && names.includes("superagent")) call={name:"superagent",arguments:JSON.stringify({prompt:"演示依赖任务",tasks:[{id:"collect",prompt:"用一句话说明轻量内核的作用。"},{id:"review",prompt:"根据前置结果给出一条验收建议。",dependsOn:["collect"]}]})};
    else if(!toolReply && /子任务|subagent/i.test(prompt) && names.includes("subagent")) call={name:"subagent",arguments:JSON.stringify({input:"用一句话说明轻量内核的作用。",tools:[]})};
    else if(!toolReply && /测试工具|时间|tool/i.test(prompt) && names.includes("get_time_info")) call={name:"get_time_info",arguments:"{}"};
    else if(!toolReply && /读取文件|readfile/i.test(prompt) && names.includes("read")) call={name:"read",arguments:JSON.stringify({path:"demo.txt"})};
    else if(!toolReply && /writefile/i.test(prompt) && names.includes("write")) call={name:"write",arguments:JSON.stringify({path:"demo-output.txt",content:"alpha write proof"})};
    else if(!toolReply && /提问审批|askapproval/i.test(prompt) && names.includes("ask_user")) call={name:"ask_user",arguments:JSON.stringify({questions:[{id:"q1",question:"Alpha 测试是否通过？",options:["通过","需要调整"],selection_type:"single"}]})};
    const content=toolReply?`演示完成。工具或子任务返回：\n\n${String(messages.at(-1).content).slice(0,5000)}`:
      names.length?`这是本地 Alpha 演示回复。Agent 已就绪，可测试工具、subagent 和任务图。\n\n你发送了：${prompt}`:
      `这是本地 Alpha 纯对话回复。本次没有向模型提供工具。\n\n你发送了：${prompt}`;
    if(body.stream === false) return Response.json({choices:[{message:{role:"assistant",content},finish_reason:"stop"}],usage:{prompt_tokens:32,completion_tokens:24,total_tokens:56}});
    const encoder=new TextEncoder();
    return new Response(new ReadableStream({async start(controller){
      const send=(data:any)=>controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      try {
        if(call) send({choices:[{index:0,delta:{tool_calls:[{index:0,id:crypto.randomUUID(),type:"function",function:call}]},finish_reason:null}]});
        else for(const text of content.match(/.{1,24}|\n/g) ?? []) {
          if(request.signal.aborted) break;
          send({choices:[{index:0,delta:{content:text},finish_reason:null}]});
          await Bun.sleep(/慢速/.test(prompt)?120:8);
        }
        send({choices:[{index:0,delta:{},finish_reason:call?"tool_calls":"stop"}],usage:{prompt_tokens:32,completion_tokens:24,total_tokens:56}});
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));controller.close();
      } catch {try{controller.close();}catch{}}
    }}),{headers:{"content-type":"text/event-stream"}});
  }});
  const model={...makeModel("alpha-demo","Alpha Demo · 本地模拟"),id:"alpha-demo-model",abilities:["TOOL"] as any};
  const template=state.settings.providers.find(p=>p.type === "openai") ?? state.settings.providers[0];
  state.settings.providers=[{...template,id:"alpha-demo-provider",name:"Alpha 本地演示（模拟模型）",type:"openai",baseUrl:`http://127.0.0.1:${mock.port}/v1`,apiKey:"",enabled:true,authMode:"apiKey",useResponseApi:false,models:[model]}];
  state.settings.chatModelId=model.id;
  state.settings.fastModelId=model.id;
  state.settings.enableWebSearch=false;
  state.settings.enableSuggestion=false;
  state.settings.titleGenerationEnabled=false;
  state.settings.agentLoop={...state.settings.agentLoop!,enabled:true};
  state.settings.debugServer={enabled:true,port:Number(process.env.RIKKAHUB_ALPHA_DEBUG_PORT || 17556),token:""};
  state.settings.assistants.forEach(a=>{a.chatModelId=model.id;a.localTools=[{type:"time_info"},{type:"ask_user"}];a.systemPrompt="你是 RikkaHub Alpha 演示助手。需要时使用工具和子任务。";});
  saveState();
  console.log(`[alpha-demo] 本地模拟模型已启动，无需密钥，端口 ${mock.port}`);
}
