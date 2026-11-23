import {expect,test} from "bun:test";
import {AgentRuntime,KernelStore,answerOf} from "../src/index";
import {Semaphore,ToolScheduler} from "../src/concurrency";
import type {ModelProvider,Tool} from "../src/types";

test("64 concurrent desktop-style runtimes share model slots and a writer barrier",async()=>{
  const store=new KernelStore();const modelSlots=new Semaphore(3),toolScheduler=new ToolScheduler(4);
  let models=0,peak=0,readers=0,writers=0,violations=0,writes=0;
  const tools:Tool[]=[{name:"read",description:"read",parameters:{type:"object"},readOnly:true,async execute(){
    if(writers)violations++;readers++;await Bun.sleep(1);readers--;return {content:"read"};
  }},{name:"write",description:"write",parameters:{type:"object"},async execute(){
    if(writers||readers)violations++;writers++;await Bun.sleep(1);writes++;writers--;return {content:"written"};
  }}];
  const provider:ModelProvider={async *stream(request){
    models++;peak=Math.max(peak,models);await Bun.sleep(1);
    try {
      const toolsDone=request.messages.at(-1)?.role === "tool";
      yield {type:"response",finish:toolsDone?"stop":"tools",message:toolsDone?{role:"assistant",content:request.messages[0].content}:{role:"assistant",content:"",toolCalls:[{id:crypto.randomUUID(),name:"read",arguments:"{}"},{id:crypto.randomUUID(),name:"write",arguments:"{}"}]}};
    }finally{models--;}
  }};
  try {
    const runs=await Promise.all(Array.from({length:64},async(_,i)=>{
      const runtime=new AgentRuntime({store,provider,tools,modelSlots,toolScheduler});
      return runtime.start({model:"fake",input:"isolated-"+i,tools:["read","write"],limits:{maxRequests:2}});
    }));
    expect(runs.every(r=>r.status === "completed")).toBe(true);
    expect(runs.map(answerOf)).toEqual(Array.from({length:64},(_,i)=>"isolated-"+i));
    expect(peak).toBe(3);expect(violations).toBe(0);expect(writes).toBe(64);
    expect(runs.every(r=>store.budget(r.id).requests===2)).toBe(true);
  }finally{store.close();}
},15_000);

test("24 parents delegate two children each without exhausting shared slots or crossing budgets",async()=>{
  const store=new KernelStore(),modelSlots=new Semaphore(2),toolScheduler=new ToolScheduler(1);
  const provider:ModelProvider={async *stream(request){
    await Bun.sleep(1);
    const input=request.messages.at(-1)!;
    const parent=input.role === "user" && input.content.startsWith("parent-");
    yield {type:"response",finish:parent?"tools":"stop",message:parent?{role:"assistant",content:"",toolCalls:[0,1].map(i=>({id:crypto.randomUUID(),name:"subagent",arguments:JSON.stringify({input:"child-"+i,tools:[]})}))}:{role:"assistant",content:"ok"}};
  }};
  try {
    const runs=await Promise.all(Array.from({length:24},(_,i)=>new AgentRuntime({store,provider,modelSlots,toolScheduler}).start({model:"fake",input:"parent-"+i,tools:["subagent"],limits:{maxRequests:4}})));
    expect(runs.every(r=>r.status === "completed")).toBe(true);
    expect(store.runs()).toHaveLength(72);
    for(const r of runs){expect(store.budget(r.id).requests).toBe(4);expect(store.runs().filter(c=>c.parentId===r.id)).toHaveLength(2);}
  }finally{store.close();}
},15_000);

test("cancelling queued and active requests releases slots for subsequent work",async()=>{
  const store=new KernelStore(),modelSlots=new Semaphore(1),toolScheduler=new ToolScheduler(1);
  const provider:ModelProvider={async *stream(_request,signal){
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,15);signal.addEventListener("abort",()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});
    yield {type:"response",finish:"stop",message:{role:"assistant",content:"done"}};
  }};
  try {
    const controllers=Array.from({length:32},()=>new AbortController());
    const tasks=controllers.map((c,i)=>new AgentRuntime({store,provider,modelSlots,toolScheduler}).start({model:"fake",input:"cancel-"+i},c.signal));
    await Bun.sleep(2);controllers.forEach(c=>c.abort());
    const runs=await Promise.all(tasks);expect(runs.every(r=>r.status === "cancelled")).toBe(true);
    const next=await new AgentRuntime({store,provider,modelSlots,toolScheduler}).start({model:"fake",input:"next"});expect(next.status).toBe("completed");
  }finally{store.close();}
},10_000);
