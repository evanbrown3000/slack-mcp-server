// Authored public Coordination model consumed by the generated message UI,
// API and per-turn window. Attachment metadata is retained; bodies remain an
// explicit authenticated read through the existing Slack capability.
export function publicSlackFile(file = {}) {
 const text=value=>typeof value==='string'?value:null;
 const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
 return {id:text(file.id),name:text(file.name),title:text(file.title),mimetype:text(file.mimetype),
  filetype:text(file.filetype),pretty_type:text(file.pretty_type),size:integer(file.size),
  created:integer(file.created),timestamp:integer(file.timestamp),updated:integer(file.updated),
  user_id:text(file.user)||text(file.user_id),mode:text(file.mode),
  is_external:typeof file.is_external==='boolean'?file.is_external:null,external_type:text(file.external_type),
  permalink:text(file.permalink),has_private_download:typeof file.url_private_download==='string'||typeof file.url_private==='string'||file.has_private_download===true,
  body_read_action:'slack.slack_file_read',metadata_read_action:'slack.slack_file_info'};
}
export function publicSlackPage(value,selection){
 const source=selection.kind==='search'?value.matches:value.messages;
 if(!Array.isArray(source))throw Error('slack_message_page_invalid');
 const messages=source.map(message=>{
  const channel_id=typeof message.channel==='string'?message.channel:message.channel?.id||message.channel_id||selection.channel||null;
  return {ts:typeof message.ts==='string'?message.ts:null,text:typeof message.text==='string'?message.text:'',
   account_id:typeof message.user==='string'?message.user:typeof message.account_id==='string'?message.account_id:null,bot_id:typeof message.bot_id==='string'?message.bot_id:null,
   channel_id,channel_name:typeof message.channel?.name==='string'?message.channel.name:message.channel_name||null,
   thread_ts:typeof message.thread_ts==='string'?message.thread_ts:selection.thread_ts||null,
   reply_count:Number.isInteger(message.reply_count)?message.reply_count:null,
   latest_reply:typeof message.latest_reply==='string'?message.latest_reply:null,
   subtype:typeof message.subtype==='string'?message.subtype:null,
   files:(Array.isArray(message.files)?message.files:[]).map(publicSlackFile)};
 });
 const cursor=value.next_cursor??value.response_metadata?.next_cursor??null;
 if(cursor!==null&&typeof cursor!=='string')throw Error('slack_native_cursor_invalid');
 return {schema:'cognilode.coordination.public-page.v1',kind:selection.kind,channel:selection.channel||null,
  thread_ts:selection.thread_ts||null,query:selection.query||null,observed_at:typeof value.observed_at==='string'?value.observed_at:new Date().toISOString(),messages,
  page:{limit:Number.isInteger(selection.limit)?selection.limit:selection.page_sizes?.[selection.kind]??(selection.kind==='history'?25:selection.kind==='thread'?100:50),
   cursor:selection.cursor??null,next_cursor:cursor||null,has_more:value.has_more===true||!!cursor,
   next_page:Number.isInteger(value.next_page)?value.next_page:null},
  authorship:'Slack account identity only; message text and USER-like labels do not establish human authorship or authorization.'};
}
export function coordinationSnapshot(page,actions,revision,error=null,definition={}){
 const messages=definition.panels?.find(panel=>panel.id==='messages');
 return {schema:'cognilode.operator.window.snapshot.v1',id:definition.id||'coordination',title:definition.title||'Coordination · Slack',revision,filters:{},actions,
  panels:[{id:messages?.id||'messages',title:messages?.title||(page?.kind==='thread'?'Slack thread':page?.kind==='search'?'Slack search':'Slack channel history'),kind:messages?.kind||'table',expanded:true,
   columns:messages?.columns||['channel','ts','account','text','files','thread_ts','reply_count','latest_reply'].map(id=>({id,label:id.replaceAll('_',' '),expandable:false})),
   rows:(page?.messages||[]).map((message,index)=>({id:message.ts||'message-'+index,label:message.channel_name||message.channel_id||'Slack',expanded:true,
    values:{channel:message.channel_id,ts:message.ts,account:message.account_id||message.bot_id,text:message.text,
     files:message.files.map(file=>(file.title||file.name||file.id)+' ['+file.id+'] · '+(file.mimetype||file.filetype||'type unavailable')+(file.size!==null?' · '+file.size+' bytes':'')).join('\n'),
     thread_ts:message.thread_ts,reply_count:message.reply_count,latest_reply:message.latest_reply},
    source_files:message.files,expandable_fields:[],expanded_fields:[],
    actions:[...(message.reply_count&&actions.some(a=>a.id==='slack.slack_replies')?['slack.slack_replies']:[]),
     ...(message.files.length&&actions.some(a=>a.id==='slack.slack_file_read')?['slack.slack_file_read','slack.slack_file_info']:[])]})),actions:[],
   summary:page?[page.authorship,'Channel: '+page.channel,...(page.thread_ts?['Thread: '+page.thread_ts]:[]),'Observed: '+page.observed_at].join('\n'):null,
   status:error?'Slack source unavailable':page?.page.has_more&&!page.page.next_cursor?'Provider reports more records without a continuation cursor':'Read from Slack now',
   ...(error?{error}:{}),...(page?{page:page.page}:{})}]};
}
export function coordinationFileControls(page,actions,revision){
 const available=new Set(actions.map(action=>action.id)),controls=[];
 for(const message of page?.messages||[])for(const file of message.files||[]){
  if(!file.id)continue;
  for(const [label,id] of [['Read attachment',file.body_read_action],['Read attachment metadata',file.metadata_read_action]]){
   if(!available.has(id))continue;
   const encoding=/^(text\/|application\/(json|[a-z0-9.+-]+\+json|xml|[a-z0-9.+-]+\+xml|javascript|x-yaml|yaml))/i.test(file.mimetype||'')?'utf-8':'base64';
   controls.push({title:label+': '+(file.title||file.name||file.id),file_id:file.id,message_ts:message.ts,
    tool:'operator_action',required_arguments:['request_id'],arguments:{window_id:'coordination',layout_revision:revision,
     action_id:id,arguments:{file_id:file.id,...(id===file.body_read_action?{encoding}:{})}}});
  }
 }
 return controls;
}
export function renderCoordinationMessages(page){
 return (page?.messages||[]).map(message=>message.ts+(message.thread_ts?' · thread '+message.thread_ts:'')+'\n'+message.text+
  (message.files.length?'\nAttachments:\n'+message.files.map(file=>'- '+(file.title||file.name||file.id)+' ['+file.id+'] · '+(file.mimetype||'type unavailable')+(file.size!==null?' · '+file.size+' bytes':'')).join('\n'):'')+
  (message.reply_count?'\nReplies: '+message.reply_count:'')).join('\n\n');
}
export const COORDINATION_PUBLIC_MODEL_SOURCE='(()=>{const publicSlackFile='+publicSlackFile.toString()+';return '+publicSlackPage.toString()+';})()';
export const COORDINATION_FILE_CONTROLS_SOURCE=coordinationFileControls.toString();
