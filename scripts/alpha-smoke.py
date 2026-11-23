"""Run against an isolated --alpha-demo server. Writes test conversations only."""
import urllib.request, urllib.error, json, time, uuid, os
from pathlib import Path
base=os.environ.get('ALPHA_URL','http://127.0.0.1:17555').rstrip('/')+'/api/'
report=[]
def req(path,body=None,status=None):
    r=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    try:
        response=urllib.request.urlopen(r);code=response.status;raw=response.read()
    except urllib.error.HTTPError as e:code=e.code;raw=e.read()
    assert (200<=code<300 if status is None else code==status),(path,code,raw[:500])
    return json.loads(raw) if raw else None
def wait(ident,predicate=lambda c:not c.get('isGenerating')):
    for _ in range(200):
        c=req('conversations/'+ident)
        if predicate(c):return c
        time.sleep(.05)
    raise AssertionError('Conversation timed out: '+ident)
def send(ident,text,**extra):return req('conversations/'+ident+'/messages',{'parts':[{'type':'text','text':text}],**extra})
def reply(c):return c['messages'][-1]['messages'][0]
def tools(c):return [p for p in reply(c)['parts'] if p['type']=='tool']
def text(c):return ''.join(p.get('text','') for p in reply(c)['parts'] if p['type']=='text')
def passed(name):report.append(name);print('PASS',name,flush=True)
prefix='alpha-smoke-'+uuid.uuid4().hex[:8]
ident=prefix+'-mixed'
send(ident,'hello');c=wait(ident);assert c['executionMode']=='agent';assert text(c);passed('new conversations default to agent')
req('conversations/'+ident+'/mode',{'executionMode':'chat'})
send(ident,'tool');c=wait(ident);assert len(c['messages'])==4 and not tools(c);assert reply(c)['annotations'][0]['mode']=='chat';assert c['executionMode']=='chat' and c['conversationKind']=='agent';passed('chat gear persists without changing conversation kind')
send(ident,'tool');c=wait(ident);assert len(c['messages'])==6 and not tools(c) and c['executionMode']=='chat';passed('following turn preserves chat gear')
req('conversations/'+ident+'/mode',{'executionMode':'agent'});send(ident,'tool');c=wait(ident);assert any(t['toolName']=='get_time_info' for t in tools(c));passed('switching back to agent restores tools and preserves history')
req('conversations/'+ident+'/mode',{'executionMode':'bad'},status=400);passed('invalid mode rejected')
for suffix,prompt,name in [('child','subagent','subagent'),('super','superagent','superagent')]:
    cid=prefix+'-'+suffix;send(cid,prompt);c=wait(cid);t=next(t for t in tools(c) if t['toolName']==name)
    assert t['output'] and not any(a['type']=='model_call_error' for a in reply(c)['annotations'])
    if suffix=='super':
        ticket=json.loads(t['output'][0]['text']);assert ticket['status']=='completed' and len(ticket['tasks'])==2;assert all(task['status']=='completed' for task in ticket['tasks'])
    passed(name+' completes and returns a result')
cid=prefix+'-approval';send(cid,'askapproval')
c=wait(cid,lambda c:any(t.get('approvalState',{}).get('type')=='pending' for t in tools(c)))
other=prefix+'-approval-independent';send(other,'tool');independent=wait(other)
assert any(t['toolName']=='get_time_info' for t in tools(independent));passed('waiting for an answer does not block tools in other conversations')
t=tools(c)[0];req('conversations/'+cid+'/tool-approval',{'toolCallId':t['toolCallId'],'approved':True,'answer':json.dumps({'answers':{'q1':'通过'}},ensure_ascii=False)})
c=wait(cid);assert text(c);passed('ask_user waits for an answer and resumes in place')
cid=prefix+'-cancel';send(cid,'慢速 reply '+('continue '*80))
c=wait(cid,lambda c:c.get('isGenerating') and bool(text(c)))
req('conversations/'+cid+'/mode',{'executionMode':'chat'})
req('conversations/'+cid+'/stop',{})
c=wait(cid);assert c['executionMode']=='chat' and reply(c)['annotations'][0]['mode']=='agent';passed('changing next gear does not alter active generation; stop cancels it')
send(cid,'tool');c=wait(cid);assert not tools(c) and reply(c)['annotations'][0]['mode']=='chat' and c['executionMode']=='chat';passed('gear set during generation stays active on following messages')
cid=prefix+'-chat-only';send(cid,'tool',conversationKind='chat',executionMode='chat');c=wait(cid);assert c['conversationKind']=='chat' and not tools(c)
req('conversations/'+cid+'/mode',{'executionMode':'agent'},status=409)
send(cid,'tool',executionMode='agent');c=wait(cid);assert not tools(c) and reply(c)['annotations'][0]['mode']=='chat';passed('pure chat has no agent gear and cannot enable tools via API')
cid=prefix+'-queued-gears';send(cid,'慢速 reply '+('continue '*12));wait(cid,lambda c:c.get('isGenerating') and bool(text(c)))
req('conversations/'+cid+'/mode',{'executionMode':'chat'});send(cid,'tool');req('conversations/'+cid+'/mode',{'executionMode':'agent'});send(cid,'tool')
c=wait(cid,lambda c:not c.get('isGenerating') and len(c['messages'])==6)
answers=[n['messages'][0] for n in c['messages'] if n['messages'][0]['role']=='ASSISTANT']
assert [m['annotations'][0]['mode'] for m in answers]==['agent','chat','agent']
assert not any(p['type']=='tool' for p in answers[1]['parts']) and any(p['type']=='tool' for p in answers[2]['parts']);passed('queued messages retain independent gears and preserve FIFO order')
workspace=req('workspaces',{'type':'managed','name':'Alpha smoke workspace'})['workspace']
path=Path(workspace['root']).resolve()
allowed=Path(os.environ['ALPHA_DATA_DIR']).resolve()
assert path.is_relative_to(allowed),path
(path/'demo.txt').write_text('alpha workspace proof',encoding='utf-8')
cid=prefix+'-files';send(cid,'readfile',workspaceId=workspace['id']);c=wait(cid)
assert any('alpha workspace proof' in json.dumps(t['output']) for t in tools(c));passed('workspace read uses guarded host tools')
send(cid,'writefile');c=wait(cid)
assert (path/'demo-output.txt').read_text(encoding='utf-8')=='alpha write proof'
passed('workspace write finishes inside the guarded directory')
out=Path(os.environ.get('ALPHA_REPORT','alpha-smoke-report.json'));out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps({'passed':report,'conversation':ident,'workspace':workspace['id'],'base':base},ensure_ascii=False,indent=2),encoding='utf-8')
print(len(report),'checks passed')
