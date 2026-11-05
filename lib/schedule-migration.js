import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {decodeScheduleRecord,resolveEveryOccurrence,scheduleDomain} from '@deepseek-ai/dsh-schedule';

// Offline bridge for the released rc.5 Session-owned schedule/change format.
// The new official Host does not import those events. Retain IDs and exact
// records through its public domain schema, before the Schedule runtime starts.
export function legacySchedules(events,inherited=0){
 assert.ok(Number.isSafeInteger(inherited)&&inherited>=0&&inherited<=events.length);
 const active=new Map(),seen=new Set();
 for(const e of events.slice(inherited)){
  if(e.type!=='schedule/change')continue;
  const c=e.data;assert.equal(c.version,1,'unsupported legacy schedule version');
  if(c.operation==='create'){
   const record=decodeScheduleRecord(c.schedule);
   assert.ok(!seen.has(record.id),'reused legacy schedule ID');seen.add(record.id);active.set(record.id,record);
  }else if(c.operation==='delete'){
   assert.ok(active.delete(c.id),'legacy delete references inactive schedule');
  }else if(c.operation==='dispatch'){
   const record=active.get(c.id);assert.ok(record,'legacy dispatch references inactive schedule');
   if(record.kind==='every'){
    assert.equal(typeof c.acceptedAt,'string');
    const occurrence=resolveEveryOccurrence(record,Date.parse(c.acceptedAt));
    if(occurrence.nextScheduledAt===undefined)active.delete(c.id);
    else active.set(c.id,{...record,scheduledAt:occurrence.nextScheduledAt});
   }else active.delete(c.id);
  }else throw Error('unsupported legacy schedule operation');
 }
 return {active,seen};
}
export async function planScheduleMigration(persistence,domain,operations=[]){
 const tasks=domain.table('tasks'),rows=await persistence.list({}),sources=new Map(),legacy=new Map(),seen=new Set(),historicalReads=[];
 for(const op of operations)if(op.kind==='schedule'&&op.action==='create'&&op.scheduleId){const ids=sources.get(op.scheduleId)??new Set();ids.add(op.sourceId);sources.set(op.scheduleId,ids);}
 for(const row of rows){
  const id=row.id??row.meta?.id??row.header?.id;assert.equal(typeof id,'string');
  const handle=await persistence.open(id,'read');
  try{
   const history=await handle.read(),fold=legacySchedules(history.events,handle.inheritedEventCount);
   if(row.formatStatus==='migration-required')historicalReads.push({sessionId:id,formatStatus:row.formatStatus,readMode:'official-open-read-in-memory',logicalEvents:history.events.length,inheritedEventCount:handle.inheritedEventCount,logicalScheduleChanges:history.events.filter(e=>e.type==='schedule/change').length});
   for(const key of fold.seen)seen.add(key);
   for(const [key,record]of fold.active){
    assert.ok(!legacy.has(key),'same legacy schedule ID appears in multiple owning Sessions');
    assert.match(key,/^[a-zA-Z0-9_-]+$/);
    const task=scheduleDomain.tables.tasks.valueSchema.parse({record,target:{kind:'session',sessionId:id},involvedSessionIds:[...new Set([id,...sources.get(key)??[]])],status:'active'});
    legacy.set(key,task);
   }
  }finally{await handle.close();}
 }
 const additions=[],aligned=[],completed=[],unresolved=[];
 for(const [id,task]of legacy){
  const existing=tasks.get(id);
  if(existing===undefined)additions.push({id,task});
  else{
   const base=({scheduledAt,...rest})=>rest;
   if(!isDeepStrictEqual(existing.target,task.target)||!isDeepStrictEqual(base(existing.record),base(task.record)))throw Error('Legacy/Host Schedule ID conflict: '+id);
   aligned.push(id);
  }
 }
 for(const op of operations){
  if(op.kind!=='schedule'||op.action!=='create'||['completed','failed','aborted'].includes(op.status))continue;
  if(op.scheduleId&& (legacy.has(op.scheduleId)||tasks.get(op.scheduleId)))continue;
  if(op.scheduleId&&seen.has(op.scheduleId))completed.push(op.id);
  else unresolved.push(op.id);
 }
 return {additions,aligned,completed,unresolved,historicalReads,sessions:rows.length,legacyActive:legacy.size};
}
export async function applyScheduleMigration(plan,domain,store){
 assert.equal(plan.unresolved.length,0,'Unresolved legacy operations require reconciliation; no migration writes made');
 for(const {id,task}of plan.additions)await domain.table('tasks').put(id,task);
 for(const id of plan.completed)await store?.update(id,{status:'completed',reason:'legacy-schedule-already-consumed',attention:null});
 return {migrated:plan.additions.map(r=>r.id),aligned:plan.aligned,completed:plan.completed};
}
