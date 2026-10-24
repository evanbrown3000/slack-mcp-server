import {DurableObject} from 'cloudflare:workers';
import {slackCredential} from './slack-custody.mjs';
// Hosting/authentication only. Slack tools, lookup, caches, rendering and MCP
// protocol are the unmodified korotovsky/slack-mcp-server release.
export class SlackUpstream extends DurableObject {
 async fetch(request){
  const c=this.ctx.container;
  if(new URL(request.url).pathname==='/admin/restart'){if(c?.running)await c.destroy();return Response.json({ok:true,restarted:true});}
  if(!c)return Response.json({error:'upstream_container_not_attached'},{status:503});
  if(!c.running){
   const credential=await slackCredential(this.env,'Bearer '+this.env.OPERATOR_TOKEN);
   const cookie=credential.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('d='));
   const env={COGNILODE_OPERATOR_TOKEN:this.env.OPERATOR_TOKEN,COGNILODE_PROJECTS_MCP_URL:'https://cognilode-unified-projects-blue.evanbrown3000.workers.dev/mcp',COGNILODE_TASKFLOW_URL:'https://cognilode-taskflow-live.evanbrown3000.workers.dev',SLACK_MCP_HOST:'0.0.0.0',SLACK_MCP_PORT:'3001',SLACK_MCP_API_KEY:this.env.SLACK_CLIENT_KEY,SLACK_MCP_ADD_MESSAGE_TOOL:'true',SLACK_MCP_USERS_CACHE:'/tmp/slack-users.json',SLACK_MCP_CHANNELS_CACHE:'/tmp/slack-channels.json'};
   if(credential.token.startsWith('xoxc-')){if(!cookie)throw Error('central_slack_session_cookie_missing');env.SLACK_MCP_XOXC_TOKEN=credential.token;env.SLACK_MCP_XOXD_TOKEN=decodeURIComponent(cookie.slice(2));}
   else env[credential.token.startsWith('xoxb-')?'SLACK_MCP_XOXB_TOKEN':'SLACK_MCP_XOXP_TOKEN']=credential.token;
   await c.start({enableInternet:true,env,entrypoint:['mcp-server','--transport','http']});
  }
  await c.setInactivityTimeout(900000);
  const port=c.getTcpPort(3001);let last;
  for(let i=0;i<40;i++){
   try{const probe=await port.fetch('http://localhost:3001/mcp',{method:'GET',headers:{Accept:'application/json, text/event-stream',Authorization:'Bearer '+this.env.SLACK_CLIENT_KEY}});await probe.body?.cancel();last=null;break;}catch(e){last=e;await new Promise(r=>setTimeout(r,500));}
  }
  if(last)throw Error('upstream_not_ready:'+String(last));
  const headers=new Headers(request.headers);headers.set('Authorization','Bearer '+this.env.SLACK_CLIENT_KEY);headers.delete('host');
  return port.fetch(new Request('http://localhost:3001/mcp',{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'}));
 }
}
export default {async fetch(request,env){
 const u=new URL(request.url);
 if(u.pathname==='/healthz')return Response.json({component:'korotovsky-slack-mcp',release:'v1.3.0-cognilode.1',upstream_repository:'korotovsky/slack-mcp-server',extension_commit:'cf96e36e02d7659be3603642db43ce12ccf48901'});
 if(u.pathname==='/admin/restart'&&request.method==='POST'&&request.headers.get('authorization')==='Bearer '+env.OPERATOR_TOKEN)return env.SLACK_UPSTREAM.get(env.SLACK_UPSTREAM.idFromName('owner-slack')).fetch(request);
 if(u.pathname!=='/mcp')return new Response('Not found',{status:404});
 const auth=request.headers.get('authorization');
 if(u.searchParams.get('access_key')!==env.SLACK_CLIENT_KEY&&auth!=='Bearer '+env.OPERATOR_TOKEN&&auth!=='Bearer '+env.SLACK_CLIENT_KEY)return new Response('Unauthorized',{status:401});
 try{return await env.SLACK_UPSTREAM.get(env.SLACK_UPSTREAM.idFromName('owner-slack')).fetch(request);}catch(e){return Response.json({error:String(e.message)},{status:503});}
}};
