package provider

import "github.com/slack-go/slack"

// Reuse this upstream provider's authenticated session, HTTP transport and SDK.
// Administrative extensions must not construct a second Slack client/requester.
func (c *MCPSlackClient) Administration() *slack.Client { return c.slackClient }
