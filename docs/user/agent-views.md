# Agent views in chat

> **T3-CUSTOM(expbkt3):** This feature is maintained as an experimental,
> upstream-isolated extension. See the
> [customization boundary registry](../operations/expbkt3-customizations.md).

An agent can render a small interactive view directly in the conversation: a
chart, a diagram, a table, a form, a preview. The view appears inline, in the
place where the agent produced it, rather than as a file you have to open.

Ask for something visual — "chart the request latency by endpoint", "show me the
migration order as a diagram", "lay these options out side by side" — and the
agent decides whether a view says it better than text.

## What a view is

Each view is a box in the transcript with a title bar you can collapse. Inside
is a document the agent wrote, rendered in a sandbox:

- Its styles and scripts run, so charts, tabs and hover states work.
- It cannot reach T3 Code, your session, your cookies, or the network as you.
- It cannot navigate the app or read anything outside its own box.

Select the title to expand a view over the transcript, and **Close** or `Esc` to
put it back. The composer stays usable while a view is expanded.

Agent-written documents are snapshots. When an agent shows you an updated
version it appears as a new box further down the conversation, so scrolling back
still shows what it produced at that point in the work.

## Embedded web pages are not available

An agent can only show you a document it wrote itself. Asking it to embed a page
by its `https` address leaves an ordinary collapsed tool row instead.

Some live collaboration apps deliberately disable room bootstrap whenever they
run inside an iframe. In that state, a room URL can display data cached for the
app's origin instead of joining the room named by the URL — a box that looks
right and shows the wrong thing. Until T3 can tell the difference, it does not
render URL targets at all, rather than special-casing an app or domain,
rewriting URL fragments, or weakening the iframe sandbox.

## Turning it off

**Settings → Experiments → Agent views in chat.** While it is off, an agent that
tries to show a view leaves an ordinary collapsed tool row instead, and nothing
is rendered. The setting is per client, so turning it off on your laptop does not
change what you see on your phone.

## Limits

- One view is capped at roughly 256,000 characters. An agent that needs more is
  told to render something smaller.
- Height is capped, so a view cannot take over the transcript.
- Views are stored with the session and are removed when the session's data is
  reclaimed.
