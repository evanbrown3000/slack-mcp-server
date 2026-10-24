package server

import (
 "context"
 "encoding/csv"
 "encoding/json"
 "fmt"
 "io"
 "net/http"
 "net/url"
 "os"
 "strings"
 "strconv"
 "sync"
 "time"

 "github.com/korotovsky/slack-mcp-server/pkg/handler"
 "github.com/korotovsky/slack-mcp-server/pkg/provider"
 "github.com/mark3labs/mcp-go/mcp"
 mcpserver "github.com/mark3labs/mcp-go/server"
 "github.com/slack-go/slack"
 "go.uber.org/zap"
)

var curationLock sync.Mutex

func cogJSON(v any) *mcp.CallToolResult { b,_:=json.Marshal(v);return mcp.NewToolResultText(string(b)) }
func cogChannel(p *provider.ApiProvider, name string) (string,error) {
 if strings.HasPrefix(name,"#") { id:=p.ProvideChannelsMaps().ChannelsInv[strings.TrimPrefix(name,"#")];if id=="" {return "",fmt.Errorf("unknown channel %s",name)};return id,nil }
 if name=="" {return "",fmt.Errorf("channel_id is required")};return name,nil
}

// Render complete upstream CSV fields as readable conversation text. No message
// body is shortened or silently omitted; cursors stay explicit and expandable.
func renderConversation(source *mcp.CallToolResult) (*mcp.CallToolResult,error) {
 if source.IsError {return source,nil};var out strings.Builder
 for _,content:=range source.Content {
  t,ok:=content.(mcp.TextContent);if !ok {continue}
  records,err:=csv.NewReader(strings.NewReader(t.Text)).ReadAll();if err!=nil{return nil,err}
  if len(records)==0 {continue};headers:=records[0];count:=0;cursor:=""
  for _,record:=range records[1:] {
   fields:=map[string]string{};for i,key:=range headers {if i<len(record){fields[key]=record[i]}}
   if fields["Cursor"]!="" {cursor=fields["Cursor"]};if fields["MsgID"]==""&&fields["Text"]=="" {continue}
   who:=fields["RealName"];if who=="" {who=fields["UserName"]}
   fmt.Fprintf(&out,"\n### %s — %s\nMessage: %s | Thread: %s\n\n%s\n",who,fields["Time"],fields["MsgID"],fields["ThreadTs"],fields["Text"])
   if fields["Permalink"]!="" {fmt.Fprintf(&out,"\nSource: %s\n",fields["Permalink"])}
   if fields["AttachmentIDs"]!="" {fmt.Fprintf(&out,"Attachments: %s\n",fields["AttachmentIDs"])}
   count++
  }
  fmt.Fprintf(&out,"\nMessages in this page: %d.\n",count)
  if cursor!="" {fmt.Fprintf(&out,"More messages remain. Continue with cursor: %s\n",cursor)} else {out.WriteString("End of this source page; channel history and thread replies are separate views.\n")}
 }
 return mcp.NewToolResultText(out.String()),nil
}

type curationDecision struct { TS string `json:"ts"`; Action string `json:"action"`; Reason string `json:"reason"`; ExpectedText *string `json:"expected_text,omitempty"` }

