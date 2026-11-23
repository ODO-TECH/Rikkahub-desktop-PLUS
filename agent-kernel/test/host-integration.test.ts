import { expect,test } from "bun:test";
import { AgentRuntime,KernelStore,Superagent } from "../src/index";
import type { ModelProvider,ModelRequest } from "../src/types";
import { Semaphore } from "../src/concurrency";

test("desktop child model scope rejects invented models before contacting a provider",async()=>{
  const store=new KernelStore();const requests:ModelRequest[]=[];
  const provider:ModelProvider={async *stream(request){requests.push(structuredClone(request));const first=request.messages.at(-1)?.role==="user";
    yield {type:"response",message:first?{role:"assistant",content:"",toolCalls:[{id:"child",name:"subagent",arguments:JSON.stringify({input:"work",model:"invented-model"})}]}:{role:"assistant",content:"done"},finish:first?"tools":"stop"};}};
  const runtime=new AgentRuntime({store,provider,childModels:["fake"]});
  try {
    const run=await runtime.start({model:"fake",input:"delegate",tools:["subagent"]});
    expect(run.status).toBe("completed");
    expect(requests.every(r=>r.model==="fake")).toBe(true);
    expect(requests[0].tools.find(t=>t.name==="subagent")?.parameters.properties?.model.enum).toEqual(["fake"]);
    expect(store.runs()).toHaveLength(1);
    expect(run.messages.find(m=>m.role==="tool")?.content).toContain("enum");
  }finally{store.close();}
});

test("restricted host keeps paging and agent tools out of chat requests",async()=>{
  const store=new KernelStore();const requests:ModelRequest[]=[];
  const provider:ModelProvider={async *stream(request){requests.push(structuredClone(request));yield {type:"response",message:request.messages.at(-1)?.role==="tool"?{role:"assistant",content:"done"}:{role:"assistant",content:"",toolCalls:[{id:"safe",name:"mcp__echo",arguments:"{}"}]},finish:request.messages.at(-1)?.role==="tool"?"stop":"tools"};}};
  const runtime=new AgentRuntime({store,provider,artifactPaging:false,tools:[{name:"mcp__echo",description:"safe",parameters:{type:"object"},execute:async()=>({content:"x".repeat(100)})}]});
  try {
    const run=await runtime.start({model:"fake",input:"chat",tools:["mcp__echo"],limits:{maxToolOutputChars:10}});
    expect(run.status).toBe("completed");
    expect(requests.every(r=>r.tools.length===1 && r.tools[0].name==="mcp__echo")).toBe(true);
    expect(run.messages.find(m=>m.role==="tool")?.content).not.toContain("artifact_read");
    const empty=runtime.create({model:"fake",input:"hello",tools:[]});
    expect(runtime.inspect(empty).tools).toEqual([]);
    expect(store.runs([run.id]).map(r=>r.id)).toEqual([run.id]);
    expect(store.runs([])).toEqual([]);
  }finally{store.close();}
});

test("long background requests leave a slot for a new foreground conversation", async () => {
  const store = new KernelStore(), slots = new Semaphore(3), background = new Semaphore(2);
  let entered = 0, foreground = false, release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  const provider: ModelProvider = { async *stream(request) {
    if (request.messages.at(-1)?.content === "background") { entered++; await blocked; }
    else foreground = true;
    yield { type: "response", message: { role: "assistant", content: "done" }, finish: "stop" };
  } };
  const runtime = new AgentRuntime({ store, provider, modelSlots: slots, backgroundModelSlots: background });
  const root = runtime.create({ model: "fake", input: "root" });
  const jobs = Array.from({length: 3}, () => runtime.resume(runtime.createWork({model:"fake",input:"background"}, root)));
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    const interactive = runtime.start({model:"fake",input:"hello"});
    await new Promise(resolve => setTimeout(resolve, 30));
    const observed = {foreground, entered};
    release(); await Promise.all([...jobs, interactive]);
    expect(observed).toEqual({foreground:true, entered:2});
  } finally { release(); await Promise.all(jobs); store.close(); }
});

test("host final verification continues within the step budget and persists boundary input",async()=>{
  const store=new KernelStore();const requests:ModelRequest[]=[];let verify=0;
  const provider:ModelProvider={async *stream(request){requests.push(structuredClone(request));yield {type:"response",message:{role:"assistant",content:"answer"},finish:"stop"};}};
  const runtime=new AgentRuntime({store,provider,beforeStep(run){if(run.steps===1)run.messages.push({role:"user",content:"boundary input"});},onFinal(){return verify++===0?["verify evidence"]:[];}});
  try {
    const run=await runtime.start({model:"fake",input:"work",limits:{maxSteps:2}});
    expect(run.status).toBe("completed");expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)?.content).toBe("boundary input");
    expect(run.messages.some(m=>m.content==="verify evidence")).toBe(true);
    expect(requests[0].runId).toBe(run.id);
  }finally{store.close();}
});

test("host orchestration yields the only tool slot and shares the parent's request budget",async()=>{
  const store=new KernelStore();let runtime:AgentRuntime;let callId="";
  const provider:ModelProvider={async *stream(request){
    const input=request.messages.at(-1)?.content;
    yield {type:"response",message:input==="parent"?{role:"assistant",content:"",toolCalls:[{id:"coord",name:"coordinate",arguments:"{}"}]}:{role:"assistant",content:"done"},finish:input==="parent"?"tools":"stop"};
  }};
  runtime=new AgentRuntime({store,provider,toolConcurrency:1,modelConcurrency:1,tools:[{name:"coordinate",description:"delegate",parameters:{type:"object"},orchestrator:true,async execute(_args,ctx){
    callId=ctx.callId;
    const parent=runtime.inspect(ctx.runId);
    const supervisor=new Superagent({runtime});
    const ticket=supervisor.accept({source:"test",triggerId:ctx.callId,prompt:"child",model:"fake",budgetId:parent.rootId,tools:[]});
    const result=await supervisor.advance(ticket.id);
    return {content:result.status};
  }}]});
  try {
    const run=await runtime.start({model:"fake",input:"parent",limits:{maxRequests:3}});
    expect(run.status).toBe("completed");expect(callId).toBe("coord");expect(store.budget(run.id).requests).toBe(3);
  }finally{store.close();}
});
