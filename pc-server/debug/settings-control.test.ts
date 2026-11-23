import {expect,test} from "bun:test";
import {defaultSettings} from "../app-config/defaults";
import {patchDebugSettings,redactDebug} from "./settings-control";
test("settings edits preserve masked credentials, merge nested values, and reject prototype keys",()=>{
  const settings=defaultSettings();settings.providers[0].apiKey="temporary-test-secret";
  const masked=redactDebug(settings);expect(JSON.stringify(masked)).not.toContain("temporary-test-secret");
  const copy=patchDebugSettings(settings,masked);expect(copy.providers[0].apiKey).toBe("temporary-test-secret");
  const next=patchDebugSettings(settings,{agentLoop:{transportRetry:false}});
  expect(next.agentLoop?.transportRetry).toBe(false);expect(next.agentLoop?.maxReplans).toBe(settings.agentLoop?.maxReplans);
  expect(()=>patchDebugSettings(settings,JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
  expect(()=>patchDebugSettings(settings,{launchAtStartup:"true"})).toThrow();
});
