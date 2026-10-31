/** Slack-domain permanent channel deletion. Company retains the project SOT.
 * A normal archive is never counted as deletion. A single provider mutation
 * is followed by a separate native read; ambiguous outcomes are not retried.
 */
const id=x=>typeof x==='string'&&/^[CG][A-Z0-9]{8,}$/.test(x);
const workspace=x=>typeof x==='string'&&/^T[A-Z0-9]{8,}$/.test(x);
async function owner(api){
 const r=await api.auth.test({});
 if(r?.ok!==true||!workspace(r.team_id))throw Error('slack_account_unobserved');
 return r.team_id;
}
async function present(api,channel){
 const r=await api.conversations.info({channel});
 if(r?.ok===true){
  if(r.channel?.id!==channel)throw Error('slack_channel_readback_identity_changed');
  return {exists:true,channel:r.channel};
 }
 if(r?.error==='channel_not_found'||r?.error==='channel_deleted')
   return {exists:false,reason:r.error};
 throw Error('slack_channel_readback_failed:'+String(r?.error||'unavailable'));
}
export async function removeSlackChannel(args,api){
 const channel=args?.channel;
 if(!id(channel))throw Error('exact_slack_channel_id_required');
 if(args.permanent!==true||args.confirmation!=='DELETE '+channel)
   throw Error('permanent_slack_deletion_confirmation_required');
 if(typeof args.request_id!=='string'||!args.request_id.trim())
   throw Error('slack_deletion_request_id_required');
 const account=await owner(api);
 if(args.workspace_id!==account)throw Error('slack_workspace_binding_mismatch');
 const before=await present(api,channel);
 if(!before.exists)throw Error('slack_channel_absent_before_mutation');
 if(before.channel.is_general===true||before.channel.name==='general')
   throw Error('slack_general_channel_protected');
 if(before.channel.name!==args.expected_name)
   throw Error('slack_channel_name_changed_before_deletion');
 if(args.archived_only===true&&before.channel.is_archived!==true)
   throw Error('slack_channel_not_archived');
 if(typeof api.channelDelete!=='function')
   throw Error('slack_permanent_delete_provider_unavailable');
 // Exactly one programmatic write through the original authenticated Slack
 // account. An API failure is not an invitation to archive as a substitute.
 const native=await api.channelDelete({channel});
 if(native?.ok!==true)
   return {ok:false,verified:false,mutation_attempted:true,
      native_acceptance:false,account_id:account,channel,request_id:args.request_id,
      error:String(native?.error||'permanent_delete_rejected'),automatic_retry:false};
 let after;
 try{after=await present(api,channel)}
 catch(e){return {ok:false,verified:false,native_acceptance:true,
   mutation_attempted:true,account_id:account,channel,request_id:args.request_id,
   observed_state:'unknown',reconcile_before_retry:true,automatic_retry:false,
   error:'slack_channel_delete_readback_unavailable'};}
 const verified=!after.exists;
 return {ok:verified,verified,native_acceptance:true,mutation_attempted:true,
   permanent_deletion:verified,deletion_semantics:verified?'permanent':null,
   account_id:account,channel,request_id:args.request_id,
   observed_state:verified?'deleted':(after.channel.is_archived?'archived':'active'),
   prior_name:before.channel.name,prior_archived:before.channel.is_archived===true,
   observed_at:new Date().toISOString(),automatic_retry:false,
   reconcile_before_retry:!verified};
}
export async function verifySlackChannelRemoved(args,api){
 const channel=args?.channel,prior=args?.deletion_receipt;
 if(!id(channel))throw Error('exact_slack_channel_id_required');
 const account=await owner(api);
 if(args.workspace_id!==account)throw Error('slack_workspace_binding_mismatch');
 if(prior?.native_acceptance!==true||prior.channel!==channel||
    prior.account_id!==account||prior.mutation_attempted!==true)
   throw Error('accepted_slack_delete_receipt_required');
 const after=await present(api,channel),verified=!after.exists;
 return {ok:verified,verified,account_id:account,channel,
  observed_state:verified?'deleted':(after.channel.is_archived?'archived':'active'),
  permanent_deletion:verified,deletion_semantics:verified?'permanent':null,
  observed_at:new Date().toISOString(),automatic_retry:false,
  reconcile_before_retry:!verified};
}
