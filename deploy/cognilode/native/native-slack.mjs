/**
 * Documented Slack Web API surface for Cognilode's existing, separately deployed
 * Slack capability Worker.  No new authorization/registry/storage authority.
 *
 * Token source: Worker secret or existing Company custody projection ONLY.
 * Each tool is checked by the incumbent Company grant before invocation.
 * A provider response is returned as a receipt; there is NO automatic replay
 * of ambiguous writes (in particular chat.postMessage).
 */

import {downloadSlackFile,slackFileInfo,slackFileRead} from './native-slack-files.mjs';
import {deletionPreparation,channelSummarySource} from './channel-disposition.mjs';
const obj = (properties,required=[]) => ({type:'object',properties,required,additionalProperties:false});
const s = {type:'string'};
const b = {type:'boolean'};
const lim = {type:'integer',minimum:1,maximum:100};
const channelId = {type:'string',pattern:'^[CGD][A-Z0-9]{8,}$'};
const channelName = {type:'string',minLength:1,maxLength:80,pattern:'^[a-z0-9_-]+$'};
const READ_ONLY_NAMES = new Set(['slack_channel_delete_prepare','slack_channel_summary_source','slack_identity','slack_channels_list','slack_channel_info','slack_history','slack_replies','slack_search','slack_get_permalink','slack_file_info','slack_file_read']);
const DESTRUCTIVE_NAMES = new Set(['slack_update_message','slack_channel_rename','slack_channel_archive','slack_channel_set_topic','slack_channel_set_purpose']);
const name = (name,description,properties,required) => ({name,description,inputSchema:obj(properties,required),
  annotations:{readOnlyHint:READ_ONLY_NAMES.has(name),destructiveHint:DESTRUCTIVE_NAMES.has(name),
    idempotentHint:READ_ONLY_NAMES.has(name),openWorldHint:true}});

