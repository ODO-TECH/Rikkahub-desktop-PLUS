"""CDP QA against the isolated alpha browser; requires websocket-client."""
import urllib.request,json,time,base64,os
from pathlib import Path
import websocket
root=Path(__file__).resolve().parents[1]
out=Path(os.environ.get('ALPHA_EVIDENCE_DIR',str(root/'alpha-evidence')));out.mkdir(parents=True,exist_ok=True)
base=os.environ.get('ALPHA_URL','http://127.0.0.1:17555')
cdp_port=os.environ.get('ALPHA_CDP_PORT','17557')
target=next(p for p in json.load(urllib.request.urlopen('http://127.0.0.1:'+cdp_port+'/json/list')) if p['type']=='page' and ':17555' in p['url'])
w=websocket.create_connection(target['webSocketDebuggerUrl'],suppress_origin=True,timeout=8)
sequence=0;errors=[];checks=[]
def cdp(method,params={}):
    global sequence
    sequence+=1;ident=sequence;w.send(json.dumps({'id':ident,'method':method,'params':params}))
    while True:
        value=json.loads(w.recv())
        if value.get('method')=='Runtime.exceptionThrown':errors.append(value)
        if value.get('id')==ident:
            assert not value.get('error'),value
            return value.get('result',{})
def js(expression):
    result=cdp('Runtime.evaluate',{'expression':expression,'returnByValue':True,'awaitPromise':True})
    assert not result.get('exceptionDetails'),result
    return result.get('result',{}).get('value')
def until(expression):
    for _ in range(100):
        if js(expression):return
        time.sleep(.1)
    raise AssertionError(expression)
def go(path):
    cdp('Page.navigate',{'url':base+path});until('location.href==='+json.dumps(base+path));until('document.readyState==="complete"');until('!!document.querySelector("textarea")' if path.startswith('/c/') or path=='/' else 'document.body.innerText.length>100')
def tap(expression):
    box=js('(()=>{const e='+expression+';if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()');assert box,expression
    cdp('Input.dispatchMouseEvent',{'type':'mouseMoved',**box})
    cdp('Input.dispatchMouseEvent',{'type':'mousePressed','button':'left','clickCount':1,**box})
    cdp('Input.dispatchMouseEvent',{'type':'mouseReleased','button':'left','clickCount':1,**box})
def click(text):
    tap('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==='+json.dumps(text)+')')
def shot(name):
    time.sleep(.6)
    (out/(name+'.png')).write_bytes(base64.b64decode(cdp('Page.captureScreenshot',{'format':'png'})['data']))
    tree=json.load(urllib.request.urlopen('http://127.0.0.1:17556/debug/ui-tree'))
    (out/(name+'-ui-tree.json')).write_text(json.dumps(tree,ensure_ascii=False,indent=2),encoding='utf-8')
def passed(text):checks.append(text);print('PASS',text,flush=True)
cdp('Runtime.enable');cdp('Page.enable')
go('/')
until('!!document.querySelector("button[aria-pressed=true]")')
assert js('document.querySelector("button[aria-pressed=true]").textContent.trim()')=='Agent';passed('home defaults to Agent')
tap('document.querySelector("button[aria-label=选择新建对话类型]")')
until('[...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("纯对话"))')
tap('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("纯对话"))')
until('document.body.innerText.includes("纯对话 · 已禁用全部工具")');assert not js('!!document.querySelector("[aria-label=选择本轮模式]")');passed('new pure chat draft hides all agent gears')
shot('01-new-chat')
cdp('Runtime.evaluate',{'expression':'document.querySelector("textarea").focus()'})
cdp('Input.insertText',{'text':'tool'})
cdp('Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13})
cdp('Input.dispatchKeyEvent',{'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13})
until('location.pathname.startsWith("/c/")');until('document.body.innerText.includes("本次没有向模型提供工具")');cdp('Page.reload')
until('document.body.innerText.includes("纯对话 · 已禁用全部工具")');assert not js('!!document.querySelector("[aria-label=选择本轮模式]")');passed('persisted pure chat stays tool-free and has no Agent switch')
report=json.loads((out/'api-smoke.json').read_text(encoding='utf-8'))
go('/c/'+report['conversation'])
until('document.body.innerText.includes("Chatbot") && document.body.innerText.includes("Agent")')
assert js('document.querySelectorAll("svg[aria-label=Agent]").length')>0
click('纯对话');until('document.querySelector("button[aria-pressed=true]")?.textContent.trim()==="纯对话"')
cdp('Page.reload');until('!!document.querySelector("textarea")');until('document.querySelector("button[aria-pressed=true]")?.textContent.trim()==="纯对话"');passed('mode switch persists through browser reload with mixed history')
textarea=js('(()=>{const e=document.querySelector("textarea");e.focus();return !!e})()');assert textarea
cdp('Input.insertText',{'text':'UI smoke message'})
cdp('Input.dispatchKeyEvent',{'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13})
cdp('Input.dispatchKeyEvent',{'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13})
until('document.body.innerText.includes("UI smoke message")')
until('document.querySelector("textarea").value===""')
time.sleep(.5);shot('02-mixed-conversation');passed('UI sends a message and renders the mixed conversation')
until('document.querySelector("button[aria-pressed=true]")?.textContent.trim()==="Agent"');passed('chat gear resets to Agent after sending one turn')
go('/settings?section=agent')
until('document.body.innerText.includes("网络失败重试")');shot('03-agent-settings');passed('Agent settings appear outside experiments')
assert not errors,errors
(out/'ui-qa.json').write_text(json.dumps({'checks':checks,'consoleErrors':errors},ensure_ascii=False,indent=2),encoding='utf-8')
w.close();print(len(checks),'UI checks passed')
