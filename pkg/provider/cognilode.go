package provider

import "github.com/slack-go/slack"

// Reuse this upstream provider's authenticated session, HTTP transport and SDK.
// Administrative extensions must not construct a second Slack client/requester.
func (c *MCPSlackClient) Administration() *slack.Client { return c.slackClient }

// Update only the affected cached channel after a mutation. Do not turn one
// rename into a fresh workspace-wide inventory or silently clobber a refresh.
func (ap *ApiProvider) RememberChannel(ch *slack.Channel) {
 if ch==nil{return}
 for {
  old:=ap.channelsSnapshot.Load();next:=&ChannelsCache{Channels:map[string]Channel{},ChannelsInv:map[string]string{}}
  if old!=nil{for k,v:=range old.Channels{next.Channels[k]=v};for k,v:=range old.ChannelsInv{next.ChannelsInv[k]=v};if before,ok:=old.Channels[ch.ID];ok{delete(next.ChannelsInv,before.Name)}}
  next.Channels[ch.ID]=mapChannel(ch.ID,ch.Name,ch.NameNormalized,ch.Topic.Value,ch.Purpose.Value,ch.User,ch.Members,ch.NumMembers,ch.IsIM,ch.IsMpIM,ch.IsPrivate,ch.IsExtShared,ap.ProvideUsersMap().Users)
  next.ChannelsInv[ch.Name]=ch.ID
  if ap.channelsSnapshot.CompareAndSwap(old,next){return}
 }
}
