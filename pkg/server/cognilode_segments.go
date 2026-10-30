package server

import (
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "fmt"
 "os"
 "sort"
 "strconv"
 "strings"
 "sync"
 "time"

 "github.com/korotovsky/slack-mcp-server/pkg/provider"
 "github.com/mark3labs/mcp-go/mcp"
 mcpserver "github.com/mark3labs/mcp-go/server"
 "github.com/slack-go/slack"
 "go.uber.org/zap"
)

// Conversation segments are source-bound Slack messages, not a second corpus.
// The source channel itself carries the latest covered range and digest, so a
// process restart needs no KV/D1 cursor. Project/TaskFlow remain native owners.
const segmentMarker = "cognilode-conversation-segment:v1"

type segmentSource struct {
 TS string `json:"ts"`
 User string `json:"user,omitempty"`
 Text string `json:"text"`
 ThreadTS string `json:"thread_ts,omitempty"`
 ReplyCount int `json:"reply_count,omitempty"`
 HasFiles bool `json:"has_files,omitempty"`
 HasAttachments bool `json:"has_attachments,omitempty"`
}
type segmentDelete struct {
 TS string `json:"ts"`
 Reason string `json:"reason"`
}
type segmentDecision struct {
 Decision string `json:"decision"`
 Summary string `json:"summary"`
 Reason string `json:"reason"`
 Delete []segmentDelete `json:"delete"`
 Retain []string `json:"retain"`
}
type segmentObservation struct {
 ChannelID string `json:"channel_id"`
 CheckedAt string `json:"checked_at"`
 State string `json:"state"`
 SourceMessages int `json:"source_messages"`
 SourcePages int `json:"source_pages"`
 SourceComplete bool `json:"source_complete"`
 SourceSHA256 string `json:"source_sha256,omitempty"`
 FirstTS string `json:"first_ts,omitempty"`
 LastTS string `json:"last_ts,omitempty"`
 SummaryTS string `json:"summary_ts,omitempty"`
 Deleted int `json:"deleted"`
 Retained int `json:"retained"`
 ModelRequests int `json:"model_requests"`
 SlackReads int `json:"slack_reads"`
 SlackWrites int `json:"slack_writes"`
 Error string `json:"error,omitempty"`
}
type slackAutonomyState struct {
 sync.RWMutex
 Running bool `json:"running"`
 StartedAt string `json:"started_at,omitempty"`
 LastRunAt string `json:"last_run_at,omitempty"`
 NextRunAt string `json:"next_run_at,omitempty"`
 LastProjectReconcile any `json:"last_project_reconcile,omitempty"`
 Channels []segmentObservation `json:"channels,omitempty"`
 LastError string `json:"last_error,omitempty"`
}
var slackAutonomy slackAutonomyState
var slackAutonomyOnce sync.Once
var segmentRunMu sync.Mutex

func parsePositiveEnv(name string, fallback, min, max int) int {
 n,err:=strconv.Atoi(strings.TrimSpace(os.Getenv(name)));if err!=nil{n=fallback}
 if n<min{n=min};if n>max{n=max};return n
}

func callMCPJSON(ctx context.Context, endpoint, tool string, arguments map[string]any) (map[string]any,error) {
 if strings.TrimSpace(endpoint)=="" {return nil,fmt.Errorf("%s owner URL is not configured",tool)}
 body:=map[string]any{"jsonrpc":"2.0","id":"slack-autonomy-"+tool,"method":"tools/call","params":map[string]any{"name":tool,"arguments":arguments}}
 raw,err:=cogHTTP(ctx,endpoint,"POST",body);if err!=nil{return nil,err}
 var envelope struct{
  Result struct{Content []struct{Type string `json:"type"`;Text string `json:"text"`} `json:"content"`;IsError bool `json:"isError"`} `json:"result"`
  Error any `json:"error"`
 }
 if err=json.Unmarshal(raw,&envelope);err!=nil{return nil,err}
 if envelope.Error!=nil{return nil,fmt.Errorf("%s owner returned JSON-RPC error: %v",tool,envelope.Error)}
 if envelope.Result.IsError{return nil,fmt.Errorf("%s owner returned an error result",tool)}
 for _,part:=range envelope.Result.Content {
  if part.Type!="text"{continue}
  var value map[string]any
  if json.Unmarshal([]byte(part.Text),&value)==nil{return value,nil}
 }
 // Some incumbent native owners return a direct structured result.
 var direct map[string]any
 if json.Unmarshal(raw,&direct)==nil {
  if result,ok:=direct["result"].(map[string]any);ok{return result,nil}
 }
 return nil,fmt.Errorf("%s owner returned no structured JSON result",tool)
}

