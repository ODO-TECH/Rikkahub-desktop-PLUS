"""Real-model acceptance against an isolated profile. No credentials in reports."""
import os,json,time,uuid,urllib.request,urllib.error,concurrent.futures
from pathlib import Path
base=os.environ.get('ALPHA_URL','http://127.0.0.1:17655')+'/api/'
out=Path(__file__).resolve().parents[1]/'alpha-evidence/alpha2';out.mkdir(parents=True,exist_ok=True)
prefix='live-stress-'+uuid.uuid4().hex[:8]
def req(path,body=None):
    request=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=25) as r:return json.load(r)
def run(case):
    name,prompt,expected=case;cid=prefix+'-'+name;start=time.monotonic()
    try:
        req('conversations/'+cid+'/messages',{'parts':[{'type':'text','text':prompt}]})
        while time.monotonic()-start<600:
            c=req('conversations/'+cid)
            if not c.get('isGenerating') and len(c['messages'])>=2:break
            time.sleep(.3)
        else:
            req('conversations/'+cid+'/stop',{});raise AssertionError('600s task deadline')
        answers=[m for n in c['messages'] for m in n['messages'] if m['role']=='ASSISTANT']
        errors=[a.get('message') for m in answers for a in m.get('annotations',[]) if a.get('type')=='model_call_error']
        assert not errors,errors
        tools=[p for m in answers for p in m['parts'] if p['type']=='tool']
        text=''.join(p.get('text','') for m in answers for p in m['parts'] if p['type']=='text')
        if expected=='subagent':assert sum(p['toolName']=='subagent' for p in tools)>=int(name[-1]),'Missing delegated task'
        elif expected=='superagent':
            tool=next(p for p in tools if p['toolName']=='superagent');ticket=json.loads(tool['output'][0]['text']);assert ticket['status']=='completed';assert len(ticket['tasks'])==3
        else:assert ''.join(expected.split()) in ''.join(text.split()),(expected,text[:200])
        # A second turn catches malformed tool history and orphaned child results.
        previous=len(c['messages'])
        req('conversations/'+cid+'/messages',{'parts':[{'type':'text','text':'Without calling any tools, reply with exactly HISTORY_OK.'}]})
        while time.monotonic()-start<900:
            c=req('conversations/'+cid)
            if not c.get('isGenerating') and len(c['messages'])>=previous+2 and c['messages'][-1]['messages'][0]['role']=='ASSISTANT':break
            time.sleep(.3)
        last=c['messages'][-1]['messages'][0]
        assert not any(a.get('type')=='model_call_error' for a in last.get('annotations',[])),'Followup failed'
        assert 'HISTORY_OK' in ''.join(''.join(p.get('text','') for p in last['parts'] if p['type']=='text').split()),'History replay did not answer'
        return {'case':name,'passed':True,'seconds':round(time.monotonic()-start,2),'conversation':cid,'tools':[t['toolName'] for t in tools],'answerLength':len(text)}
    except Exception as e:return {'case':name,'passed':False,'seconds':round(time.monotonic()-start,2),'conversation':cid,'error':str(e)[:500]}
cases=[
 ('math1','Calculate 17*23. Reply with exactly 391. No tools.','391'),
 ('math2','Sort these integers ascending: 9,-3,4,0. Reply exactly -3,0,4,9. No tools.','-3,0,4,9'),
 ('math3','Count the distinct letters in banana. Reply exactly 3. No tools.','3'),
 ('math4','Reply exactly CONCURRENT_OK. No tools.','CONCURRENT_OK'),
 ('child1','You must call subagent once. Delegate computing 19*21, with input "Compute 19*21 and return only 399", tools: []. After it returns, report the result concisely.','subagent'),
 ('child2','You must call subagent twice as two independent tool calls. First delegate "Compute 12*13. Return 156", second delegate "Compute 14*15. Return 210". Set tools to [] on each. Summarize their results concisely.','subagent'),
 ('graph','You must call superagent once with exactly three tasks: id a prompt "Return 25"; id b prompt "Return 36"; id sum prompt "Sum the numbers from predecessor results; return 61" dependsOn ["a","b"]. Use prompt "Small arithmetic task graph". Report the completed task results.','superagent'),
]
start=time.monotonic();results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for future in concurrent.futures.as_completed([pool.submit(run,c) for c in cases]):
        item=future.result();results.append(item);print(json.dumps(item,ensure_ascii=False),flush=True)
        (out/'live-stress.json').write_text(json.dumps({'model':'configured temporary provider','workers':4,'elapsedSeconds':round(time.monotonic()-start,2),'results':results},ensure_ascii=False,indent=2),encoding='utf-8')
assert all(r['passed'] for r in results), 'Some real model cases failed; inspect live-stress.json'
