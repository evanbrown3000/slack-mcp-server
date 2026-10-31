// Source-bound Slack cleanup support. No permanent-delete API is invented for Free.
const channelId=x=>{if(typeof x!=='string'||!/^[CG][A-Z0-9]{8,}$/.test(x))throw Error('exact_slack_channel_id_required');return x};
const identity=async api=>{const x=await api.auth.test();if(x?.ok!==true||typeof x.team_id!=='string')throw Error('slack_workspace_identity_unavailable');return x};
const info=async (api,channel)=>{const r=await api.conversations.info({channel});if(r?.ok!==true||r.channel?.id!==channel)throw Error('slack_channel_readback_unverified');return r.channel};
export async function deletionPreparation(args,api){
 const channel=channelId(args.channel),owner=await identity(api),current=await info(api,channel);
 if(current.name==='general'||current.is_general===true)throw Error('slack_general_channel_cannot_be_deleted');
 return {ok:true,operation:'slack_channel_delete_prepare',performed:false,permanent:true,
   workspace_id:owner.team_id,channel_id:channel,name:current.name,is_archived:current.is_archived===true,
   native_url:'https://app.slack.com/client/'+encodeURIComponent(owner.team_id)+'/'+encodeURIComponent(channel),
   required_role:'Workspace Owner or Admin',method:'native_slack_settings_ui',
   steps:current.is_archived?
    ['Open native URL','Open channel name, then Settings','Delete this channel','Confirm permanent deletion']:
    ['Open native URL','Open channel name, then Settings','Delete channel, then Delete this channel','Confirm permanent deletion'],
   verified_provider_state:'exists',deletion_verified:false,
   reason:'Slack Free owner/admin GUI supports permanent deletion; admin.conversations.delete API is Enterprise-only. This operation does not archive or delete.'};
}
const format=(m,thread)=>[thread?'thread '+thread:'message',m.ts,m.user||m.bot_id||'unknown author',m.text||''].join(' | ');
export async function channelSummarySource(args,api){
 const channel=channelId(args.channel),owner=await identity(api),c=await info(api,channel);
 const limit=Number.isInteger(args.limit)&&args.limit>=1&&args.limit<=100?args.limit:50;
 const params={channel,limit,...(args.cursor?{cursor:args.cursor}:{}),
   ...(args.oldest?{oldest:args.oldest}:{}),...(args.latest?{latest:args.latest}:{})};
 const page=await api.conversations.history(params);
 if(page?.ok!==true||!Array.isArray(page.messages))throw Error('slack_channel_history_unavailable');
 const messages=page.messages.map(m=>({ts:m.ts,user:m.user||null,bot_id:m.bot_id||null,
   text:typeof m.text==='string'?m.text:'',thread_ts:m.thread_ts||null,reply_count:m.reply_count||0}));
 const threads=[],pending_threads=[];
 if(args.include_threads===true){
  for(const m of messages){
   if(!(m.reply_count>0))continue;
   const r=await api.conversations.replies({channel,ts:m.ts,limit:100});
   if(r?.ok!==true||!Array.isArray(r.messages)){pending_threads.push({thread_ts:m.ts,error:'source_unavailable'});continue}
   threads.push({thread_ts:m.ts,messages:r.messages.filter(x=>x.ts!==m.ts)});
   if(r.has_more||r.response_metadata?.next_cursor)
    pending_threads.push({thread_ts:m.ts,cursor:r.response_metadata?.next_cursor||null,error:'additional_page'});
  }
 }
 const next_cursor=page.response_metadata?.next_cursor||null;
 const complete=!next_cursor&&!page.has_more&&!pending_threads.length;
 const source_text=['Slack source — not yet an accepted canonical summary',
   'Workspace: '+owner.team_id,'Channel: #'+c.name+' ('+channel+')',
   'Complete selection: '+complete,
   ...messages.map(m=>format(m)),...threads.flatMap(t=>t.messages.map(m=>format(m,t.thread_ts)))].join('\n');
 return {ok:true,source:'native_slack_history',workspace_id:owner.team_id,channel_id:channel,
   title:c.name,observed_at:new Date().toISOString(),messages,threads,complete,next_cursor,pending_threads,
   source_text,usage:'Use the existing LLM window to summarize this source with a selected prompt/model/effort. Follow next_cursor and pending_threads before declaring an entire channel summarized.'};
}