export const NATIVE_CATALOG = [
   name('slack_channel_delete_prepare','Read exact channel identity and prepare Slack Free Workspace Owner/Admin native permanent deletion; no mutation and no false archive.',{channel:channelId},['channel']),
   name('slack_channel_summary_source','Read original Slack channel messages and optional replies as a bounded complete source page, with continuation.',{channel:channelId,cursor:s,limit:lim,oldest:s,latest:s,include_threads:b},['channel']),
  name('slack_identity','Read the actual connected Slack workspace and account identity with auth.test. The observed team_id is the project-binding account_id; no default account is inferred.',{},[]),
  name('slack_channels_list','List actual Slack conversations with a provider continuation cursor; membership/visibility follows the authorized Slack account.',{cursor:s,limit:lim,types:s},[]),
  name('slack_channel_info','Read the exact Slack channel identity, name, archival state, topic and purpose.',{channel:s},['channel']),
  name('slack_history','Read a bounded channel message page, including full message bodies and native cursor; not the whole channel.',{channel:s,cursor:s,limit:lim,oldest:s,latest:s,inclusive:b},['channel']),
  name('slack_replies','Read a Slack parent and its threaded replies with native cursor; preserve full text and thread identity.',{channel:s,ts:s,cursor:s,limit:lim,oldest:s,latest:s,inclusive:b},['channel','ts']),
  name('slack_search','Search messages using the documented Slack search.messages API; some bot tokens lack search:read, which is surfaced as an error.',{query:s,count:lim,page:{type:'integer',minimum:1,maximum:1000},sort:{type:'string',enum:['score','timestamp']},sort_dir:{type:'string',enum:['asc','desc']}},['query']),
  name('slack_get_permalink','Resolve a stable Slack message permalink without rewriting content or authority.',{channel:s,ts:s},['channel','ts']),
  name('slack_file_info','Read the metadata of an exact attached Slack file through the connected account. Private download credentials remain in the existing Slack capability.',{file_id:{type:'string',pattern:'^F[A-Z0-9]{8,}$'}},['file_id']),
  name('slack_file_read','Read an attached Slack file completely through explicit bounded pages. Text uses UTF-8 boundaries; choose base64 for binary files. Continue with returned continuation arguments and source_revision to reject changed files.',{file_id:{type:'string',pattern:'^F[A-Z0-9]{8,}$'},byte_offset:{type:'integer',minimum:0},limit_bytes:{type:'integer',minimum:4,maximum:262144,default:65536},source_revision:{type:'string',pattern:'^[a-f0-9]{64}$'},encoding:{type:'string',enum:['utf-8','base64'],default:'utf-8'}},['file_id']),
  name('slack_post_message','Post an actual message, optionally in an existing thread, with Slack-side identity/ts and readback. Mutating calls are never automatically retried.',{channel:s,text:s,thread_ts:s,reply_broadcast:b,client_msg_id:s},['channel','text']),
  name('slack_update_message','Edit an existing Slack message using official chat.update and read back the exact message. Supply its parent thread_ts for a reply when known; native response context takes precedence.',{channel:s,ts:s,text:s,thread_ts:s},['channel','ts','text']),
  name('slack_channel_create','Create one authorized public/private Slack channel and read back its identity; no name-based implicit reconciliation.',{name:s,is_private:b},['name']),
  name('slack_channel_join','Join an existing Slack channel as the authorized Slack account.',{channel:s},['channel']),
  name('slack_channel_invite','Invite specific Slack user IDs to one existing channel.',{channel:s,users:{type:'array',items:s,minItems:1,maxItems:100}},['channel','users']),
  name('slack_channel_rename','Rename one exact Slack channel ID and read back its identity and resulting name. No implicit name lookup or automatic mutation retry.',{channel:channelId,name:channelName},['channel','name']),
  name('slack_channel_archive','Archive one exact Slack channel ID and read back its archival state. Archiving retains the channel and its content; it does not delete them.',{channel:channelId},['channel']),
  name('slack_channel_unarchive','Restore one exact archived Slack channel ID and read back its archival state. No automatic mutation retry.',{channel:channelId},['channel']),
  name('slack_channel_set_topic','Set the topic of one exact Slack channel ID and read back the full value. An empty topic clears it.',{channel:channelId,topic:s},['channel','topic']),
  name('slack_channel_set_purpose','Set the purpose of one exact Slack channel ID and read back the full value. An empty purpose clears it.',{channel:channelId,purpose:s},['channel','purpose'])
];
export const NATIVE_NAMES = new Set(NATIVE_CATALOG.map(t=>t.name));
const MAX_PAGE=100;
const page = n => Math.min(MAX_PAGE, Math.max(1,Number.isInteger(n)?n:50));
const requireString = (x,name) => {
  if(typeof x!=='string'||!x.trim()) throw new Error('missing_'+name);
  return x;
};
const requireChannelId = x => {
  if(typeof x!=='string'||!/^[CGD][A-Z0-9]{8,}$/.test(x))throw new Error('exact_slack_channel_id_required');
  return x;
};
const stripEmpty = fields => Object.fromEntries(Object.entries(fields).filter(([,v])=>v!==undefined&&v!==null&&v!==''));

/**
 * Uses the documented native HTTPS JSON API, without changing the current
 * Slack connector or relying on undocumented browser/client endpoints.
 * The transport is injectable for contract checks; production uses fetch.
 */
