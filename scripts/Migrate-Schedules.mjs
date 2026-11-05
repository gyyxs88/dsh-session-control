import fs from'node:fs';import path from'node:path';import{createRequire,registerHooks}from'node:module';import{pathToFileURL,fileURLToPath}from'node:url';
// Run with the verified Electron EXE, ELECTRON_RUN_AS_NODE=1, while Desktop is
// stopped and a complete cold backup exists. Defaults to a read-only plan.
// Arguments: ASAR sessionsRoot storageJsonRoot sessionControlStateDir outputJson [--apply]
const [archive,sessionsRoot,storageRoot,stateDir,output,...flags]=process.argv.slice(2),mode=flags.includes('--apply')?'--apply':undefined;
if(![archive,sessionsRoot,storageRoot,stateDir,output].every(v=>typeof v==='string'&&path.isAbsolute(v))||flags.some(v=>!['--apply','--compression=none','--compression=zstd'].includes(v)))throw Error('Explicit absolute ASAR, sessions, storage backend, operation store and report paths required');
const compression=flags.includes('--compression=none')?'none':'zstd';
const req=createRequire(archive+'/dsh/node_modules/@deepseek-ai/dsh/package.json');let resolving=false;
registerHooks({resolve(s,c,next){if(!resolving&&(s.startsWith('@deepseek-ai/')||s==='zod')){let t;resolving=true;try{t=req.resolve(s)}finally{resolving=false}return next(c.conditions.includes('require')?t:pathToFileURL(t).href,c)}return next(s,c)}});
const root=path.dirname(fileURLToPath(import.meta.url));
const load=async n=>import(pathToFileURL(req.resolve('@deepseek-ai/'+n)));
const {Context}=await load('cordis'),{Storage}=await load('dsh-storage'),json=await load('dsh-storage-json'),domainPlugin=await load('dsh-storage-domain'),persistence=await load('dsh-session-persistence-jsonl'),{scheduleDomain}=await load('dsh-schedule');
const migrationFile=fs.existsSync(root+'/schedule-migration.mjs')?root+'/schedule-migration.mjs':root+'/../lib/schedule-migration.js';
const {planScheduleMigration,applyScheduleMigration}=await import(pathToFileURL(migrationFile));
const storeFile=[root+'/build-inputs/packages/dsh-session-control/lib/state-store.js',root+'/adapted/node_modules/dsh-session-control/lib/state-store.js',root+'/../lib/state-store.js'].find(p=>fs.existsSync(p));
const {OperationStore}=await import(pathToFileURL(storeFile));
const ctx=new Context(),report={status:'RUNNING',mode:mode==='--apply'?'apply':'plan',providerCalls:0};let store;
try{
 await ctx.plugin(Storage);await ctx.plugin(json,{root:storageRoot});await ctx.plugin(domainPlugin,{backend:'json',routes:{}});await ctx.plugin(persistence,{root:sessionsRoot,compression});
 store=await new OperationStore({stateDir,maxOperations:100000}).load();
 const domain=await ctx.storageDomain.open(scheduleDomain);const plan=await planScheduleMigration(ctx.sessionPersistence,domain,store.list());
 Object.assign(report,{sessions:plan.sessions,legacyActive:plan.legacyActive,historicalReads:plan.historicalReads,additions:plan.additions.map(r=>({id:r.id,targetSessionId:r.task.target.sessionId,scheduledAt:r.task.record.scheduledAt,kind:r.task.record.kind})),aligned:plan.aligned,completed:plan.completed,unresolved:plan.unresolved});
 if(mode==='--apply')report.applied=await applyScheduleMigration(plan,domain,store);
 report.status=plan.unresolved.length?'NEEDS_RECONCILIATION':mode==='--apply'?'MIGRATED':'PLAN_READY';await domain.close();
}catch(error){report.status='FAILED';report.error=String(error);process.exitCode=1;}finally{await store?.dispose();await ctx.fiber.dispose();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