func registerCognilode(s *mcpserver.MCPServer,p *provider.ApiProvider,logger *zap.Logger) {
 h:=handler.NewConversationsHandler(p,logger)
 s.AddTool(mcp.NewTool("conversations_read",
  mcp.WithDescription("Read complete Slack messages as readable Markdown using upstream history/thread/search handlers. No text truncation. Scope is one source page; follow the explicit cursor and expand threads independently."),mcp.WithReadOnlyHintAnnotation(true),
  mcp.WithString("channel_id",mcp.Description("Channel ID or #name; required unless searching.")),mcp.WithString("thread_ts"),mcp.WithString("search_query"),mcp.WithString("cursor"),mcp.WithString("limit",mcp.Description("Upstream count or time range, e.g. 30 or 7d. Omit when following a cursor."))),
  func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){
   var result *mcp.CallToolResult;var err error
   if r.GetString("search_query","")!="" {args:=r.GetArguments();if v,e:=strconv.Atoi(r.GetString("limit","20"));e==nil{args["limit"]=v};r.Params.Arguments=args;result,err=h.ConversationsSearchHandler(ctx,r)} else if r.GetString("thread_ts","")!="" {result,err=h.ConversationsRepliesHandler(ctx,r)} else {result,err=h.ConversationsHistoryHandler(ctx,r)}
   if err!=nil{return nil,err};return renderConversation(result)
  })
 admin,hasAdmin:=p.Slack().(interface{Administration()*slack.Client});if !hasAdmin{return};api:=admin.Administration()
 s.AddTool(mcp.NewTool("conversations_manage",mcp.WithDescription("Create, rename, archive, unarchive, describe or inspect a channel through the SAME upstream authenticated client. This changes Slack only; Company Project/Employee identity remains in its owning API."),mcp.WithReadOnlyHintAnnotation(false),
  mcp.WithString("action",mcp.Required(),mcp.Enum("info","create","rename","archive","unarchive","topic","purpose")),mcp.WithString("channel_id"),mcp.WithString("name"),mcp.WithString("text"),mcp.WithBoolean("private")),
  func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){
   action:=r.GetString("action","");name:=r.GetString("name","");var channel string;var err error
   if action!="create" {channel,err=cogChannel(p,r.GetString("channel_id",""));if err!=nil{return nil,err}}
   var result *slack.Channel
   switch action {
   case "create": result,err=api.CreateConversationContext(ctx,slack.CreateConversationParams{ChannelName:name,IsPrivate:r.GetBool("private",false)})
   case "rename":result,err=api.RenameConversationContext(ctx,channel,name)
   case "archive":err=api.ArchiveConversationContext(ctx,channel)
   case "unarchive":err=api.UnArchiveConversationContext(ctx,channel)
   case "topic":result,err=api.SetTopicOfConversationContext(ctx,channel,r.GetString("text",""))
   case "purpose":result,err=api.SetPurposeOfConversationContext(ctx,channel,r.GetString("text",""))
   case "info":result,err=api.GetConversationInfoContext(ctx,&slack.GetConversationInfoInput{ChannelID:channel})
   default:return nil,fmt.Errorf("unknown channel action")
   }
   if err!=nil{return nil,err};if result!=nil {p.RememberChannel(result)}
   if result!=nil {return cogJSON(map[string]any{"ok":true,"action":action,"channel_id":result.ID,"name":result.Name,"archived":result.IsArchived,"topic":result.Topic.Value,"purpose":result.Purpose.Value}),nil}
   return cogJSON(map[string]any{"ok":true,"action":action,"channel_id":channel}),nil
  })
 s.AddTool(mcp.NewTool("conversations_edit_message",mcp.WithDescription("Update an existing message through the upstream session. No automatic retry after an uncertain write."),mcp.WithReadOnlyHintAnnotation(false),mcp.WithString("channel_id",mcp.Required()),mcp.WithString("ts",mcp.Required()),mcp.WithString("text",mcp.Required())),func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){
  channel,err:=cogChannel(p,r.GetString("channel_id",""));if err!=nil{return nil,err};c,ts,text,err:=api.UpdateMessageContext(ctx,channel,r.GetString("ts",""),slack.MsgOptionText(r.GetString("text",""),false));if err!=nil{return nil,err};return cogJSON(map[string]any{"ok":true,"channel_id":c,"ts":ts,"text":text}),nil
 })
 s.AddTool(mcp.NewTool("conversations_curate",mcp.WithDescription("Apply the managing agent's semantic review: retain valuable messages, delete noise or redundant copies, and optionally publish useful synthesis BEFORE deleting originals. Read full context first. This tool does not classify value by length, keywords or exact equality. Each decision needs ts/action/reason; optional expected_text rejects stale selections. Up to 20 decisions per call; deletion is paced and partial/unknown results are explicit. No duplicate Slack corpus or D1 body store."),mcp.WithReadOnlyHintAnnotation(false),
  mcp.WithString("channel_id",mcp.Required()),mcp.WithString("decisions_json",mcp.Required(),mcp.Description("JSON array of {ts,action:retain|delete_noise|synthesize_delete,reason,expected_text?}. For duplicate deletion, name the retained source in reason.")),mcp.WithString("synthesis"),mcp.WithString("synthesis_thread_ts")),
  func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){
   channel,err:=cogChannel(p,r.GetString("channel_id",""));if err!=nil{return nil,err};var decisions []curationDecision
   if err=json.Unmarshal([]byte(r.GetString("decisions_json","")),&decisions);err!=nil{return nil,err};if len(decisions)==0||len(decisions)>20{return nil,fmt.Errorf("provide 1–20 reviewed decisions")}
   needsSynthesis:=false;seen:=map[string]bool{}
   for _,d:=range decisions {if d.TS==""||d.Reason==""||seen[d.TS]{return nil,fmt.Errorf("each distinct message needs its ID and semantic reason")};seen[d.TS]=true;if d.Action=="synthesize_delete"{needsSynthesis=true};if d.Action!="retain"&&d.Action!="delete_noise"&&d.Action!="synthesize_delete"{return nil,fmt.Errorf("unknown review action")}}
   synthesis:=r.GetString("synthesis","");if needsSynthesis&&synthesis==""{return nil,fmt.Errorf("synthesis is required for synthesize_delete")}
   curationLock.Lock();defer curationLock.Unlock();result:=map[string]any{"channel_id":channel};outcomes:=[]map[string]any{}
   if synthesis!="" {options:=[]slack.MsgOption{slack.MsgOptionText(synthesis,false)};if thread:=r.GetString("synthesis_thread_ts","");thread!=""{options=append(options,slack.MsgOptionTS(thread))};c,ts,e:=p.Slack().PostMessageContext(ctx,channel,options...);if e!=nil{return nil,e};result["synthesis"]=map[string]string{"channel":c,"ts":ts};got,e:=p.Slack().GetConversationHistoryContext(ctx,&slack.GetConversationHistoryParameters{ChannelID:c,Oldest:ts,Latest:ts,Inclusive:true,Limit:1});if e!=nil||len(got.Messages)!=1||got.Messages[0].Text=="" {return cogJSON(map[string]any{"synthesis":result["synthesis"],"deleted":0,"error":"synthesis accepted but readback not confirmed; no deletion attempted"}),nil}}
   for _,d:=range decisions {
    if d.Action=="retain"{outcomes=append(outcomes,map[string]any{"ts":d.TS,"state":"retained"});continue}
    if d.ExpectedText!=nil {got,e:=p.Slack().GetConversationHistoryContext(ctx,&slack.GetConversationHistoryParameters{ChannelID:channel,Oldest:d.TS,Latest:d.TS,Inclusive:true,Limit:1});if e!=nil||len(got.Messages)!=1||got.Messages[0].Text!=*d.ExpectedText {outcomes=append(outcomes,map[string]any{"ts":d.TS,"state":"source_changed_or_unreadable"});continue}}
    select {case <-ctx.Done():result["outcomes"]=outcomes;result["interrupted"]=true;return cogJSON(result),nil;case <-time.After(1500*time.Millisecond):}
    _,_,e:=api.DeleteMessageContext(ctx,channel,d.TS)
    if e!=nil {state:="provider_rejected_or_unknown";if e.Error()=="message_not_found"{state="already_absent"};outcomes=append(outcomes,map[string]any{"ts":d.TS,"state":state,"error":e.Error()});if state!="already_absent"{break}} else {outcomes=append(outcomes,map[string]any{"ts":d.TS,"state":"deleted","reason":d.Reason})}
   }
   result["outcomes"]=outcomes;result["all_decisions_processed"]=len(outcomes)==len(decisions);return cogJSON(result),nil
  })
 registerCompanyTools(s,p)
}

