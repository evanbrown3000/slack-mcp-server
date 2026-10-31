import {NATIVE_CATALOG, NATIVE_NAMES, createNativeSlackClient, executeNativeSlack} from './native-slack.mjs';
import {slackCredential} from './slack-custody.mjs';
import {executeSlackProjectAdapter, executeSlackProjectTool, slackProjectFailure, SLACK_PROJECT_CATALOG, SLACK_PROJECT_NAMES} from './project-adapter.mjs';

const result=(id,value)=>Response.json({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:value.ok===false}},{headers:{'cache-control':'no-store'}});
async function authorizedSlackClient(env){
 const credential=await slackCredential(env,'Bearer '+env.OPERATOR_TOKEN);
 // Preserve the existing authorized native token and product-session cookie.
 const transport=(url,options)=>fetch(url,{...options,headers:{...options.headers,cookie:credential.cookie},signal:options.signal||AbortSignal.timeout(25000)});
 return createNativeSlackClient(credential.token,transport);
}
export default {async fetch(request,env){
 const url=new URL(request.url),auth=request.headers.get('authorization');
 if(url.pathname==='/healthz')return Response.json({ok:true,component:'cognilode-slack-upstream',runtime:'ordinary-worker',containers:false,d1:false});
 if(auth!=='Bearer '+env.OPERATOR_TOKEN&&auth!=='Bearer '+env.SLACK_CLIENT_KEY&&url.searchParams.get('access_key')!==env.SLACK_CLIENT_KEY)return new Response('Unauthorized',{status:401});
 if(request.method!=='POST')return new Response('Method not allowed',{status:405});
 let rpc;try{rpc=await request.json();}catch{return new Response('Invalid JSON',{status:400});}
 const projectRoute=/^\/v1\/(read|create|rename|delete)$/.exec(url.pathname);
 if(projectRoute){
  try{
   const value=await executeSlackProjectAdapter(projectRoute[1],rpc,await authorizedSlackClient(env));
   return Response.json(value,{headers:{'cache-control':'no-store'}});
  }catch(error){
   return Response.json(slackProjectFailure(projectRoute[1],rpc,error),{headers:{'cache-control':'no-store'}});
  }
 }
 if(rpc.method==='initialize')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'cognilode-slack-upstream',version:'native-worker.2.projects'}}});
 if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
 if(rpc.method==='ping')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{}});
 if(rpc.method==='tools/list')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{tools:[...NATIVE_CATALOG,...SLACK_PROJECT_CATALOG]}});
 if(rpc.method!=='tools/call'||(!NATIVE_NAMES.has(rpc.params?.name)&&!SLACK_PROJECT_NAMES.has(rpc.params?.name)))return Response.json({jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Unknown Slack tool'}});
 try{
  const api=await authorizedSlackClient(env);
  const value=SLACK_PROJECT_NAMES.has(rpc.params.name)
   ?await executeSlackProjectTool(rpc.params.name,rpc.params.arguments||{},api)
   :await executeNativeSlack(rpc.params.name,rpc.params.arguments||{},api);
  return result(rpc.id,value);
 }catch(error){
  if(SLACK_PROJECT_NAMES.has(rpc.params?.name)){
   const operation=rpc.params.name==='slack_project_archive'?'delete':rpc.params.name.slice('slack_project_'.length);
   return result(rpc.id,slackProjectFailure(operation,rpc.params.arguments,error));
  }
  return result(rpc.id,{ok:false,error:String(error.message||error)});
 }
}};