export function createNativeSlackClient(token, transport=fetch) {
  if(typeof token!=='string'||!token.trim()) throw new Error('slack_token_binding_unavailable');
  const call=async(method,payload={})=>{
    // These documented read methods accept their arguments in the query.
    // JSON POST leaves conversations.info without its required channel.
    const queryRead=['conversations.list','conversations.info','conversations.replies',
      'search.messages','chat.getPermalink','files.info'].includes(method);
    // Empty topic/purpose values are meaningful explicit clears.
    const fields=method==='conversations.setTopic'||method==='conversations.setPurpose'
      ?Object.fromEntries(Object.entries(payload).filter(([,v])=>v!==undefined&&v!==null))
      :stripEmpty(payload);
    const url=new URL('https://slack.com/api/'+method);
    if(queryRead)for(const [key,value] of Object.entries(fields))url.searchParams.set(key,String(value));
    const response=await transport(url.href,{
      method:queryRead?'GET':'POST',
      headers:{'authorization':'Bearer '+token,'accept':'application/json',...(!queryRead?{'content-type':'application/json; charset=utf-8'}:{})},
      ...(!queryRead?{body:JSON.stringify(fields)}:{}),
      redirect:'manual'
    });
    let result;
    try {result=await response.json();} catch {throw new Error('slack_non_json_response:'+method+':'+response.status);}
    if(!response.ok)throw new Error('slack_http_'+method+':'+response.status);
    if(!result||typeof result!=='object')throw new Error('slack_invalid_response:'+method);
    return result;
  };
  return {
    auth:{test:p=>call('auth.test',p)},
    files:{info:p=>call('files.info',p),download:(url,offset,limit,signal)=>downloadSlackFile(token,transport,url,offset,limit,signal)},
    conversations:Object.fromEntries(['list','info','history','replies','create','join','invite','rename','archive','unarchive','setTopic','setPurpose'].map(x=>[x,p=>call('conversations.'+x,p)])),
    chat:Object.fromEntries(['postMessage','update','delete','getPermalink'].map(x=>[x,p=>call('chat.'+x,p)])),
    search:{messages:p=>call('search.messages',p)}
  };
}

