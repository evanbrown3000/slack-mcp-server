package server

import (
 "context"
 "encoding/json"
 "sync"
 "time"
 "github.com/korotovsky/slack-mcp-server/pkg/provider"
 "github.com/mark3labs/mcp-go/mcp"
 mcpserver "github.com/mark3labs/mcp-go/server"
)

// References and publication cursors belong to the native TaskFlow plan.
// This observer keeps no second plan store, Slack transcript or prompt queue.
var mirrorSyncOnce sync.Once
var mirrorSyncMutex sync.Mutex
func startTaskflowMirrorSync(s *mcpserver.MCPServer,p *provider.ApiProvider,base string,publish func(context.Context,mcp.CallToolRequest)(*mcp.CallToolResult,error)){
 syncNow:=func(ctx context.Context)(*mcp.CallToolResult,error){
  mirrorSyncMutex.Lock();defer mirrorSyncMutex.Unlock()
  b,e:=cogHTTP(ctx,base+"/api/taskflow/slack-mirrors","GET",nil);if e!=nil{return nil,e}
  var response struct{Mirrors []struct{Plan string `json:"plan_id"`;Channel string `json:"channel_id"`;Message string `json:"message_ts"`;Cursor int `json:"source_cursor"`;Published int `json:"last_published_cursor"`} `json:"mirrors"`};if e=json.Unmarshal(b,&response);e!=nil{return nil,e}
  outcomes:=[]map[string]any{}
  for _,item:=range response.Mirrors{
   if item.Cursor<=item.Published{continue}
   req:=mcp.CallToolRequest{};req.Params.Arguments=map[string]any{"plan_id":item.Plan,"channel_id":item.Channel,"message_ts":item.Message,"source_cursor":item.Cursor}
   result,err:=publish(ctx,req);if err!=nil{outcomes=append(outcomes,map[string]any{"plan_id":item.Plan,"error":err.Error()});continue};outcomes=append(outcomes,map[string]any{"plan_id":item.Plan,"result":result})
   select{case <-ctx.Done():return cogJSON(map[string]any{"outcomes":outcomes,"interrupted":true}),nil;case <-time.After(1500*time.Millisecond):}
  }
  return cogJSON(map[string]any{"mirrors":len(response.Mirrors),"outcomes":outcomes,"provider_prompts":0}),nil
 }
 s.AddTool(mcp.NewTool("taskflow_sync_now",mcp.WithDescription("Reconcile explicitly bound TaskFlow plan messages with current native plan/progress. The same observer runs every 30 seconds. Only changed source cursors cause Slack writes; source acknowledgements do not echo as new plan changes. No prompts or new scheduler."),mcp.WithReadOnlyHintAnnotation(false)),func(ctx context.Context,r mcp.CallToolRequest)(*mcp.CallToolResult,error){return syncNow(ctx)})
 mirrorSyncOnce.Do(func(){go func(){for{ctx,cancel:=context.WithTimeout(context.Background(),50*time.Second);_,_=syncNow(ctx);cancel();time.Sleep(30*time.Second)}}()})
}
