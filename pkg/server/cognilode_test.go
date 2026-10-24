package server

import (
 "encoding/csv"
 "strings"
 "testing"
 "github.com/mark3labs/mcp-go/mcp"
)

func TestRenderedConversationKeepsCompleteMultilineSource(t *testing.T){
 body:="A quoted instruction: \"keep the whole message\"\n"+strings.Repeat("substantive source text ",12000)+"\nTHE ACTUAL END"
 var csvBody strings.Builder;w:=csv.NewWriter(&csvBody)
 _=w.Write([]string{"MsgID","RealName","Time","ThreadTs","Text","Cursor","AttachmentIDs"});_=w.Write([]string{"123.456","Colleague","2026-10-24","123.000",body,"next-native-page","file-123"});w.Flush()
 result,e:=renderConversation(mcp.NewToolResultText(csvBody.String()));if e!=nil{t.Fatal(e)}
 text:=result.Content[0].(mcp.TextContent).Text
 for _,want:=range []string{body,"next-native-page","file-123","123.456"}{if !strings.Contains(text,want){t.Fatalf("source or continuation lost: %.80s",want)}}
}
func TestRenderedConversationDoesNotHideUpstreamError(t *testing.T){
 source:=mcp.NewToolResultError("rate limited; Retry-After retained by upstream")
 result,e:=renderConversation(source);if e!=nil||result!=source||!result.IsError{t.Fatal("provider error was hidden")}
}
