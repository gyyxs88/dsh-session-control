import fs from'node:fs';import{pathToFileURL}from'node:url';import assert from'node:assert/strict';
export async function verify022(ctx,agent,root,profile){
 const cases=[],load=p=>import('@deepseek-ai/'+p),signal=AbortSignal.timeout(20000);
 const own=profile+'/node_modules/dsh-session-control';
 const {makeApi}=await import(pathToFileURL(own+'/lib/index.js'));
 const {OperationStore}=await import(pathToFileURL(own+'/lib/state-store.js'));
 const store=await new OperationStore({stateDir:root+'/evidence/host-contract/operations-'+Date.now(),maxOperations:100}).load();
 const lifecycle={ownedHandles:new Map(),permissionReleases:new Map()};
 const config={sameWorkspaceOnly:false,maxPendingPerTarget:3,maxPendingPerSource:10,rateLimitPerMinute:5};
 const api=makeApi(ctx,config,store,undefined,lifecycle),exec={agent,signal};
 const {Session}=await load('dsh-session');
 const coldId='session-cold-contract-'+Date.now();const cold=Session.create(coldId,undefined,{...Session.create(coldId).header,cwd:root});
 // Session header ID must match the durable Session identity.
 const writer=await ctx.sessionPersistence.create(cold.header);await writer.flush();await writer.close();
 try{
  const createArgs={target_id:cold.id,prompt:'Synthetic future reminder only',after_seconds:3600,idempotency_key:'host-create-0001'};
  const made=await api.createSchedule(createArgs,exec);assert.equal(made.ok,true,JSON.stringify(made));
  const again=await api.createSchedule(createArgs,exec);assert.equal(again.duplicate,true);assert.equal(again.schedule.id,made.schedule.id);
  assert.equal(ctx.agents.get(cold.id),undefined);const listed=await api.listSchedules({target_id:cold.id},exec);assert.equal(listed.count,1);assert.equal(listed.schedules[0].prompt,undefined);assert.ok(listed.schedules[0].prompt_sha256);cases.push('Host Schedule create/list/idempotence on cold target, no Agent activation, default prompt redaction');
  const deleted=await api.deleteSchedule({target_id:cold.id,schedule_id:made.schedule.id,idempotency_key:'host-delete-0001'},exec);assert.equal(deleted.ok,true);assert.equal(deleted.result.deleted,true);assert.equal((await api.listSchedules({target_id:cold.id},exec)).count,0);cases.push('Host Schedule edit delete and original operation receipt complete');
  // Fault injection at the real public service seam uses its actual StorageError class.
  const {StorageError}=await load('dsh-storage');let writes=0;
  const fakeCtx={agents:ctx.agents,sessions:ctx.sessions,sessionPersistence:ctx.sessionPersistence,permissionPresets:ctx.permissionPresets,llm:ctx.llm,logger:ctx.logger,
   schedule:{view:async()=>({id:'uncertain-target',target:{kind:'session',sessionId:cold.id}}),create:async()=>{writes++;throw new StorageError('unknown-state','synthetic uncertain commit');},edit:async()=>{writes++;throw new StorageError('unknown-state','synthetic uncertain commit');}}};
  const faulty=makeApi(fakeCtx,config,store,undefined,{ownedHandles:new Map(),permissionReleases:new Map()});
  for(const action of ['create','delete']){
   const args=action==='create'?{...createArgs,idempotency_key:'uncertain-create-0001'}:{target_id:cold.id,schedule_id:'uncertain-target',idempotency_key:'uncertain-delete-0001'};
   const method=action==='create'?'createSchedule':'deleteSchedule';const first=await faulty[method](args,exec);assert.equal(first.uncertain,true);assert.equal(first.operation.status,'delivery-unknown');const count=writes;
   const repeat=await faulty[method](args,exec);assert.equal(repeat.duplicate,true);assert.equal(repeat.operation.status,'delivery-unknown');assert.equal(writes,count);assert.equal(repeat.ok,false);
  }cases.push('actual StorageError unknown-state creates delivery-unknown for create/delete; original idempotency key never repeats a write');
  fakeCtx.schedule.edit=async()=>({code:'schedule_conflict'});const conflict=await faulty.deleteSchedule({target_id:cold.id,schedule_id:'uncertain-target',idempotency_key:'conflict-delete-0001'},exec);assert.equal(conflict.ok,false);assert.equal(conflict.operation.status,'failed');cases.push('official definitive conflict remains failed; uncertainty is not inferred from diagnostic prose');
  const created=await api.openSession({mode:'create',idempotency_key:'lifecycle-create-0001',provider:'fixture',model:'fixture-model'},exec);assert.equal(created.ok,true,JSON.stringify(created));
  assert.deepEqual(ctx.agents.get(created.session_id).model.current(),{provider:'fixture',model:'fixture-model'});
  await lifecycle.ownedHandles.get(created.session_id).dispose();lifecycle.ownedHandles.delete(created.session_id);
  const resumed=await api.openSession({mode:'resume',resume_session_id:created.session_id,idempotency_key:'lifecycle-resume-0001',provider:'fixture',model:'fixture-model'},exec);assert.equal(resumed.ok,true,JSON.stringify(resumed));
  assert.equal(ctx.agents.get(created.session_id).model.current().model,'fixture-model');cases.push('ordinary lifecycle create/resume use actual Agent model selection before step preparation');
  assert.equal(ctx.tools.get('subagent_code',agent),undefined,'released bundle deliberately keeps tool layer opt-in');
  const codeTools=await import(pathToFileURL(profile+'/node_modules/dsh-subagent-code-agents/packages/plugin/lib/tool.js'));
  const disposeCodeTools=agent.ctx.effect(()=>codeTools.apply(agent.ctx,{enableRunInBackground:false},{subagents:ctx.subagents,agents:ctx.agents,sessions:ctx.sessions,permissionPresets:ctx.permissionPresets,ownerAgent:agent}));
  const selection=agent.model.current(),set=await ctx.tools.resolve({agent,modelSelection:selection,signal});
  assert.ok(ctx.tools.executable('session_workspace_list',agent,set));assert.ok(ctx.tools.executable('render_ui',agent,set));assert.ok(ctx.tools.executable('subagent_code',agent,set));assert.equal(ctx.tools.get('subagent_oar',agent),undefined);
  const conditional=agent.ctx.tools.register({name:'candidate_conditional',parameters:{type:'object',properties:{}},output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>({ok:true})},{when:()=>false});
  assert.ok(ctx.tools.get('candidate_conditional',agent));assert.equal(ctx.tools.executable('candidate_conditional',agent),undefined);
  const admitted=await ctx.tools.resolve({agent,modelSelection:selection,signal});assert.equal(ctx.tools.executable('candidate_conditional',agent,admitted),undefined);admitted.dispose();await conditional();cases.push('tools.resolve/executable excludes conditional tool; GenUI/session/codeagents admitted; official subagent_oar absent');
  const {NativeToolExecutor}=await load('dsh-tool-executor-native');const {PtcExecutor}=await load('dsh-tool-executor-ptc');
  const definitions=ctx.tools.definitions(agent,set),native=new NativeToolExecutor(agent.ctx),ptc=new PtcExecutor(agent.ctx);
  assert.ok(native.describe(definitions).schemas.some(s=>s.name==='session_workspace_list'));assert.deepEqual(ptc.describe(definitions).schemas.map(s=>s.name),['run_code']);assert.match(ptc.renderSdk(definitions),/session_workspace_list/);
  const assembly=await ctx.systemPrompt.assemble({scope:agent,modelSelection:selection,toolSet:set,signal});assert.ok(assembly);set.dispose();await disposeCodeTools();cases.push('native capability schemas, PTC run_code-only transport and SDK agree with scoped prompt assembly; codeagents tool layer remains opt-in; no program executed');
  const before=await ctx.sessionController.projections({sessionId:agent.id},signal);assert.ok(before.values.tpsCorrectionV2);const stop=new AbortController();const stream=ctx.sessionController.observeProjections({sessionId:agent.id},stop.signal);
  assert.equal((await stream.next()).value.type,'ready');const next=stream.next();ctx.permissionPresets.set(agent.session,'workspace-write');const frame=(await next).value;assert.ok(frame);const after=await ctx.sessionController.projections({sessionId:agent.id},signal);assert.ok(after.asOfSeq>before.asOfSeq);stop.abort();await stream.return();ctx.permissionPresets.set(agent.session,'danger-full-access');cases.push('independent Projection snapshot/subscribe ready then change, monotonic cursor, awaited TPS registration');
  return {status:'PASSED',cases,realOfficialHost:true,providerCalls:0,externalExecutions:0};
 }finally{for(const h of lifecycle.ownedHandles.values())await h.dispose();await store.dispose();}
}
