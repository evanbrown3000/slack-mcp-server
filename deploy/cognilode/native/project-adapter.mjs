/** Stateless native Slack Project adapter for the existing Company contract.
 * Company retains project identity, bindings and operation history. This module
 * performs one explicit provider operation and returns its actual observation.
 * Authentication and credential custody belong to the existing Worker wrapper.
 */
import {executeNativeSlack} from './native-slack.mjs';

const OPERATIONS=new Set(['read','create','rename','archive']);
const TOOL_OPERATIONS={slack_project_read:'read',slack_project_create:'create',slack_project_rename:'rename',slack_project_archive:'archive'};
function projectSchema(operation){
  const existing=operation!=='create';
  return {type:'object',properties:{
    request_id:{type:'string',pattern:'^[a-zA-Z0-9._:-]{1,150}$'},
    project_uuid:{type:['string','null'],maxLength:128},
    canonical_slug:{type:'string',pattern:'^[a-z0-9][a-z0-9_-]{0,74}$'},
    expected_slack_name:{type:'string',pattern:'^proj-[a-z0-9][a-z0-9_-]{0,74}$'},
    display_name:{type:'string'},is_private:{type:'boolean'},
    permanent:{type:'boolean',description:'Not a deletion request: project archive preserves channel and content.'},
    external_ids:{type:'object',properties:{slack:{type:'object',properties:{
      id:{type:'string',pattern:'^[CG][A-Z0-9]{8,}$'},
      account_id:{type:'string',pattern:'^T[A-Z0-9]{8,}$'}},
      required:existing?['id','account_id']:[],additionalProperties:false}},
      required:existing?['slack']:[],additionalProperties:true}
  },required:['request_id',...(existing?['external_ids']:[]),...(['create','rename'].includes(operation)?['canonical_slug','expected_slack_name']:[])],additionalProperties:false};
}
export const SLACK_PROJECT_CATALOG=Object.entries(TOOL_OPERATIONS).map(([name,operation])=>({
  name,description:{
    read:'Read an exact Company-bound Slack project channel and verify its actual workspace/account identity. Returns native observation; does not commit Company project state.',
    create:'Create the exact supplied proj-* channel and read back its identity and name. Company retains operation deduplication and project bindings; this adapter never retries.',
    rename:'Rename the exact Slack project channel bound to the observed account and verify its new proj-* name. Returns a provider receipt for Company to consume.',
    archive:'Archive the exact Slack project channel and verify its archived state. This preserves channel content and never claims permanent deletion or commits Company state.'
  }[operation],inputSchema:projectSchema(operation),annotations:{readOnlyHint:operation==='read',
    destructiveHint:['rename','archive'].includes(operation),idempotentHint:operation==='read',openWorldHint:true}
}));
export const SLACK_PROJECT_NAMES=new Set(Object.keys(TOOL_OPERATIONS));
const required=(value,field)=>{
  if(typeof value!=='string'||!value.trim())throw new Error('slack_project_'+field+'_required');
  return value;
};
function projectName(payload){
  const supplied=required(payload.expected_slack_name,'expected_slack_name');
  if(!/^proj-[a-z0-9][a-z0-9_-]{0,74}$/.test(supplied))throw new Error('slack_project_name_invalid');
  if(typeof payload.canonical_slug!=='string'||supplied!=='proj-'+payload.canonical_slug)throw new Error('slack_project_slug_name_mismatch');
  return supplied;
}
function projectBinding(payload,accountId){
  const binding=payload.external_ids?.slack;
  if(!binding||typeof binding!=='object')throw new Error('slack_project_binding_required');
  const id=required(binding.id,'external_id');
  if(!/^[CG][A-Z0-9]{8,}$/.test(id))throw new Error('slack_project_exact_channel_id_required');
  if(required(binding.account_id,'account_id')!==accountId)throw new Error('slack_project_account_binding_mismatch');
  return id;
}
function observation(payload,identity,externalId,readback,{operation,nativeAcceptance=false,expectedName=null}={}){
  const channel=readback?.channel||null;
  const identityMatches=!!externalId&&channel?.id===externalId;
  const state=channel?.is_archived===true?'archived':channel?.is_archived===false?'active':'unknown';
  const name=typeof channel?.name==='string'?channel.name:null;
  const valueMatches=expectedName===null||name===expectedName;
  const stateMatches=operation!=='archive'||state==='archived';
  const verified=readback?.verified===true&&identityMatches&&name!==null&&state!=='unknown'&&valueMatches&&stateMatches;
  return {
    ok:verified,provider:'slack',verified,operation,request_id:payload.request_id,
    project_uuid:payload.project_uuid||null,external_id:externalId||null,
    url:externalId?'https://app.slack.com/client/'+encodeURIComponent(identity.team_id)+'/'+encodeURIComponent(externalId):null,
    account_id:identity.team_id,name,observed_state:state,
    observed_at:channel?(readback.observed_at||null):null,
    native_acceptance:nativeAcceptance,readback,automatic_retry:false,company_commit:false,
    ...(operation==='archive'?{archive_semantics:'preserves_channel_and_content',permanent_deletion:false}:{}),
    ...(verified?{}:{code:'slack_project_readback_unverified',reconcile_before_retry:nativeAcceptance})
  };
}

