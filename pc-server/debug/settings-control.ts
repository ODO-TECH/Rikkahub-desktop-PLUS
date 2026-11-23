import type {Settings} from "../foundation/types/settings";

const MASK="[REDACTED]";
const secret=(key:string)=>/api.?key|password|secret|authorization|credential|access.?token|refresh.?token|^token$|private.?key|jwt/i.test(key);
export function redactDebug(value:unknown):any {
  if(Array.isArray(value))return value.map(redactDebug);
  if(value && typeof value === "object") {
    const object=value as Record<string,unknown>;
    const headerSecret=typeof object.key === "string" && secret(object.key);
    return Object.fromEntries(Object.entries(object).map(([key,v])=>[key,(secret(key) || (headerSecret && key === "value")) && v && typeof v!=="boolean" && typeof v!=="number" ? MASK : redactDebug(v)]));
  }
  return value;
}

/** A masked round trip preserves secrets; arrays remain explicit replacements. */
function merge(current:any,patch:any):any {
  if(patch===MASK)return current;
  if(Array.isArray(patch))return patch.map((v,i)=>merge(Array.isArray(current)?(v?.id?current.find((x:any)=>x?.id===v.id):current[i]):undefined,v));
  if(patch && typeof patch === "object") {
    const next={...current};
    for(const [key,value] of Object.entries(patch)) {
      if(["__proto__","constructor","prototype"].includes(key))throw new Error("Invalid setting key");
      next[key]=merge(current?.[key],value);
    }
    return next;
  }
  if(current!==undefined && current!==null && patch!==null && typeof current!==typeof patch)throw new Error("Setting value has an incompatible type");
  return patch;
}
export function patchDebugSettings(current:Settings,patch:unknown):Settings {
  if(!patch || typeof patch!=="object" || Array.isArray(patch))throw new Error("Expected a settings object");
  for(const key of Object.keys(patch))if(!(key in current))throw new Error(`Unknown setting: ${key}`);
  return merge(current,patch);
}
