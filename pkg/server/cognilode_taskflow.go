package server

import (
 "context"
 "encoding/json"
 "fmt"
 "net/url"
 "strings"

 "github.com/korotovsky/slack-mcp-server/pkg/provider"
 "github.com/mark3labs/mcp-go/mcp"
 mcpserver "github.com/mark3labs/mcp-go/server"
 "github.com/slack-go/slack"
)

func registerSlackPlanTools(s *mcpserver.MCPServer,p *provider.ApiProvider,base string){
 admin,ok:=p.Slack().(interface{Administration()*slack.Client});if !ok{return};api:=admin.Administration()
 publish := func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){
  id:=r.GetString("plan_id","");sourceCursor:=r.GetInt("source_cursor",-1);if sourceCursor<0{meta,err:=cogHTTP(ctx,base+"/api/taskflow/slack-mirrors?plan_id="+url.QueryEscape(id),"GET",nil);if err!=nil{return nil,err};var observed struct{Cursor int `json:"source_cursor"`};if err=json.Unmarshal(meta,&observed);err!=nil{return nil,err};sourceCursor=observed.Cursor};b,e:=cogHTTP(ctx,base+"/api/taskflow/slack-mirrors?view=plan&plan_id="+url.QueryEscape(id),"GET",nil);if e!=nil{return nil,e};var snap struct{Plans []map[string]any `json:"plans"`;Steps []map[string]any `json:"steps"`;Work []map[string]any `json:"recent_work"`};if e=json.Unmarshal(b,&snap);e!=nil{return nil,e};var plan map[string]any;for _,v:=range snap.Plans{if v["plan_id"]==id{plan=v;break}};if plan==nil{return nil,fmt.Errorf("native plan not found")}
  var text strings.Builder;fmt.Fprintf(&text,"*%v*\n%v\n\n*Current progress* · revision %v · %v\n",plan["title"],plan["abstract"],plan["revision"],plan["status"])
  for _,step:=range snap.Steps{if step["plan_id"]!=id{continue};title:=step["title"];if title==nil{title=step["text"]};if title==nil{title=step["step_id"]};state:=step["state"];if state==nil{state=step["status"]};fmt.Fprintf(&text,"• %v — %v\n",title,state)}
  if len(snap.Work)>0{text.WriteString("\n*Recent work*\n");for _,work:=range snap.Work{body,_:=work["text"].(string);if len(body)>5000{fmt.Fprintf(&text,"• %v: long return available in the full native work view.\n",work["event_kind"])}else{fmt.Fprintf(&text,"• %s\n",body)}}}
  fmt.Fprintf(&text,"\n<https://operator.cognilode.com/operator/taskflow?plan_id=%s|Open full native plan and work>\nTaskFlow plan: %s",url.QueryEscape(id),id)
  if text.Len()>35000{return nil,fmt.Errorf("plan outline exceeds Slack message size; publish selected subplan instead of silently truncating")}
  channel,e:=cogChannel(p,r.GetString("channel_id",""));if e!=nil{return nil,e};ts:=r.GetString("message_ts","")
  if ts!=""{_,ts,_,e=api.UpdateMessageContext(ctx,channel,ts,slack.MsgOptionText(text.String(),false))}else{options:=[]slack.MsgOption{slack.MsgOptionText(text.String(),false)};if thread:=r.GetString("thread_ts","");thread!=""{options=append(options,slack.MsgOptionTS(thread))};_,ts,e=p.Slack().PostMessageContext(ctx,channel,options...)}
  if e!=nil{return nil,e};result:=map[string]any{"ok":true,"plan_id":id,"revision":plan["revision"],"channel_id":channel,"message_ts":ts,"source":"existing_native_taskflow","plan_copied_to_another_store":false};_,bindError:=cogHTTP(ctx,base+"/api/taskflow/slack-mirrors","POST",map[string]any{"action":"bind","plan_id":id,"channel_id":channel,"message_ts":ts,"source_cursor":sourceCursor});result["automatic_mirror_bound"]=bindError==nil;if bindError!=nil{result["mirror_binding_error"]=bindError.Error()};return cogJSON(result),nil
 }
 s.AddTool(mcp.NewTool("taskflow_publish",mcp.WithDescription("Publish a readable current native TaskFlow plan and progress in Slack, or update its existing message. Reads the actual TaskFlow plan; does not create a Slack-owned plan store or prompt scheduler. Return the message ID for future revision updates. One Project may have multiple plans."),mcp.WithReadOnlyHintAnnotation(false),mcp.WithString("plan_id",mcp.Required()),mcp.WithString("channel_id",mcp.Required()),mcp.WithString("message_ts"),mcp.WithString("thread_ts")),publish)
 startTaskflowMirrorSync(s,p,base,publish)
 s.AddTool(mcp.NewTool("taskflow_update_from_slack",mcp.WithDescription("Apply a reviewed plan change expressed in a specific Slack message through the existing TaskFlow revision API, then append the actual acceptance to that same message. The agent interprets prose and supplies the native payload; this tool retains the full Slack source, enforces expected_revision and does not blindly execute posted instructions. Native acceptance and Slack acknowledgement are separate outcomes."),mcp.WithReadOnlyHintAnnotation(false),mcp.WithString("channel_id",mcp.Required()),mcp.WithString("message_ts",mcp.Required()),mcp.WithString("native_payload_json",mcp.Required()),mcp.WithNumber("expected_revision",mcp.Required())),func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){
  channel,e:=cogChannel(p,r.GetString("channel_id",""));if e!=nil{return nil,e};ts:=r.GetString("message_ts","");got,e:=p.Slack().GetConversationHistoryContext(ctx,&slack.GetConversationHistoryParameters{ChannelID:channel,Oldest:ts,Latest:ts,Inclusive:true,Limit:1});if e!=nil{return nil,e};if len(got.Messages)!=1||got.Messages[0].Timestamp!=ts{return nil,fmt.Errorf("source Slack message not found")}
  var payload map[string]any;if e=json.Unmarshal([]byte(r.GetString("native_payload_json","")),&payload);e!=nil{return nil,e};payload["expected_revision"]=r.GetInt("expected_revision",-1);source:="https://everything-ces8532.slack.com/archives/"+channel+"/p"+strings.ReplaceAll(ts,".","");payload["source_ref"]=source
  payload["rationale"]=got.Messages[0].Text
  b,e:=cogHTTP(ctx,base+"/api/taskflow/plans/ingest","POST",payload);if e!=nil{return nil,e};var receipt map[string]any;if e=json.Unmarshal(b,&receipt);e!=nil{return nil,e}
  acknowledgement:=fmt.Sprintf("\n\n_TaskFlow applied this reviewed change: plan %v, revision %v._",receipt["plan_id"],receipt["revision"])
  _,_,_,mirrorError:=api.UpdateMessageContext(ctx,channel,ts,slack.MsgOptionText(got.Messages[0].Text+acknowledgement,false));result:=map[string]any{"native_receipt":receipt,"source_ref":source,"slack_acknowledged":mirrorError==nil,"provider_requests_created_by_this_tool":0};if mirrorError!=nil{result["slack_error"]=mirrorError.Error();result["do_not_reapply_native_revision"]=true};return cogJSON(result),nil
 })
}

func readableTaskflow(b []byte)(*mcp.CallToolResult,error){
 var v struct{Plans []map[string]any `json:"plans"`;Steps []map[string]any `json:"steps"`;Work []map[string]any `json:"recent_work"`};if e:=json.Unmarshal(b,&v);e!=nil{return nil,e};var out strings.Builder
 for _,p:=range v.Plans{fmt.Fprintf(&out,"## %v\nPlan: %v | Revision: %v | Status: %v\n\n%v\n",p["title"],p["plan_id"],p["revision"],p["status"],p["abstract"]);for _,step:=range v.Steps{if step["plan_id"]==p["plan_id"]{fmt.Fprintf(&out,"\n### %v [%v]\nStep ID: %v | Owner: %v\n%v\n",step["title"],step["status"],step["step_id"],step["assignee"],step["details"])}}};for _,work:=range v.Work{fmt.Fprintf(&out,"\n### Recent work — %v\n%v\n",work["event_kind"],work["text"])};return mcp.NewToolResultText(out.String()),nil
}
