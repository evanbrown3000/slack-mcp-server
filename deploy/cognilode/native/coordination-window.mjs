import {checkOperatorAuthorization} from './operator-authorization.mjs';
import {OPERATOR_API} from './operator-api-contract.mjs';
import {publicSlackPage,coordinationSnapshot,coordinationFileControls,renderCoordinationMessages,COORDINATION_PUBLIC_MODEL_SOURCE,COORDINATION_FILE_CONTROLS_SOURCE} from './coordination-public-model.mjs';
const DEFINITION=OPERATOR_API.coordination;
const REV=DEFINITION.revision;
const BASE=DEFINITION.route;
const GENERAL=DEFINITION.default_channel;
const PAGE_SIZES=DEFINITION.page_sizes;
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function slack(env,authorization,name,args){
 const r=await env.SLACK.fetch(new Request('https://slack.internal/mcp',{method:'POST',headers:{authorization:env.SLACK_AUTHORIZATION||authorization,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}})}));
 if(!r.ok)throw Error('slack_transport_http_'+r.status);
 const rpc=await r.json();if(rpc.error)throw Error(rpc.error.message);
 const value=rpc.result?.structuredContent??JSON.parse(rpc.result?.content?.find(x=>x.type==='text')?.text||'{}');
 if(value.ok===false||rpc.result?.isError){
  const error=Error(value.error||value.code||'slack_operation_failed');
  // Preserve the selected native project's accepted identity on incomplete
  // readback. Reconciliation must never require replaying that write.
  if(value.provider==='slack'&&typeof value.verified==='boolean')error.native_result=value;
  throw error;
 }return value;
}
async function catalog(env,authorization){
 const r=await env.SLACK.fetch(new Request('https://slack.internal/mcp',{method:'POST',headers:{authorization:env.SLACK_AUTHORIZATION||authorization,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/list'})}));
 if(!r.ok)throw Error('slack_catalog_http_'+r.status);const rpc=await r.json();if(!Array.isArray(rpc.result?.tools))throw Error('slack_catalog_unavailable');return rpc.result.tools;
}
async function authorized(request,env){
 let authorization=request.headers.get('authorization');
 if(!authorization){const match=(request.headers.get('cookie')||'').match(/(?:^|;\s*)cognilode_operator_session=([^;]*)/);if(match){const encoded=decodeURIComponent(match[1]).replace(/-/g,'+').replace(/_/g,'/');authorization='Bearer '+atob(encoded+'='.repeat((4-encoded.length%4)%4)).replace(/^Bearer\s+/,'').trim();if(request.method==='POST'&&!request.headers.get('origin'))throw Error('operator_origin_required');}}
 if(!authorization)throw Error('operator_authorization_required');
 const auth=authorization.startsWith('Bearer ')?authorization:'Bearer '+decodeURIComponent(authorization);
 const gate=await checkOperatorAuthorization(env.OPERATOR_AUTH,auth);
 if(!gate.ok)throw Error(gate.error);return auth;
}
function textResult(value){
 if(Array.isArray(value.messages)||Array.isArray(value.matches))return renderCoordinationMessages(publicSlackPage(value,{kind:value.matches?'search':value.thread_ts?'thread':'history',channel:value.channel,thread_ts:value.thread_ts,query:value.query,page_sizes:PAGE_SIZES}));
 if(typeof value.content==='string')return (value.file?.title||value.file?.name||value.file?.id||'Slack attachment')+'\n'+value.content+'\n'+(value.complete?'End of file.':'Continue with: '+JSON.stringify(value.continuation));
 return JSON.stringify(value,null,2);
}
function readControls(page,actions){
 const controls=coordinationFileControls(page,actions,REV);
 const declared=new Set(actions.map(action=>action.id));
 const add=(title,action_id,args)=>{if(declared.has(action_id))controls.push({title,tool:'operator_action',required_arguments:['request_id'],arguments:{window_id:'coordination',layout_revision:REV,action_id,arguments:args}});};
 add('Refresh channel','slack.slack_history',{channel:page.channel,limit:PAGE_SIZES.history});
 if(page.page.next_cursor)add('Continue messages',page.kind==='thread'?'slack.slack_replies':'slack.slack_history',{channel:page.channel,...(page.thread_ts?{ts:page.thread_ts}:{}),cursor:page.page.next_cursor,limit:page.page.limit});
 if(page.page.next_page)add('Continue search','slack.slack_search',{query:page.query,page:page.page.next_page,count:page.page.limit});
 for(const message of page.messages)if(message.reply_count)add('Read thread replies','slack.slack_replies',{channel:message.channel_id,ts:message.thread_ts||message.ts,limit:PAGE_SIZES.thread});
 return controls;
}
async function dispatch(input,env,auth){
 const a=input.arguments||{};
 if(input.name==='operator_action_receipt')return {ok:false,error:'request_local_result_not_retained',request_id:a.request_id,receipt_owner:'slack_native_operation',result_retention:'request_local',recovery:'Read the returned Slack channel and message timestamp through the declared Slack history or replies action. This operation never repeats a write.'};
 if(input.name==='operator_window'){
  const tools=await catalog(env,auth);
  // The native capability declares each operation once. Project/channel
  // mutations and their read/write semantics reach every Operator caller
  // through this same catalog instead of a separate presentation schema.
  const actions=tools.map(t=>({id:'slack.'+t.name,tool:t.name,title:t.description,scope:'window',effect:t.annotations?.readOnlyHint===true?'read':'write',inputSchema:t.inputSchema,annotations:t.annotations||{}}));
  const channel=a.filters?.channel_id||GENERAL;
  const value=await slack(env,auth,'slack_history',{channel,limit:PAGE_SIZES.history});
  const page=publicSlackPage(value,{kind:'history',channel,page_sizes:PAGE_SIZES});
  return {ok:true,schema:'cognilode.operator.window-response.v1',window_id:'coordination',layout_revision:REV,view_id:'coordination',cursor:REV,mode:'full',actions,
   definition:DEFINITION,snapshot:coordinationSnapshot(page,actions,REV,null,DEFINITION),public_page:page,read_controls:readControls(page,actions),observed_at:page.observed_at,source_complete:true,errors:[],
   source:{owner:'existing Coordination Slack capability',operation:'slack_history',channel,available:true,coverage:'One bounded message page with all attachment metadata; bodies and remaining pages are explicit reads.'},
   rendered:'# '+DEFINITION.title+'\n\n'+renderCoordinationMessages(page)+'\n\nDeclared controls:\n'+JSON.stringify(readControls(page,actions))};
 }
 if(input.name!=='operator_action'||a.layout_revision!==REV)throw Error('current_coordination_layout_required');
 if(!a.request_id||a.request_id.length>180)throw Error('request_id_required');
 const tools=await catalog(env,auth),name=String(a.action_id||'').replace(/^slack\./,'');
 const tool=tools.find(t=>t.name===name);if(!tool)throw Error('unknown_slack_action');
 const args=a.arguments||{};for(const key of tool.inputSchema.required||[])if(args[key]===undefined)throw Error('missing_'+key);
 for(const key of Object.keys(args))if(!Object.hasOwn(tool.inputSchema.properties,key))throw Error('unsupported_argument_'+key);
 const write=tool.annotations?.readOnlyHint!==true;
 // Slack owns durable message state. A response is returned to the caller;
 // no KV receipt is required before or after the actual provider operation.
 if(name==='slack_post_message'&&!args.client_msg_id){
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(a.request_id)));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes.slice(0,16)].map(x=>x.toString(16).padStart(2,'0')).join('');
  args.client_msg_id=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
 }
 let value;
 try{value=await slack(env,auth,name,args);}
 catch(error){const native=error.native_result,uncertain=write&&(!native||native.native_acceptance!==false);return {ok:false,request_id:a.request_id,action_id:a.action_id,
  status:uncertain?'outcome_unknown':'failed',outcome_unknown:uncertain,error:String(error.message||error),
  ...(native?{result:native,native_acceptance:native.native_acceptance??null,native_reference:{provider:'slack',external_id:native.external_id||null,account_id:native.account_id||null}}:{}),
  automatic_retry:false,result_retention:'request_local',receipt_owner:'slack_native_operation',
  ...(name==='slack_post_message'?{native_client_msg_id:args.client_msg_id}:{}),
  recovery:write?'Reconcile the intended Slack channel and native operation before another submission.':'Retry this read explicitly if needed.'};}

 const receipt={ok:true,request_id:a.request_id,action_id:a.action_id,status:value.status||'completed',result:value,rendered:textResult(value)};
 return {...receipt,result_retention:'request_local',receipt_owner:'slack_native_operation',automatic_retry:false,
  ...(name==='slack_post_message'?{native_client_msg_id:args.client_msg_id}:{}),
  ...(value.channel&&value.ts?{native_readback:{channel:value.channel,ts:value.ts,thread_ts:value.thread_ts||null,
   action_id:value.thread_ts?'slack.slack_replies':'slack.slack_history',
   arguments:{channel:value.channel,...(value.thread_ts?{ts:value.thread_ts}:{}),oldest:value.ts,latest:value.ts,inclusive:true,limit:2}}}:{}),
  ...(!value.ts&&value.channel?{native_readback:{channel:typeof value.channel==='string'?value.channel:value.channel.id,action_id:'slack.slack_channel_info'}}:{}),
  source_read_effects:{kv_reads:0,kv_writes:0,d1_requests:0}};

}
const page=()=>`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(DEFINITION.title)} · Cognilode</title><style>body{margin:0;background:#171717;color:#eee;font:16px system-ui}main{max-width:940px;margin:auto;padding:28px}nav,form{display:flex;gap:12px;flex-wrap:wrap}button,select,input,textarea{font:inherit;background:#292929;color:#eee;border:1px solid #555;border-radius:8px;padding:10px}button{cursor:pointer}textarea{width:100%;min-height:120px;box-sizing:border-box}article{padding:20px 0;border-bottom:1px solid #444}article p{white-space:pre-wrap;line-height:1.6}pre{white-space:pre-wrap;overflow-wrap:anywhere}.attachments{display:grid;gap:8px;padding:12px 0}small{color:#aaa}#status{padding:12px 0}h1{font-size:24px}dialog{background:#222;color:#eee;max-width:800px;width:85%;border:1px solid #666}a{color:#b8d5ff}</style><main><nav><a href="/operator/">Operator</a><h1>${esc(DEFINITION.title)}</h1></nav><form id="browse"><select id="channel"><option value="${GENERAL}">#general</option></select><button>Read channel</button><input id="query" placeholder="Search Slack"><button type="button" id="search">Search</button></form><div id="status" role="status"></div><section id="messages"></section><button id="next" hidden>Older messages</button><h2>Write a message</h2><textarea id="compose" aria-label="Message"></textarea><button id="post">Post to selected channel</button><dialog id="edit"><h2>Edit original message</h2><textarea id="edittext"></textarea><button id="save">Save edit</button><button id="cancel">Cancel</button></dialog><dialog id="attachment"><h2 id="filetitle">Attachment</h2><p id="filemeta"></p><pre id="filebody"></pre><button id="filemore" hidden>Read next part</button><button id="fileclose">Close</button></dialog><script type="module" src="${BASE}client.mjs"></script></main></html>`;
// Generated behavior consumes the exact public model and native action catalog
// used by API/MCP. Attachment fields/action arguments are declared only there.
const client=String.raw`const $=id=>document.getElementById(id);
const publicSlackPage=${COORDINATION_PUBLIC_MODEL_SOURCE};
const coordinationFileControls=${COORDINATION_FILE_CONTROLS_SOURCE};
const definition=${JSON.stringify(DEFINITION)},pageSizes=definition.page_sizes;
let selected=null,actions=[],revision=${JSON.stringify(REV)},current={name:'slack_history',args:{channel:${JSON.stringify(GENERAL)},limit:pageSizes.history}},continuation=null,fileContinuation=null;
async function call(name,args){const r=await fetch('./api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,arguments:args})});const v=await r.json();if(!v.ok)throw Error(v.error||'Request failed');return v;}
async function action(name,args){if(!actions.some(a=>a.id==='slack.'+name))throw Error('Action unavailable in current Slack catalog: '+name);return (await call('operator_action',{window_id:'coordination',layout_revision:revision,action_id:'slack.'+name,arguments:args,request_id:crypto.randomUUID()})).result;}
function status(s){$('status').textContent=s;}
async function run(fn){try{status('Loading…');await fn();}catch(e){status(e.message);}}
async function readFile(control,append=false){
 const value=await action(control.action_id.replace(/^slack\./,''),control.arguments);
 if(control.action_id==='slack.slack_file_info'){status(JSON.stringify(value.file));return;}
 $('filetitle').textContent=value.file.title||value.file.name||value.file.id;
 if(!append)$('filebody').textContent='';
 $('filebody').textContent+=value.content;
 $('filemeta').textContent=value.encoding+' · '+(value.byte_offset+value.byte_length)+' of '+(value.total_bytes??'unknown')+' bytes'+(value.complete?' · Complete':' · More available');
 fileContinuation=value.continuation?{action_id:control.action_id,arguments:value.continuation}:null;$('filemore').hidden=!fileContinuation;
 if(!$('attachment').open)$('attachment').showModal();status(value.complete?'Attachment read completely':'Attachment page read; next part available');
}
function render(page,append=false){
 if(!append)$('messages').replaceChildren();
 const fileControls=coordinationFileControls(page,actions,revision);
 for(const m of page.messages){
  const article=document.createElement('article'),p=document.createElement('p'),meta=document.createElement('small'),edit=document.createElement('button');
  p.textContent=m.text||'';meta.textContent=new Date(Number(m.ts)*1000).toLocaleString();edit.textContent='Edit';edit.onclick=()=>{selected=m;$('edittext').value=m.text||'';$('edit').showModal();};article.append(meta,p,edit);
  if(m.reply_count){const button=document.createElement('button');button.textContent='Read '+m.reply_count+' replies';button.onclick=()=>run(async()=>{current={name:'slack_replies',args:{channel:m.channel_id,ts:m.thread_ts||m.ts,limit:pageSizes.thread}};await read();});article.append(button);}
  const attachments=document.createElement('section');attachments.className='attachments';
  for(const control of fileControls.filter(control=>control.message_ts===m.ts)){
   const button=document.createElement('button');button.textContent=control.title;button.onclick=()=>run(()=>readFile(control.arguments));attachments.append(button);
  }
  if(m.files.length)article.append(attachments);$('messages').append(article);
 }
 continuation=page.page.next_cursor?{...current.args,cursor:page.page.next_cursor}:page.page.next_page?{...current.args,page:page.page.next_page}:null;
 $('next').hidden=!continuation;
}
async function read(append=false){const value=await action(current.name,append&&continuation?continuation:current.args);const page=publicSlackPage(value,{kind:current.name==='slack_search'?'search':current.name==='slack_replies'?'thread':'history',channel:current.args.channel,thread_ts:current.args.ts,query:current.args.query,page_sizes:pageSizes,limit:current.args.limit||current.args.count});render(page,append);status('Read from Slack now');}
$('browse').onsubmit=e=>{e.preventDefault();current={name:'slack_history',args:{channel:$('channel').value,limit:pageSizes.history}};run(()=>read());};
$('next').onclick=()=>run(()=>read(true));
$('search').onclick=()=>run(async()=>{current={name:'slack_search',args:{query:$('query').value,count:pageSizes.search}};await read();});
$('post').onclick=()=>run(async()=>{const text=$('compose').value;if(!text.trim())return;await action('slack_post_message',{channel:$('channel').value,text});$('compose').value='';await read();});
$('cancel').onclick=()=>$('edit').close();
$('save').onclick=()=>run(async()=>{await action('slack_update_message',{channel:selected.channel_id,ts:selected.ts,text:$('edittext').value,...(selected.thread_ts?{thread_ts:selected.thread_ts}:{})});$('edit').close();await read();});
$('fileclose').onclick=()=>$('attachment').close();$('filemore').onclick=()=>fileContinuation&&run(()=>readFile(fileContinuation,true));
run(async()=>{const view=await call('operator_window',{window_id:'coordination'});actions=view.actions;revision=view.layout_revision;render(view.public_page);const value=await action('slack_channels_list',{limit:100});for(const channel of value.channels){if(channel.id===${JSON.stringify(GENERAL)})continue;const option=document.createElement('option');option.value=channel.id;option.textContent='#'+channel.name;$('channel').append(option);}status('Read from Slack now');});`;
export default {async fetch(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/health')return Response.json({ok:true,domain:'coordination',runtime:'ordinary-worker',revision:REV,containers:false,d1:false});
 try{
  const auth=await authorized(request,env);
  if(path===BASE+'api'||path===BASE+'window'){
   if(request.method!=='POST')return new Response('Method not allowed',{status:405});
   if(request.headers.get('origin')&&!['https://cognilode.com','https://operator.cognilode.com','https://www.cognilode.com'].includes(request.headers.get('origin')))throw Error('origin_not_allowed');
   return Response.json(await dispatch(await request.json(),env,auth),{headers:{'cache-control':'no-store'}});
  }
  if(path===BASE+'client.mjs')return new Response(client,{headers:{'content-type':'application/javascript'}});
  if(path===BASE)return new Response(page(),{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'"}});
  return new Response('Not found',{status:404});
 }catch(e){return Response.json({ok:false,error:String(e.message||e)},{status:503,headers:{'cache-control':'no-store'}});}
}};
