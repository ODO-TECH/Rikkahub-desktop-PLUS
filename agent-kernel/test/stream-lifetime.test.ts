import {expect,test} from "bun:test";
import {OpenAIProvider,readOpenAIResponse} from "../src/openai";

test("continuous reasoning outlives the response-header deadline",async()=>{
  const encoder=new TextEncoder();
  const provider=new OpenAIProvider({endpoint:"http://localhost/test",timeoutMs:25,
    fetch:(async()=>new Response(new ReadableStream({async start(controller){
      for(let i=0;i<12;i++) {
        controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{reasoning_content:"thinking"},finish_reason:null}]})+'\n\n'));
        await Bun.sleep(6);
      }
      controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{content:"done"},finish_reason:"stop"}]})+'\n\n'));
      controller.close();
    }}),{headers:{"content-type":"text/event-stream"}})) as unknown as typeof fetch});
  const events=[];
  for await(const event of provider.stream({model:"test",messages:[{role:"user",content:"work"}],tools:[],maxOutputTokens:100},new AbortController().signal))events.push(event);
  expect(events.filter(e=>e.type==="reasoning")).toHaveLength(12);
  expect(events.at(-1)?.type).toBe("response");
});

test("a stalled reader times out and cancels its body",async()=>{
  let cancelled=false;
  const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
  await expect((async()=>{for await(const _ of readOpenAIResponse(response,new AbortController().signal,15)){}})()).rejects.toThrow("idle timeout");
  expect(cancelled).toBe(true);
});
test("user cancellation interrupts a stalled reader immediately",async()=>{
  const controller=new AbortController();
  const response=new Response(new ReadableStream());
  const work=(async()=>{for await(const _ of readOpenAIResponse(response,controller.signal,10_000)){}})();
  controller.abort(new Error("cancelled by user"));
  await expect(work).rejects.toThrow("cancelled by user");
});
test("network read failures retry only before any reasoning or text",async()=>{
  for(const partial of [false,true]) {
    let reads=0;
    const response=new Response(new ReadableStream({pull(controller){
      if(partial && reads++===0)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{reasoning_content:"partial"}}]})+'\n\n'));
      else controller.error(new TypeError("connection reset"));
    }}));
    let failure:any;
    try {for await(const _ of readOpenAIResponse(response,new AbortController().signal)){}}catch(error){failure=error;}
    expect(failure.retryable).toBe(!partial);
  }
});
