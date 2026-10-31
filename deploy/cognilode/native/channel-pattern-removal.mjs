/** Slack-domain reusable channel pattern cleanup.
 * Company-bound proj-* channels remain owned by canonical Project SOT.
 * This module consumes only the incumbent authorized Slack client.
 */
import {removeSlackChannel} from './channel-removal.mjs';
const channel=x=>typeof x==='string'&&/^[CG][A-Z0-9]{8,}$/.test(x);
const workspace=x=>typeof x==='string'&&/^T[A-Z0-9]{8,}$/.test(x);
const digest=async value=>{
 const raw=new TextEncoder().encode(JSON.stringify(value));
 const hashed=await crypto.subtle.digest('SHA-256',raw);
 return [...new Uint8Array(hashed)].map(x=>x.toString(16).padStart(2,'0')).join('');
};
const globRegExp=value=>new RegExp('^'+[...value].map(ch=>ch==='*'?'.*':ch==='?'?'.':'.+()[]{}^$|\\'.includes(ch)?'\\'+ch:ch).join('')+'$');
export async function planChannelRemoval(args,api){
 if(!workspace(args?.workspace_id)||typeof args.pattern!=='string'||!args.pattern||args.pattern.length>250)
   throw Error('bounded_slack_channel_pattern_required');
 if(!['glob','regex'].includes(args.mode))throw Error('slack_channel_pattern_mode_required');
 if(args.include_active!==true&&args.include_active!==false)
   throw Error('explicit_active_channel_selection_required');
 const own=await api.auth.test({});
 if(own?.ok!==true||own.team_id!==args.workspace_id)
   throw Error('slack_channel_pattern_workspace_changed');
 let matcher;
 try{matcher=args.mode==='regex'?new RegExp(args.pattern):globRegExp(args.pattern)}
 catch{throw Error('invalid_slack_channel_pattern')}
 let cursor,seen=new Set(),items=[],scanned=0;
 do{
  const r=await api.conversations.list({types:'public_channel,private_channel',
   exclude_archived:false,limit:200,...(cursor?{cursor}:{})});
  if(r?.ok!==true||!Array.isArray(r.channels))
   throw Error('slack_channel_pattern_catalogue_unavailable');
  for(const c of r.channels){
   if(!channel(c.id)||typeof c.name!=='string'||typeof c.is_archived!=='boolean')
    throw Error('slack_channel_pattern_incomplete_identity');
   if(seen.has(c.id))throw Error('duplicate_slack_channel_identity');
   seen.add(c.id);scanned++;
   if(scanned>10000)throw Error('slack_channel_pattern_inventory_exceeds_limit');
   if(c.is_general===true||c.name==='general'||c.name.startsWith('proj-'))continue;
   if(!args.include_active&&!c.is_archived)continue;
   if(matcher.test(c.name))items.push({id:c.id,name:c.name,is_archived:c.is_archived});
  }
  const next=r.response_metadata?.next_cursor||null;
  if(next===cursor&&next)throw Error('slack_channel_cursor_repeated');
  cursor=next;
 }while(cursor);
 items.sort((a,b)=>a.id.localeCompare(b.id));
 if(items.length>100)throw Error('slack_channel_selection_exceeds_limit');
 const selection={schema:'cognilode.slack.channel-pattern.v1',workspace_id:own.team_id,
  pattern:args.pattern,mode:args.mode,include_active:args.include_active,
  scanned,items};
 return {...selection,selection_sha256:await digest(selection)};
}
export async function applyChannelRemoval(args,api){
 const selection=args?.selection;
 if(!selection||typeof selection!=='object'||selection.schema!=='cognilode.slack.channel-pattern.v1')
   throw Error('native_slack_channel_selection_required');
 const {selection_sha256:sha,...original}=selection;
 if(typeof sha!=='string'||!(/^[a-f0-9]{64}$/.test(sha))||await digest(original)!==sha||
    args.confirmation!=='DELETE '+sha)
   throw Error('explicit_selected_channel_delete_confirmation_required');
 if(typeof args.request_id!=='string'||!args.request_id)
   throw Error('deletion_request_id_required');
 const actual=await planChannelRemoval(selection,api);
 if(JSON.stringify(actual)!==JSON.stringify(selection))
   throw Error('native_slack_channel_inventory_changed_before_delete');
 const receipts=[];
 for(const item of selection.items){
  const result=await removeSlackChannel({channel:item.id,workspace_id:selection.workspace_id,
   expected_name:item.name,permanent:true,
   confirmation:'DELETE '+item.id,
   request_id:args.request_id+':'+item.id},api);
  receipts.push(result);
  if(result.verified!==true)return {ok:false,partial:true,deleted:receipts.filter(x=>x.verified).length,
    receipts,reconcile_before_retry:true,automatic_retry:false};
 }
 return {ok:true,selection_sha256:sha,deleted:receipts.length,receipts,automatic_retry:false};
}
