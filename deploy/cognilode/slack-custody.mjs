// Existing Cloudflare credential DB is the sole credential authority.
export const CREDENTIAL_REF='slack.product-session.owner-personal';
export async function slackCredential(env,authorization){
 if(!env.CREDENTIALS?.fetch)throw new Error('central_slack_custody_unbound');
 const r=await env.CREDENTIALS.fetch(new Request('https://custody.internal/api/operator/agent-control/mcp',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name:'credential_get',arguments:{id:CREDENTIAL_REF}}})}));
 if(!r.ok)throw new Error('central_slack_custody_http_'+r.status);
 const rpc=await r.json();if(rpc.error||rpc.result?.isError)throw new Error('central_slack_custody_resolution_failed');
 const result=rpc.result;let body=result?.structuredContent;
 if(!body){try{body=JSON.parse(result.content.find(x=>x.type==='text').text)}catch{throw new Error('central_slack_custody_response_invalid')}}
 let v=body.value;if(typeof v==='string'){try{v=JSON.parse(v)}catch{throw new Error('central_slack_credential_invalid')}}
 if(v?.schema!=='cognilode.slack.session.v1'||v.state!=='active'||typeof v.token!=='string'||!/^xox[bcp]-/.test(v.token)||/[\r\n]/.test(v.token)||typeof v.cookie!=='string'||/[\r\n]/.test(v.cookie))throw new Error('central_slack_credential_invalid_or_inactive');
 if(v.expires_at&&Date.parse(v.expires_at)<=Date.now())throw new Error('central_slack_credential_expired');
 return v;
}
