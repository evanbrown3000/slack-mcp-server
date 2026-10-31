/** Project-bound Slack deletion. Company is the sole project SOT.
 * This is an adapter over the native Slack channel owner, not a second SDK.
 * Archive is intentionally not an implementation of project deletion.
 */
import {executeNativeSlack} from './native-slack.mjs';
const object=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const str={type:'string'};
const common={
 request_id:{type:'string',pattern:'^[a-zA-Z0-9._:-]{1,150}$'},
 project_uuid:{type:['string','null'],maxLength:128},
 expected_slack_name:{type:'string',pattern:'^proj-[a-z0-9][a-z0-9_-]{0,74}$'},
 permanent:{type:'boolean'},
 external_ids:{type:'object',properties:{
  slack:{type:'object',properties:{
   id:{type:'string',pattern:'^[CG][A-Z0-9]{8,}$'},
   account_id:{type:'string',pattern:'^T[A-Z0-9]{8,}$'}
  },required:['id','account_id'],additionalProperties:false}
 },required:['slack'],additionalProperties:true},
 deletion_receipt:{type:'object'}
};
export const PROJECT_REMOVAL_CATALOG=[
 {name:'slack_project_delete',
  description:'Permanently remove the exact Company-bound Slack project channel, including if already archived; never archive as deletion.',
  inputSchema:object(common,['request_id','expected_slack_name','permanent','external_ids']),
  annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}},
 {name:'slack_project_verify_deleted',
  description:'Verify provider absence following one previously accepted Slack project deletion, without another write.',
  inputSchema:object(common,['request_id','external_ids','deletion_receipt']),
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}}
];
export const PROJECT_REMOVAL_NAMES=new Set(PROJECT_REMOVAL_CATALOG.map(t=>t.name));
const exact=s=>typeof s==='string'&&/^[a-zA-Z0-9._:-]{1,150}$/.test(s);
export async function executeProjectRemoval(name,args,api){
 if(!PROJECT_REMOVAL_NAMES.has(name))throw Error('unsupported_slack_project_removal');
 if(!args||!exact(args.request_id))throw Error('project_request_id_required');
 const identity=await executeNativeSlack('slack_identity',{},api);
 const binding=args.external_ids?.slack;
 if(!/^[CG][A-Z0-9]{8,}$/.test(binding?.id||'')||
    binding?.account_id!==identity.team_id)throw Error('company_slack_project_binding_mismatch');
 const channel=binding.id,base={provider:'slack',
  operation:name==='slack_project_delete'?'delete':'verify_delete',
  request_id:args.request_id,project_uuid:args.project_uuid||null,
  external_id:channel,account_id:identity.team_id,
  url:'https://app.slack.com/client/'+encodeURIComponent(identity.team_id)+'/'+encodeURIComponent(channel),
  automatic_retry:false,company_commit:false};
 let result;
 if(name==='slack_project_delete'){
  if(args.permanent!==true||!/^proj-[a-z0-9][a-z0-9_-]{0,74}$/.test(args.expected_slack_name||''))
    throw Error('exact_permanent_company_project_deletion_required');
  result=await executeNativeSlack('slack_channel_delete',{
   channel,workspace_id:identity.team_id,expected_name:args.expected_slack_name,
   request_id:args.request_id,permanent:true,confirmation:'DELETE '+channel},api);
 }else{
  const prior=args.deletion_receipt;
  if(prior?.native_acceptance!==true||prior?.mutation_attempted!==true||
     prior?.request_id!==args.request_id||prior?.account_id!==identity.team_id||
     prior?.external_id!==channel)
    throw Error('original_company_deletion_receipt_required');
  result=await executeNativeSlack('slack_channel_verify_deleted',{
   channel,workspace_id:identity.team_id,deletion_receipt:{
    native_acceptance:true,mutation_attempted:true,channel,account_id:identity.team_id}},api);
 }
 const verified=result?.verified===true&&result?.observed_state==='deleted';
 return {...base,ok:verified,verified,native_acceptance:result?.native_acceptance===true||
    name==='slack_project_verify_deleted',
    mutation_attempted:name==='slack_project_delete'?result?.mutation_attempted===true:true,
    permanent_deletion:verified,deletion_semantics:verified?'permanent':'unverified',
    name:args.expected_slack_name||null,observed_state:result?.observed_state||'unknown',
    observed_at:result?.observed_at||null,readback:result,
    reconcile_before_retry:result?.reconcile_before_retry===true};
}