// Compare Slack's three native text entities without changing retained bodies,
// whitespace, link markup, or arbitrary HTML/numeric entities.
const comparableSlackText = text => typeof text==='string'
  ?text.replace(/&(?:amp|lt|gt);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>'}[entity])):null;
async function verifiedMessage(api,channel,ts,threadTs=null,expectedText=null) {
  try{
    const window={channel,oldest:ts,latest:ts,inclusive:true,limit:2};
    const r=threadTs
      ?await api.conversations.replies({...window,ts:threadTs})
      :await api.conversations.history(window);
    const m=r.ok===true ? (r.messages||[]).find(x=>x.ts===ts):null;
    const textVerified=typeof expectedText==='string'
      ?!!m&&comparableSlackText(m.text)===comparableSlackText(expectedText):null;
    return {verified:!!m&&textVerified!==false,observed_at:new Date().toISOString(),message:m||null,
      ...(typeof expectedText==='string'?{text_verified:textVerified,text_comparison:'slack_native_entities'}:{}),
      readback_error:r.ok!==true?(r.error||'source_missing'):!m?'message_not_found':textVerified===false?'message_text_mismatch':null};
  } catch(e) {
    return {verified:false,observed_at:new Date().toISOString(),message:null,readback_error:String(e?.message||e)};
  }
}
async function verifiedChannel(api,channel,expected) {
  try {
    const info=await api.conversations.info({channel});
    const observed=info.ok===true?info.channel:null;
    const mismatches=[];
    if(observed?.id!==channel)mismatches.push({field:'id',expected:channel,observed:observed?.id??null});
    for(const [field,value] of Object.entries(expected)){
      const actual=field.split('.').reduce((current,key)=>current?.[key],observed);
      if(actual!==value)mismatches.push({field,expected:value,observed:actual??null});
    }
    return {verified:info.ok===true&&mismatches.length===0,observed_at:new Date().toISOString(),
      channel:observed||null,expected,mismatches,
      readback_error:info.ok===true?(mismatches.length?'channel_state_mismatch':null):(info.error||'source_missing')};
  }catch(e){
    return {verified:false,observed_at:new Date().toISOString(),channel:null,expected,
      readback_error:String(e?.message||e)};
  }
}
const annotation={source:'slack_native_web_api',authorship:'slack_account_identity_only_not_human_authority'};

/** Every operation is preceded by the caller's Company authorization gate. */
export async function executeNativeSlack(name,args,api) {
  if(!NATIVE_NAMES.has(name))throw new Error('unknown_native_slack_tool');
  const a=args||{};
  let r;
  if(name==='slack_channel_delete_prepare')return {...annotation,...await deletionPreparation(a,api)};
  if(name==='slack_channel_summary_source')return {...annotation,...await channelSummarySource(a,api)};
  if(name==='slack_file_info')return {...annotation,...await slackFileInfo(a,api)};
  if(name==='slack_file_read')return {...annotation,...await slackFileRead(a,api)};
  if(name==='slack_identity'){
    r=await api.auth.test({});
    if(!r.ok)throw new Error('slack_identity:'+r.error);
    if(typeof r.team_id!=='string'||!/^T[A-Z0-9]{8,}$/.test(r.team_id))throw new Error('slack_workspace_identity_unavailable');
    return {...annotation,ok:true,account_id:r.team_id,team_id:r.team_id,team:r.team||null,
      user_id:r.user_id||null,user:r.user||null,bot_id:r.bot_id||null,url:r.url||null,
      enterprise_id:r.enterprise_id||null,is_enterprise_install:r.is_enterprise_install??null,
      observed_at:new Date().toISOString()};
  }
  if(name==='slack_channels_list'){
    r=await api.conversations.list(stripEmpty({cursor:a.cursor,limit:page(a.limit),types:a.types||'public_channel,private_channel'}));
    if(!r.ok)throw new Error('slack_channels_list:'+r.error);
    return {...annotation,ok:true,channels:r.channels||[],next_cursor:r.response_metadata?.next_cursor||null};
  }
  if(name==='slack_channel_info'){
    r=await api.conversations.info({channel:requireString(a.channel,'channel')});
    if(!r.ok)throw new Error('slack_channel_info:'+r.error);
    return {...annotation,ok:true,channel:r.channel};
  }
  if(name==='slack_history'||name==='slack_replies'){
    const p=stripEmpty({channel:requireString(a.channel,'channel'),ts:name==='slack_replies'?requireString(a.ts,'ts'):undefined,cursor:a.cursor,limit:page(a.limit),oldest:a.oldest,latest:a.latest,inclusive:a.inclusive});
    r=name==='slack_replies'?await api.conversations.replies(p):await api.conversations.history(p);
    if(!r.ok)throw new Error(name+':'+r.error);
    return {...annotation,ok:true,channel:a.channel,thread_ts:name==='slack_replies'?a.ts:null,messages:r.messages||[],
      next_cursor:r.response_metadata?.next_cursor||null,has_more:!!r.has_more,
      window_only:true,source_complete:r.has_more!==true&&!r.response_metadata?.next_cursor};
  }
  if(name==='slack_search'){
    r=await api.search.messages(stripEmpty({query:requireString(a.query,'query'),count:page(a.count),page:a.page||1,sort:a.sort||'timestamp',sort_dir:a.sort_dir||'desc'}));
    if(!r.ok)throw new Error('slack_search:'+r.error);
    return {...annotation,ok:true,query:a.query,matches:r.messages?.matches||[],paging:r.messages?.paging||null,
      next_page:(r.messages?.paging?.page||1)<(r.messages?.paging?.pages||1)?(r.messages.paging.page+1):null};
  }
  if(name==='slack_get_permalink'){
    r=await api.chat.getPermalink({channel:requireString(a.channel,'channel'),message_ts:requireString(a.ts,'ts')});
    if(!r.ok)throw new Error('slack_get_permalink:'+r.error);
    return {...annotation,ok:true,channel:a.channel,ts:a.ts,permalink:r.permalink};
  }
  if(name==='slack_post_message'){
    requireString(a.channel,'channel');requireString(a.text,'text');
    r=await api.chat.postMessage(stripEmpty({channel:a.channel,text:a.text,thread_ts:a.thread_ts,reply_broadcast:a.reply_broadcast===true,
      client_msg_id:a.client_msg_id}));
    if(!r.ok)throw new Error('slack_post_message:'+r.error);
    const verification=await verifiedMessage(api,r.channel||a.channel,r.ts,a.thread_ts);
    return {...annotation,ok:true,mutation:'posted',channel:r.channel||a.channel,ts:r.ts,thread_ts:a.thread_ts||null,
      native_acceptance:true,readback:verification,warning:'Transport-ambiguous writes MUST be reconciled before retry; a returned ACK is not manager consumption.'};
  }
  if(name==='slack_update_message'){
    requireString(a.channel,'channel');requireString(a.ts,'ts');requireString(a.text,'text');
    if(a.thread_ts!==undefined)requireString(a.thread_ts,'thread_ts');
    r=await api.chat.update({channel:a.channel,ts:a.ts,text:a.text});
    if(!r.ok)throw new Error('slack_update_message:'+r.error);
    const nativeThread=typeof r.message?.thread_ts==='string'?r.message.thread_ts
      :typeof r.thread_ts==='string'?r.thread_ts:null;
    const threadTs=nativeThread||a.thread_ts||null;
    const verification=await verifiedMessage(api,a.channel,a.ts,threadTs,a.text);
    const observedThread=verification.message?.thread_ts;
    return {...annotation,ok:true,mutation:'edited',channel:a.channel,ts:a.ts,
      thread_ts:typeof observedThread==='string'?observedThread:threadTs,
      native_acceptance:true,readback:verification,readback_verified:verification.verified,
      status:verification.verified?'completed':'accepted_readback_unconfirmed',automatic_retry:false};
  }
  if(name==='slack_channel_create'){
    r=await api.conversations.create({name:requireString(a.name,'name'),is_private:a.is_private===true});
    if(!r.ok)throw new Error('slack_channel_create:'+r.error);
    const verification=r.channel?.id?await verifiedChannel(api,r.channel.id,{name:a.name}):{
      verified:false,observed_at:new Date().toISOString(),channel:null,expected:{name:a.name},
      readback_error:'slack_create_missing_channel_identity'};
    return {...annotation,ok:true,mutation:'created',channel:r.channel||null,native_acceptance:true,
      readback:verification,readback_verified:verification.verified,
      status:verification.verified?'completed':'accepted_readback_unconfirmed',automatic_retry:false};
  }
  if(name==='slack_channel_join'||name==='slack_channel_invite'){
    requireString(a.channel,'channel');
    if(name==='slack_channel_invite'&&(!Array.isArray(a.users)||!a.users.length||a.users.some(x=>typeof x!=='string'||!x)))throw new Error('slack_invite_users_required');
    r=name==='slack_channel_join'
      ?await api.conversations.join({channel:a.channel})
      :await api.conversations.invite({channel:a.channel,users:a.users.join(',')});
    if(!r.ok)throw new Error(name+':'+r.error);
    return {...annotation,ok:true,mutation:name,channel:r.channel||a.channel,native_acceptance:true};
  }
  if(['slack_channel_rename','slack_channel_archive','slack_channel_unarchive','slack_channel_set_topic','slack_channel_set_purpose'].includes(name)){
    const channel=requireChannelId(a.channel);
    let method,expected,payload={channel};
    if(name==='slack_channel_rename'){
      if(typeof a.name!=='string'||!/^[a-z0-9_-]{1,80}$/.test(a.name))throw new Error('invalid_slack_channel_name');
      method='rename';payload.name=a.name;expected={name:a.name};
    }else if(name==='slack_channel_archive'||name==='slack_channel_unarchive'){
      method=name==='slack_channel_archive'?'archive':'unarchive';expected={is_archived:method==='archive'};
    }else{
      const field=name==='slack_channel_set_topic'?'topic':'purpose';
      if(typeof a[field]!=='string')throw new Error('missing_'+field);
      method=field==='topic'?'setTopic':'setPurpose';payload[field]=a[field];expected={[field+'.value']:a[field]};
    }
    r=await api.conversations[method](payload);
    if(!r.ok)throw new Error(name+':'+r.error);
    const verification=await verifiedChannel(api,channel,expected);
    // Keep the caller's exact channel identity even if the mutation response
    // contains unexpected identity data; never redirect the readback to it.
    const identityMatch=!r.channel?.id||r.channel.id===channel;
    if(!identityMatch){verification.verified=false;verification.readback_error='mutation_channel_identity_mismatch';}
    return {...annotation,ok:true,mutation:name,channel,native_acceptance:true,
      provider_channel_id:r.channel?.id||null,readback:verification,readback_verified:verification.verified,
      status:verification.verified?'completed':'accepted_readback_unconfirmed',automatic_retry:false};
  }
  throw new Error('unknown_native_slack_tool');
}
