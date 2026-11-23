"""Two concurrent real-model file tasks, confined to new managed test workspaces."""
import os,json,time,uuid,concurrent.futures,urllib.request
from pathlib import Path
base=os.environ.get('ALPHA_URL','http://127.0.0.1:17655')+'/api/'
allowed=Path(os.environ['ALPHA_DATA_DIR']).resolve()
def req(path,body=None):
    with urllib.request.urlopen(urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'}),timeout=25) as r:return json.load(r)
def run(i):
    start=time.monotonic();cid='live-files-'+uuid.uuid4().hex[:8]
    workspace=req('workspaces',{'type':'managed','name':'Alpha2 live files '+str(i)})['workspace'];root=Path(workspace['root']).resolve();assert root.is_relative_to(allowed)
    rows=[{'price':7+i,'quantity':3},{'price':11,'quantity':2},{'price':5,'quantity':4}];total=sum(x['price']*x['quantity'] for x in rows)
    (root/'orders.json').write_text(json.dumps(rows),encoding='utf-8')
    prompt='In this workspace, call subagent once with tools ["read"]. Ask the child to read orders.json and calculate sum(price*quantity). After receiving the child result, use the write tool to create report.json with a JSON object containing exactly {"total": calculated_number, "rows": 3}. Do not use shell or external tools. Then report completion concisely.'
    req('conversations/'+cid+'/messages',{'parts':[{'type':'text','text':prompt}],'workspaceId':workspace['id']})
    try:
        while time.monotonic()-start<600:
            c=req('conversations/'+cid)
            if not c.get('isGenerating') and len(c['messages'])>=2:break
            time.sleep(.3)
        else:req('conversations/'+cid+'/stop',{});raise AssertionError('task timed out')
        messages=[m for n in c['messages'] for m in n['messages'] if m['role']=='ASSISTANT'];tools=[p for m in messages for p in m['parts'] if p['type']=='tool']
        assert not any(a.get('type')=='model_call_error' for m in messages for a in m.get('annotations',[])),'model error'
        assert any(t['toolName']=='subagent' for t in tools),'subagent not called'
        assert any(t['toolName']=='read' for t in tools),'child read not called'
        assert json.loads((root/'report.json').read_text(encoding='utf-8'))=={'total':total,'rows':3}
        return {'passed':True,'conversation':cid,'seconds':round(time.monotonic()-start,2),'expectedTotal':total,'tools':[t['toolName'] for t in tools]}
    except Exception as e:return {'passed':False,'conversation':cid,'seconds':round(time.monotonic()-start,2),'error':str(e)[:300]}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,range(2)))
out=Path(__file__).resolve().parents[1]/'alpha-evidence/alpha2';out.mkdir(parents=True,exist_ok=True);(out/'live-workspace.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(results,indent=2));assert all(r['passed'] for r in results)
