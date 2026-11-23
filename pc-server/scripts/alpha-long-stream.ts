/** Real wall-clock regression: exercise the desktop adapter past 120 seconds. */
import {DesktopProvider} from "../kernel-engine/provider";
import {defaultAssistant} from "../assistants";
import {model,provider} from "../model-providers";
import type {EngineRunContext} from "../engines";
import {mkdirSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
const duration=Number(process.env.ALPHA_STREAM_MS ?? 125_500);
const encoder=new TextEncoder();let bytes=0;
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return new Response(new ReadableStream({async start(c){
  const start=performance.now();
  const send=(delta:any,finish:any=null)=>{const s='data: '+JSON.stringify({choices:[{delta,finish_reason:finish}]})+'\n\n';bytes+=s.length;c.enqueue(encoder.encode(s));};
  try {while(performance.now()-start<duration){send({reasoning_content:"still thinking "});await Bun.sleep(250);}send({content:"LONG_STREAM_OK"},"stop");c.close();}catch{try{c.close();}catch{}}
}}),{headers:{"content-type":"text/event-stream"}});}});
const selected=model("test","Long stream");
const ctx={provider:provider({id:"local-clock-test",name:"local",baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[selected]}),assistant:defaultAssistant(),model:selected,conversation:{id:"long-clock",executionMode:"agent"},executionMode:"agent"} as unknown as EngineRunContext;
const started=performance.now();let text="",reasoningChunks=0;
try {
  for await(const e of new DesktopProvider(ctx,()=>{}).stream({model:"test",messages:[{role:"user",content:"reason slowly"}],tools:[],maxOutputTokens:4096},new AbortController().signal)){
    if(e.type==="reasoning")reasoningChunks++;
    if(e.type==="response")text=e.message.content;
  }
  if(text!=="LONG_STREAM_OK" || performance.now()-started<120_000)throw new Error("Long-stream regression failed");
  const out=resolve(import.meta.dir,"../../alpha-evidence/alpha2");mkdirSync(out,{recursive:true});
  const result={passed:true,seconds:Math.round((performance.now()-started)/10)/100,reasoningChunks,bytes,adapter:"DesktopProvider",transport:"real localhost SSE"};writeFileSync(resolve(out,"long-stream.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{server.stop(true);}
