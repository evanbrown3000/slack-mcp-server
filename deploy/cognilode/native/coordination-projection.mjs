// Read adapter over the ORIGINAL Coordination window and its declared Slack
// actions. Writes and receipt storage remain wholly in that existing owner.
import {publicSlackPage,coordinationSnapshot,coordinationFileControls} from './coordination-public-model.mjs';

const GENERAL='C0C6GEJCZ39';
const safeError=error=>/^[a-z][a-z0-9_]{0,100}$/.test(error?.code||error?.message||'')?error.code||error.message:'slack_source_unavailable';
export function createCoordinationWindow({WindowError,renderText,readPublicDomainJSON,definition:configuredDefinition}){
async function originalRead(binding,authorization,name,args){
 return readPublicDomainJSON(await binding.fetch(new Request('https://coordination.internal/operator/coordination/window',{
  method:'POST',headers:{authorization,'content-type':'application/json'},redirect:'manual',signal:AbortSignal.timeout(25000),
  body:JSON.stringify({name,arguments:args})})));
}
return async function coordinationWindow(binding,authorization,args={}){
 if(!['open','pull',undefined].includes(args.operation))throw new WindowError('use_declared_slack_read_actions',400);
 if(!binding?.fetch)throw new WindowError('coordination_owner_unavailable',503);
 const original=await originalRead(binding,authorization,'operator_window',args);
 if(typeof original.layout_revision!=='string'||!Array.isArray(original.actions))throw new WindowError('coordination_catalog_invalid',502);
 if(original.public_page?.schema==='cognilode.coordination.public-page.v1')return original;
 const definition=original.definition||configuredDefinition||{};
 const channel=args.filters?.channel_id||definition.default_channel||GENERAL;
 const pageSizes=definition.page_sizes||{history:25,thread:100,search:50};
 const revision=original.layout_revision,actions=original.actions;
 const read=actions.find(action=>action.id==='slack.slack_history');
 let page=null,error=null;
 try{
  if(!read||!read.inputSchema?.properties?.channel)throw new WindowError('slack_history_not_declared',503);
  const receipt=await originalRead(binding,authorization,'operator_action',{
   window_id:'coordination',layout_revision:revision,action_id:read.id,
   arguments:{channel,limit:pageSizes.history},request_id:crypto.randomUUID()});
  page=publicSlackPage(receipt.result,{kind:'history',channel,page_sizes:pageSizes});
 }catch(problem){error=safeError(problem);}
 const controls=[];
 const control=(title,action_id,arguments_)=>({title,tool:'operator_action',required_arguments:['request_id'],arguments:{window_id:'coordination',layout_revision:revision,action_id,arguments:arguments_}});
 if(read)controls.push(control('Refresh channel','slack.slack_history',{channel,limit:pageSizes.history}));
 if(page?.page.next_cursor)controls.push(control('Older messages','slack.slack_history',{channel:page.channel,limit:pageSizes.history,cursor:page.page.next_cursor}));
 if(page&&actions.some(action=>action.id==='slack.slack_replies'))for(const message of page.messages){
  if(message.reply_count&&message.ts)controls.push(control('Read '+message.reply_count+' thread replies','slack.slack_replies',{channel:message.channel_id,ts:message.thread_ts||message.ts,limit:pageSizes.thread}));
 }
 controls.push(...coordinationFileControls(page,actions,revision));
 const snapshot=coordinationSnapshot(page,actions,revision,error,definition);
 return {...original,schema:'cognilode.operator.window-response.v1',snapshot,public_page:page,read_controls:controls,
  observed_at:page?.observed_at||new Date().toISOString(),mode:'full',source_complete:!error,
  errors:error?[{source:'slack',error}]:[],source:{owner:'existing Coordination Slack capability',operation:'slack_history',channel,
   available:!!page,coverage:'One original bounded channel page; thread bodies require the declared replies action.',limit:pageSizes.history},
  rendered:renderText(snapshot)+'\n\nDeclared Slack read controls (supply a unique request_id):\n'+JSON.stringify(controls)+'\n\n'+original.rendered};
};
}