func sourceDigest(messages []segmentSource) string {
 b,_:=json.Marshal(messages);sum:=sha256.Sum256(b);return hex.EncodeToString(sum[:])
}
func segmentSummaryMarker(channel,first,last,digest,model,effort,profile string) string {
 return fmt.Sprintf("_%s channel=%s first=%s last=%s sha256=%s model=%s effort=%s profile=%s_",
  segmentMarker,channel,first,last,digest,model,effort,profile)
}
func coveredLastTS(text,channel string) string {
 if !strings.Contains(text,segmentMarker+" channel="+channel+" "){return ""}
 for _,field:=range strings.Fields(text){if strings.HasPrefix(field,"last="){return strings.TrimSuffix(strings.TrimPrefix(field,"last="),"_")}}
 return ""
}

func readChannelSource(ctx context.Context,p *provider.ApiProvider,channel string,maxPages int)([]segmentSource,string,int,bool,error){
 cursor:="";lastCovered:="";pages:=0;complete:=false;all:=[]slack.Message{}
 for pages<maxPages {
  pages++
  history,err:=p.Slack().GetConversationHistoryContext(ctx,&slack.GetConversationHistoryParameters{ChannelID:channel,Limit:100,Cursor:cursor})
  if err!=nil{return nil,"",pages,false,err}
  all=append(all,history.Messages...)
  // The newest segment marker is the durable cursor. Once found, older pages
  // cannot contain new unsummarized material, so stop without extra quota.
  for _,msg:=range history.Messages{
   if covered:=coveredLastTS(msg.Text,channel);covered!=""{
    if lastCovered==""||covered>lastCovered{lastCovered=covered}
   }
  }
  next:=history.ResponseMetaData.NextCursor
  if lastCovered!=""||next==""{complete=next==""||lastCovered!="";break}
  cursor=next
  select{case <-ctx.Done():return nil,lastCovered,pages,false,ctx.Err();case <-time.After(350*time.Millisecond):}
 }
 sort.Slice(all,func(i,j int)bool{return all[i].Timestamp<all[j].Timestamp})
 seen:=map[string]bool{};out:=[]segmentSource{}
 for _,msg:=range all{
  if msg.Timestamp==""||seen[msg.Timestamp]||msg.Timestamp<=lastCovered||strings.Contains(msg.Text,segmentMarker){continue}
  seen[msg.Timestamp]=true
  // Activity/system messages and attachment/file-bearing records are not
  // destructive compaction candidates; they may still be referenced by the
  // natural-language summary through adjacent ordinary messages.
  if msg.SubType!=""{continue}
  out=append(out,segmentSource{TS:msg.Timestamp,User:msg.User,Text:msg.Text,ThreadTS:msg.ThreadTimestamp,
   ReplyCount:msg.ReplyCount,HasFiles:len(msg.Files)>0,HasAttachments:len(msg.Attachments)>0})
 }
 return out,lastCovered,pages,complete,nil
}

func completionDecision(ctx context.Context,channel string,messages []segmentSource,model,effort,profile,instructions string)(segmentDecision,error){
 endpoint:=strings.TrimSpace(os.Getenv("COGNILODE_COMPLETION_MCP_URL"))
 payload,_:=json.Marshal(messages)
 sourceSHA:=sourceDigest(messages)
 task:=strings.TrimSpace(instructions)
 if task==""{
  task="Summarize this Slack conversation segment semantically. Preserve decisions, requirements, ownership, source-qualified facts, unresolved questions, blockers, corrections, and concrete next actions. Distinguish human statements, agent proposals, provider observations, and inference. Remove only messages whose useful meaning is preserved by the synthesis or which are true noise/redundant copies. Never infer human authority from a Slack user/account label. Return strict JSON only."
 }
 prompt:=task+"\n\nReturn exactly: {\"decision\":\"wait|summarize\",\"summary\":\"...\",\"reason\":\"...\",\"delete\":[{\"ts\":\"...\",\"reason\":\"...\"}],\"retain\":[\"ts\",...]}. If the source does not yet form a coherent segment, choose wait. Do not decide based on message length or keywords.\n\nChannel: "+channel+"\nSource SHA-256: "+sourceSHA+"\nSource messages JSON:\n"+string(payload)
 result,err:=callMCPJSON(ctx,endpoint,"completion_run",map[string]any{
  "operation_id":"slack-segment:"+channel+":"+sourceSHA,
  "actor_id":"slack-context-steward",
  "prompt_profile":profile,
  "prompt":prompt,
  "model":model,
  "reasoning_effort":effort,
  "reason":"Autonomous semantic Slack conversation-segment compaction",
  "source_ref":"slack:"+channel+":"+messages[0].TS+".."+messages[len(messages)-1].TS,
 })
 if err!=nil{return segmentDecision{},err}
 if state,_:=result["state"].(string);state!=""&&state!="completed"{
  return segmentDecision{},fmt.Errorf("completion retained as %s; observe the same operation instead of resubmitting",state)
 }
 text,_:=result["response_text"].(string);if text==""{text,_=result["text"].(string)}
 var decision segmentDecision
 if err=json.Unmarshal([]byte(text),&decision);err!=nil{return decision,fmt.Errorf("completion result is not strict decision JSON: %w",err)}
 if decision.Decision!="wait"&&decision.Decision!="summarize"{return decision,fmt.Errorf("invalid segment decision")}
 if decision.Decision=="summarize"&&strings.TrimSpace(decision.Summary)==""{return decision,fmt.Errorf("summary required")}
 return decision,nil
}