export function slackProjectFailure(operation,payload,error,{identity=null,externalId=null,mutationAttempted=false}={}){
  return {ok:false,provider:'slack',verified:false,operation,
    request_id:typeof payload?.request_id==='string'?payload.request_id:null,
    project_uuid:typeof payload?.project_uuid==='string'?payload.project_uuid:null,
    external_id:externalId,url:externalId&&identity?.team_id?'https://app.slack.com/client/'+encodeURIComponent(identity.team_id)+'/'+encodeURIComponent(externalId):null,
    account_id:identity?.team_id||null,name:null,observed_state:'unknown',observed_at:null,
    native_acceptance:mutationAttempted?null:false,mutation_attempted:mutationAttempted,
    code:String(error?.message||error),reconcile_before_retry:mutationAttempted,
    automatic_retry:false,company_commit:false,
    ...(operation==='archive'?{archive_semantics:'preserves_channel_and_content',permanent_deletion:false}:{} )};
}

export function executeSlackProjectTool(name,args,api){
  if(!SLACK_PROJECT_NAMES.has(name))throw new Error('slack_project_tool_unknown');
  return executeSlackProjectAdapter(TOOL_OPERATIONS[name],args,api);
}

export async function executeSlackProjectAdapter(operation,payload,api){
  if(!OPERATIONS.has(operation))throw new Error('slack_project_operation_unknown');
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('slack_project_payload_required');
  const requestId=required(payload.request_id,'request_id');
  if(!/^[a-zA-Z0-9._:-]{1,150}$/.test(requestId))throw new Error('slack_project_request_id_invalid');
  // auth.test establishes the actual workspace for the selected credential.
  // It does not infer a binding from a channel name or use an account default.
  let identity=null,externalId=null,mutationAttempted=false;
  try{
    identity=await executeNativeSlack('slack_identity',{},api);
    if(operation==='create'){
      const expectedName=projectName(payload),existing=payload.external_ids?.slack;
      if(existing?.id)throw new Error('slack_project_create_with_existing_binding');
      if(existing?.account_id&&existing.account_id!==identity.team_id)throw new Error('slack_project_account_binding_mismatch');
      mutationAttempted=true;
      const mutation=await executeNativeSlack('slack_channel_create',{name:expectedName,is_private:payload.is_private===true},api);
      return observation(payload,identity,mutation.channel?.id||null,mutation.readback,
        {operation,nativeAcceptance:mutation.native_acceptance===true,expectedName});
    }
    externalId=projectBinding(payload,identity.team_id);
    if(operation==='read'){
      const read=await executeNativeSlack('slack_channel_info',{channel:externalId},api);
      return observation(payload,identity,externalId,{verified:read.channel?.id===externalId,
        channel:read.channel||null,observed_at:new Date().toISOString(),readback_error:read.channel?.id===externalId?null:'channel_identity_mismatch'},
        {operation});
    }
    const expectedName=operation==='rename'?projectName(payload):null;
    mutationAttempted=true;
    const mutation=operation==='rename'
      ?await executeNativeSlack('slack_channel_rename',{channel:externalId,name:expectedName},api)
      :await executeNativeSlack('slack_channel_archive',{channel:externalId},api);
    return observation(payload,identity,externalId,mutation.readback,
      {operation,nativeAcceptance:mutation.native_acceptance===true,expectedName});
  }catch(error){
    // Resolve already-archived status with an exact read, never another write.
    if(operation==='archive'&&String(error.message||error)==='slack_channel_archive:already_archived'){
      const read=await executeNativeSlack('slack_channel_info',{channel:externalId},api).catch(()=>null);
      if(read)return {...observation(payload,identity,externalId,{verified:read.channel?.id===externalId,
        channel:read.channel||null,observed_at:new Date().toISOString()},{operation}),native_mutation:'already_archived'};
    }
    return slackProjectFailure(operation,payload,error,{identity,externalId,mutationAttempted});
  }
}
