import test from 'node:test';
import assert from 'node:assert/strict';
import {NATIVE_CATALOG,executeNativeSlack} from '../deploy/cognilode/native/native-slack.mjs';
import {PROJECT_REMOVAL_CATALOG,executeProjectRemoval} from '../deploy/cognilode/native/project-removal.mjs';
import {SLACK_PROJECT_CATALOG} from '../deploy/cognilode/native/project-adapter.mjs';

const channel='C0C6RR0D66R',workspace='T0BNSD86MJ9';
const name='proj-agent-runtime-automation';
function fixture({archived=true,deleteOk=true,stillExists=false,existingName=name}={}){
 let deletionCalls=0,archiveCalls=0,deleted=false;
 return {
  auth:{test:async()=>({ok:true,team_id:workspace})},
  conversations:{
   info:async()=>deleted?{ok:false,error:'channel_not_found'}:
    {ok:true,channel:{id:channel,name:existingName,is_archived:archived,is_general:false}},
   archive:async()=>{archiveCalls++;return {ok:true}},
  },
  channelDelete:async()=>{
   deletionCalls++;
   if(!deleteOk)return {ok:false,error:'operation_not_allowed'};
   if(!stillExists)deleted=true;
   return {ok:true};
  },
  get counts(){return {delete:deletionCalls,archive:archiveCalls}}
 };
}
const project={
 request_id:'test-cleanup-001',project_uuid:'test-uuid',
 expected_slack_name:name,permanent:true,
 external_ids:{slack:{id:channel,account_id:workspace}}
};
test('native catalog exposes separate permanent delete and verification',()=>{
 const all=[...NATIVE_CATALOG,...PROJECT_REMOVAL_CATALOG,...SLACK_PROJECT_CATALOG];
 assert.equal(new Set(all.map(x=>x.name)).size,all.length);
 assert.ok(all.some(x=>x.name==='slack_channel_delete'&&x.annotations.destructiveHint));
 assert.ok(all.some(x=>x.name==='slack_channel_delete_archived'&&x.annotations.destructiveHint));
 assert.ok(all.some(x=>x.name==='slack_channel_verify_deleted'&&x.annotations.readOnlyHint));
 assert.ok(all.some(x=>x.name==='slack_project_delete'&&x.annotations.destructiveHint));
 assert.ok(all.some(x=>x.name==='slack_project_archive'));
 assert.ok(!all.some(x=>x.name==='slack_channel_delete_prepare'));
});
test('project deletion has exactly one native write and verified absence',async()=>{
 const api=fixture();
 const result=await executeProjectRemoval('slack_project_delete',project,api);
 assert.equal(result.verified,true);
 assert.equal(result.deletion_semantics,'permanent');
 assert.deepEqual(api.counts,{delete:1,archive:0});
 const verification=await executeProjectRemoval('slack_project_verify_deleted',
  {...project,deletion_receipt:result},api);
 assert.equal(verification.verified,true);
 assert.deepEqual(api.counts,{delete:1,archive:0});
});
test('provider rejection never archives or reports success',async()=>{
 const api=fixture({deleteOk:false});
 const result=await executeProjectRemoval('slack_project_delete',project,api);
 assert.equal(result.verified,false);
 assert.notEqual(result.observed_state,'deleted');
 assert.deepEqual(api.counts,{delete:1,archive:0});
});
test('an accepted mutation with a visible channel remains unverified',async()=>{
 const api=fixture({stillExists:true});
 const result=await executeProjectRemoval('slack_project_delete',project,api);
 assert.equal(result.verified,false);
 assert.equal(result.observed_state,'archived');
 assert.deepEqual(api.counts,{delete:1,archive:0});
});
test('exact project name, workspace and confirmation protect target identity',async()=>{
 const api=fixture({existingName:'different-project'});
 await assert.rejects(executeProjectRemoval('slack_project_delete',project,api),
  /never-match|identity|./);
 assert.deepEqual(api.counts,{delete:0,archive:0});
 await assert.rejects(executeNativeSlack('slack_channel_delete',{
  channel,workspace_id:workspace,expected_name:name,
  permanent:true,confirmation:'DELETE other',request_id:'x'},fixture()),/confirmation/);
});