func applySegment(ctx context.Context,p *provider.ApiProvider,channel string,messages []segmentSource,decision segmentDecision,model,effort,profile string)(segmentObservation,error){
 obs:=segmentObservation{ChannelID:channel,CheckedAt:time.Now().UTC().Format(time.RFC3339),State:decision.Decision,
  SourceMessages:len(messages),SourceSHA256:sourceDigest(messages),FirstTS:messages[0].TS,LastTS:messages[len(messages)-1].TS,ModelRequests:1}
 if decision.Decision=="wait"{return obs,nil}
 allowed:=map[string]segmentSource{};for _,m:=range messages{allowed[m.TS]=m}
 marker:=segmentSummaryMarker(channel,obs.FirstTS,obs.LastTS,obs.SourceSHA256,model,effort,profile)
 synthesis:=marker+"\n"+strings.TrimSpace(decision.Summary)
 c,ts,err:=p.Slack().PostMessageContext(ctx,channel,slack.MsgOptionText(synthesis,false))
 obs.SlackWrites++
 if err!=nil{return obs,err};obs.SummaryTS=ts
 got,err:=p.Slack().GetConversationHistoryContext(ctx,&slack.GetConversationHistoryParameters{ChannelID:c,Oldest:ts,Latest:ts,Inclusive:true,Limit:1});obs.SlackReads++
 if err!=nil||len(got.Messages)!=1||got.Messages[0].Text!=synthesis{
  return obs,fmt.Errorf("summary publication was not read back exactly; originals retained")
 }
 deletes:=map[string]string{}
 for _,d:=range decision.Delete{
  src,ok:=allowed[d.TS];if !ok||d.Reason==""{continue}
  // Do not destroy source that has independent structure the summary cannot
  // faithfully replace. Threads/files/attachments remain native Slack source.
  if src.ReplyCount>0||src.ThreadTS!=""||src.HasFiles||src.HasAttachments{continue}
  deletes[d.TS]=d.Reason
 }
 // At most twenty destructive message operations per source-confirmed segment.
 // Later cycles retain the same summary marker and can compact another segment.
 ordered:=make([]string,0,len(deletes));for ts:=range deletes{ordered=append(ordered,ts)};sort.Strings(ordered)
 if len(ordered)>20{ordered=ordered[:20]}
 api,ok:=p.Slack().(interface{Administration()*slack.Client});if !ok{return obs,fmt.Errorf("Slack administration client unavailable; summary retained")}
 admin:=api.Administration()
 for _,sourceTS:=range ordered{
  src:=allowed[sourceTS]
  check,e:=p.Slack().GetConversationHistoryContext(ctx,&slack.GetConversationHistoryParameters{ChannelID:channel,Oldest:sourceTS,Latest:sourceTS,Inclusive:true,Limit:1});obs.SlackReads++
  if e!=nil||len(check.Messages)!=1||check.Messages[0].Text!=src.Text{obs.Retained++;continue}
  select{case <-ctx.Done():return obs,ctx.Err();case <-time.After(1200*time.Millisecond):}
  _,_,e=admin.DeleteMessageContext(ctx,channel,sourceTS);obs.SlackWrites++
  if e!=nil{obs.Retained++;continue};obs.Deleted++
 }
 obs.Retained=len(messages)-obs.Deleted
 return obs,nil
}

