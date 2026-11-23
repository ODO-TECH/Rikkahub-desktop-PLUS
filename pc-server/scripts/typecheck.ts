import { join } from "node:path";
const proc=Bun.spawnSync([process.execPath,"run",join(import.meta.dir,"../node_modules/typescript/bin/tsc"),"--noEmit","--pretty","false"],{cwd:join(import.meta.dir,".."),stdout:"inherit",stderr:"inherit"});
process.exit(proc.exitCode);
