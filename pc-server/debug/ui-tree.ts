/** Read-only UI inspection over the shell/browser's opt-in localhost CDP port. */
export async function inspectUiTree(mainPort: number | null) {
  const result=await callUiDebug(mainPort,"Accessibility.getFullAXTree",{});
  if(!result.available)return result;
  return {available:true,url:result.url,nodes:(result.result?.nodes ?? []).filter((n:any)=>!n.ignored).map((n:any)=>({id:n.nodeId,role:n.role?.value,name:n.name?.value,children:n.childIds,properties:n.properties}))};
}

/** Local administrator CDP channel: settings UI, screenshots, input and runtime inspection. */
export async function callUiDebug(mainPort:number|null,method:string,params:Record<string,unknown>):Promise<any> {
  if(!/^[A-Za-z]+\.[A-Za-z]+$/.test(method))throw new Error("Invalid CDP method");
  const port=Number(process.env.RIKKAHUB_ALPHA_CDP_PORT ?? 0);
  if(!Number.isInteger(port) || port<1024 || port>65535) return {available:false,reason:"未启用 Alpha CDP 调试端口"};
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(3000)})).json() as any[];
  const page=targets.find(t=>t.type === "page" && t.url?.includes(`:${mainPort}`));
  if(!page?.webSocketDebuggerUrl) return {available:false,reason:"没有找到当前应用页面"};
  return await new Promise((resolve,reject)=>{
    const socket=new WebSocket(page.webSocketDebuggerUrl);
    const timeout=setTimeout(()=>{socket.close();reject(new Error("UI tree timeout"));},5000);
    socket.onopen=()=>socket.send(JSON.stringify({id:1,method,params}));
    socket.onmessage=e=>{
      const data=JSON.parse(String(e.data));if(data.id !== 1)return;
      clearTimeout(timeout);socket.close();
      if(data.error){reject(new Error(data.error.message ?? "CDP command failed"));return;}
      resolve({available:true,url:page.url,result:data.result});
    };
    socket.onerror=()=>{clearTimeout(timeout);socket.close();reject(new Error("CDP connection failed"));};
  });
}