func runOneSegment(ctx context.Context,p *provider.ApiProvider,channel,model,effort,profile,instructions string,maxPages int)(segmentObservation,error){
 messages,_,pages,complete,err:=readChannelSource(ctx,p,channel,maxPages)
 obs:=segmentObservation{ChannelID:channel,CheckedAt:time.Now().UTC().Format(time.RFC3339),SourcePages:pages,SourceComplete:complete,SlackReads:pages}
 if err!=nil{obs.State="source_error";obs.Error=err.Error();return obs,err}
 minMessages:=parsePositiveEnv("COGNILODE_SLACK_SEGMENT_MIN_MESSAGES",6,1,100)
 if len(messages)<minMessages{obs.State="waiting_for_semantic_segment";obs.SourceMessages=len(messages);return obs,nil}
 decision,err:=completionDecision(ctx,channel,messages,model,effort,profile,instructions);if err!=nil{obs.State="completion_error";obs.SourceMessages=len(messages);obs.ModelRequests=1;obs.Error=err.Error();return obs,err}
 applied,err:=applySegment(ctx,p,channel,messages,decision,model,effort,profile)
 applied.SourcePages=pages;applied.SourceComplete=complete;applied.SlackReads+=pages
 return applied,err
}

func projectAutonomy(ctx context.Context)(map[string]any,[]string,error){
 endpoint:=strings.TrimSpace(os.Getenv("COGNILODE_PROJECTS_MCP_URL"));if endpoint==""{return nil,nil,fmt.Errorf("Unified Projects owner is not configured")}
 reconcile,err:=callMCPJSON(ctx,endpoint,"unified_projects_reconcile",map[string]any{});if err!=nil{return nil,nil,err}
 // Reconciliation is observational. Deeplink refresh updates only observed
 // native identities and never invents a Project or Slack channel.
 _,_ = callMCPJSON(ctx,endpoint,"unified_projects_refresh_deeplinks",map[string]any{})
 projects,err:=callMCPJSON(ctx,endpoint,"unified_projects_list",map[string]any{"view":"active"});if err!=nil{return reconcile,nil,err}
 channels:=map[string]bool{}
 var walk func(any)
 walk=func(v any){
  switch x:=v.(type){
  case map[string]any:
   for k,v:=range x{
    if (k=="slack_channel_id"||k=="channel_id") {
     if s,ok:=v.(string);ok&&strings.HasPrefix(s,"C"){channels[s]=true}
    }
    walk(v)
   }
  case []any: for _,v:=range x{walk(v)}
  }
 }
 walk(projects)
 out:=make([]string,0,len(channels));for ch:=range channels{out=append(out,ch)};sort.Strings(out)
 return reconcile,out,nil
}

func autonomyCycle(ctx context.Context,p *provider.ApiProvider,model,effort,profile string,maxPages int)([]segmentObservation,any,error){
 reconcile,channels,err:=projectAutonomy(ctx);if err!=nil{return nil,reconcile,err}
 maxChannels:=parsePositiveEnv("COGNILODE_SLACK_AUTONOMY_CHANNEL_LIMIT",12,1,100)
 if len(channels)>maxChannels{channels=channels[:maxChannels]}
 observations:=[]segmentObservation{}
 for _,channel:=range channels{
  one,e:=runOneSegment(ctx,p,channel,model,effort,profile,"",maxPages);observations=append(observations,one)
  if e!=nil&&ctx.Err()!=nil{return observations,reconcile,ctx.Err()}
  select{case <-ctx.Done():return observations,reconcile,ctx.Err();case <-time.After(500*time.Millisecond):}
 }
 return observations,reconcile,nil
}