// API-owned operations remain in the existing Company/Projects/TaskFlow services.
// These tools are clients of those services, never a second registry or planner.
func cogHTTP(ctx context.Context,endpoint,method string,body any)([]byte,error){
 var reader io.Reader;if body!=nil{b,e:=json.Marshal(body);if e!=nil{return nil,e};reader=strings.NewReader(string(b))}
 req,e:=http.NewRequestWithContext(ctx,method,endpoint,reader);if e!=nil{return nil,e};req.Header.Set("Authorization","Bearer "+os.Getenv("COGNILODE_OPERATOR_TOKEN"));req.Header.Set("User-Agent","Cognilode-Slack-MCP/1.0");req.Header.Set("Content-Type","application/json")
 response,e:=(&http.Client{Timeout:45*time.Second}).Do(req);if e!=nil{return nil,e};defer response.Body.Close();b,e:=io.ReadAll(io.LimitReader(response.Body,8000001));if e!=nil{return nil,e};if len(b)>8000000{return nil,fmt.Errorf("domain response exceeds 8 MB; use a narrower source view")};if response.StatusCode>=400{return nil,fmt.Errorf("domain API HTTP %d: %s",response.StatusCode,string(b))};return b,nil
}
func registerCompanyTools(s *mcpserver.MCPServer,p *provider.ApiProvider){
 projects:=os.Getenv("COGNILODE_PROJECTS_MCP_URL")
 if projects!="" {
  ctx,cancel:=context.WithTimeout(context.Background(),8*time.Second)
  b,e:=cogHTTP(ctx,projects,"POST",map[string]any{"jsonrpc":"2.0","id":"slack-projects-discovery","method":"tools/list"});cancel()
  if e==nil {
   var catalog struct{Result struct{Tools []mcp.Tool `json:"tools"`} `json:"result"`}
   if json.Unmarshal(b,&catalog)==nil {
    for _,tool:=range catalog.Result.Tools {tool:=tool;s.AddTool(tool,func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){
     b,e:=cogHTTP(ctx,projects,"POST",map[string]any{"jsonrpc":"2.0","id":"slack-project-action","method":"tools/call","params":map[string]any{"name":tool.Name,"arguments":r.GetArguments()}});if e!=nil{return nil,e};var response struct{Result mcp.CallToolResult `json:"result"`;Error any `json:"error"`};if e=json.Unmarshal(b,&response);e!=nil{return nil,e};if response.Error!=nil{return nil,fmt.Errorf("project API: %v",response.Error)};return &response.Result,nil
    })}
   }
  }
 }
 taskflow:=strings.TrimRight(os.Getenv("COGNILODE_TASKFLOW_URL"),"/");if taskflow==""{return};registerSlackPlanTools(s,p,taskflow)
 s.AddTool(mcp.NewTool("taskflow_read",mcp.WithDescription("Read the actual native TaskFlow plan(s) or revision history. Multiple plans may belong to one Project; no Slack-owned plan copy."),mcp.WithReadOnlyHintAnnotation(true),mcp.WithString("plan_id"),mcp.WithBoolean("revisions")),func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){path:="slack-mirrors?view=plan&plan_id=";if r.GetBool("revisions",false){path="revisions?plan_id="};b,e:=cogHTTP(ctx,taskflow+"/api/taskflow/"+path+url.QueryEscape(r.GetString("plan_id","")),"GET",nil);if e!=nil{return nil,e};if r.GetBool("revisions",false){return mcp.NewToolResultText(string(b)),nil};return readableTaskflow(b)})
 s.AddTool(mcp.NewTool("taskflow_update",mcp.WithDescription("Apply a reviewed native plan revision or step signal through TaskFlow's existing API and revision checks. Include Slack source references in its native payload. Does not create another scheduler, silently infer human authority, or dispatch an agent."),mcp.WithReadOnlyHintAnnotation(false),mcp.WithString("operation",mcp.Required(),mcp.Enum("plan_revision","signal")),mcp.WithString("payload_json",mcp.Required(),mcp.Description("Existing native TaskFlow ingest or signal payload. Plan revisions retain expected_revision and original plan source."))),func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){var body any;if e:=json.Unmarshal([]byte(r.GetString("payload_json","")),&body);e!=nil{return nil,e};path:="signal";switch r.GetString("operation",""){case "plan_revision":path="plans/ingest";case "signal":default:return nil,fmt.Errorf("unknown TaskFlow operation")};b,e:=cogHTTP(ctx,taskflow+"/api/taskflow/"+path,"POST",body);if e!=nil{return nil,e};return mcp.NewToolResultText(string(b)),nil})
}
