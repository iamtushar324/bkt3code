# Provider Usage Limits

The experimental control-center header can show the subscription usage limits reported by Codex
and Claude. The two compact rows appear beside the session counters on web and desktop when there
is room. On a narrower sidebar, the complete widget wraps below the T3 Code brand and remains
clipped to the sidebar boundary.

Use **Settings → Experimental → Provider usage limits** to show or hide the widget. This is a
client-local preference and does not disable collection on the server or affect another client.

Each row shows the lowest remaining percentage among the provider's active quota windows. A green
bar has at least 50% remaining, amber has 20–49%, and red has less than 20%. Select the widget to
see every reported window, its reset time in your local timezone, and when T3 Code last observed
the reading. A subtle gray track and border remain visible behind the fill, including when a bar is
at 100%, so the complete 32 px range is always clear.

The limits belong to the environment for the active thread or route. When no environment is
active, T3 Code uses the primary environment. Disabled providers are omitted. An em dash means the
provider is enabled but has not supplied a current subscription reading.

## Freshness and availability

The indicator updates when an active provider runtime reports new information. The client keeps the
last successful normalized reading in browser-local storage for each environment. If a provider is
temporarily unavailable, its last percentage remains visible in gray and the details identify it as
cached. Readings older than ten minutes, failed refreshes, and quota windows whose reset time has
passed are also shown in gray as awaiting a refresh. T3 Code does not assume that a reset restored
100% of the quota.

T3 Code does not keep Codex or Claude running only to refresh the header, so usage from another
device might not appear until the next provider activity. A confirmed API-key session clears any
cached subscription reading for that provider rather than presenting it as applicable.

These percentages describe subscription limits for Codex and Claude Code. They do not describe
OpenAI Platform or Anthropic API-key billing, organization spend, or request-rate ceilings. API-key
sessions show that subscription limits are unavailable.

The widget is display-only. Provider selection remains manual, and it does not change the provider
for a thread or composer.