func startSlackAutonomy(p *provider.ApiProvider,logger *zap.Logger){
 if os.Getenv("COGNILODE_SLACK_AUTONOMY")!="1"{return}
 slackAutonomyOnce.Do(func(){go func(){
  interval:=time.Duration(parsePositiveEnv("COGNILODE_SLACK_AUTONOMY_INTERVAL_SECONDS",180,30,3600))*time.Second
  model:=strings.TrimSpace(os.Getenv("COGNILODE_SLACK_SUMMARY_MODEL"));if model==""{model="gpt-5.6-luna"}
  effort:=strings.TrimSpace(os.Getenv("COGNILODE_SLACK_SUMMARY_REASONING"));if effort==""{effort="medium"}
  profile:=strings.TrimSpace(os.Getenv("COGNILODE_SLACK_SUMMARY_PROFILE"));if profile==""{profile="slack-conversation-segment"}
  pages:=parsePositiveEnv("COGNILODE_SLACK_AUTONOMY_MAX_PAGES",10,1,100)
  slackAutonomy.Lock();slackAutonomy.Running=true;slackAutonomy.StartedAt=time.Now().UTC().Format(time.RFC3339);slackAutonomy.Unlock()
  for {
   started:=time.Now().UTC();ctx,cancel:=context.WithTimeout(context.Background(),interval-time.Second)
   observations,reconcile,err:=autonomyCycle(ctx,p,model,effort,profile,pages);cancel()
   slackAutonomy.Lock();slackAutonomy.LastRunAt=started.Format(time.RFC3339);slackAutonomy.NextRunAt=started.Add(interval).Format(time.RFC3339);slackAutonomy.Channels=observations;slackAutonomy.LastProjectReconcile=reconcile
   if err!=nil{slackAutonomy.LastError=err.Error();logger.Warn("Slack autonomy cycle incomplete",zap.Error(err))}else{slackAutonomy.LastError=""}
   slackAutonomy.Unlock();time.Sleep(time.Until(started.Add(interval)))
  }
 }()})
}

func registerSlackAutonomy(s *mcpserver.MCPServer,p *provider.ApiProvider,logger *zap.Logger){
 s.AddTool(mcp.NewTool("conversations_segment_run",
  mcp.WithDescription("Run the complete semantic conversation-segment summarizer on one Slack channel. The existing shared completion owner chooses meaning; this server keeps no model client or second corpus. It publishes a source-range/digest-bound summary before any deletion, reads the summary back, and deletes only model-selected ordinary messages whose exact text is unchanged. Threads/files/attachments remain source. Requested model, reasoning and prompt profile are explicit."),
  mcp.WithReadOnlyHintAnnotation(false),
  mcp.WithString("channel_id",mcp.Required()),mcp.WithString("model",mcp.Required()),mcp.WithString("reasoning_effort",mcp.Required()),mcp.WithString("prompt_profile",mcp.Required()),mcp.WithString("instructions"),mcp.WithNumber("max_pages")),
  func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){
   segmentRunMu.Lock();defer segmentRunMu.Unlock()
   channel,e:=cogChannel(p,r.GetString("channel_id",""));if e!=nil{return nil,e}
   pages:=r.GetInt("max_pages",20);if pages<1{pages=1};if pages>100{pages=100}
   obs,e:=runOneSegment(ctx,p,channel,r.GetString("model",""),r.GetString("reasoning_effort",""),r.GetString("prompt_profile",""),r.GetString("instructions",""),pages)
   if e!=nil{obs.Error=e.Error()};return cogJSON(obs),nil
  })
 s.AddTool(mcp.NewTool("conversations_autonomy_now",
  mcp.WithDescription("Run one source-complete autonomous Slack context cycle over canonical active Unified Project channels: reconcile Project mirrors, refresh observed deeplinks, then semantically compact only channels returned by the authoritative active Project owner. No channel-name guess becomes lifecycle authority. Limited Slack/model calls are reported as resource cost."),
  mcp.WithReadOnlyHintAnnotation(false),
  mcp.WithString("model",mcp.Required()),mcp.WithString("reasoning_effort",mcp.Required()),mcp.WithString("prompt_profile",mcp.Required()),mcp.WithNumber("max_pages")),
  func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){
   segmentRunMu.Lock();defer segmentRunMu.Unlock()
   pages:=r.GetInt("max_pages",10);if pages<1{pages=1};if pages>100{pages=100}
   observations,reconcile,e:=autonomyCycle(ctx,p,r.GetString("model",""),r.GetString("reasoning_effort",""),r.GetString("prompt_profile",""),pages)
   result:=map[string]any{"project_reconcile":reconcile,"channels":observations,"limited_quota_is_cost":true}
   if e!=nil{result["error"]=e.Error()};return cogJSON(result),nil
  })
 s.AddTool(mcp.NewTool("conversations_autonomy_status",
  mcp.WithDescription("Read the autonomous Slack context steward's last real source/model/Slack outcomes and next run. This makes Slack/model request usage visible as resource cost; it issues no provider request."),
  mcp.WithReadOnlyHintAnnotation(true)),
  func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){slackAutonomy.RLock();defer slackAutonomy.RUnlock();return cogJSON(slackAutonomy),nil})
 startSlackAutonomy(p,logger)
}
