# Comments on agent messages

> **T3-CUSTOM(expbkt3):** This feature is maintained as an experimental,
> upstream-isolated extension. See the
> [customization boundary registry](../operations/expbkt3-customizations.md).

Leave review comments on exact words in an agent's message, the way you would on
a plan or a pull request. Open comments travel to the agent with every message
you send until you resolve them, so a note like "reuse the existing column" keeps
its place in the conversation instead of getting lost in the next prompt.

Turn it on or off in **Settings → BK Add-ons → Chat comments**. It is on by
default. While it is off, the selection actions, highlights, the Comments panel
entry and the composer strip are hidden on that device; comments that are already
open still reach the agent until they are resolved.

## Starting a comment

Select text within one assistant message. Beside **Cite**, the selection toolbar
offers four actions:

- **Comment** opens a small box quoting the selection — `⌘/Ctrl+Enter` adds,
  `Esc` cancels.
- **Good**, **Okay** and **Remove** file a comment in one click, with no text:
  keep this as it is, acceptable as it is, drop this.

Each comment highlights the words it points at (amber for a comment, green for
good, grey for okay, red with a strike-through for remove) and adds a small
numbered pin at the end of the quote. While a comment is unresolved, a bar in the
message's left edge marks its lines and a bubble at the message's top-right
counts what still needs handling — amber while something is open, blue once the
agent has addressed everything. Clicking any of them opens the comment's card in
the panel; resolved comments fade to a faint highlight with no markers.

Comments and replies are Markdown, rendered like chat messages: bold, italics,
code, lists and links work, and links open the way chat links do. In the comment
box and the reply box, `⌘/Ctrl+B` bolds the selection, `⌘/Ctrl+I` italicises it,
`⌘/Ctrl+E` makes it inline code and `⌘/Ctrl+K` turns it into a link.

## The Comments panel

**Comments** sits beside Browser and Files in the right panel. It lists every
comment under the message it quotes, with its author, state, quote and any
replies. Hovering a card brightens its highlight in the chat; clicking a card
scrolls the conversation to the quote.

A comment is **Open** until someone acts on it. When the agent answers, the card
reads **Agent replied**, and when the agent says it has dealt with it the card
reads **Addressed** — nothing is closed until you say so. **Resolve** closes a
comment (and **Reopen** brings it back); **Resolve addressed** closes every
comment the agent has marked addressed, and **Resolve all** closes every
unresolved one. The filter row shows **Open** (everything unresolved),
**Unaddressed**, **Addressed**, **Resolved** and **All**, each with its count. Deleting a comment from its ⋯ menu removes it entirely. **Reply** adds to
the thread under a comment, and the agent sees the replies too.

## What the agent does with open comments

Each open comment goes to the agent once, with your next message: quoted with
your note, plus the instruction to act on it or answer it. The agent can reply
under a comment and mark it addressed; only you resolve. A comment goes again
when you edit it, reply to it or reopen it.

While some comments are not sent yet, a strip above the composer says how many.
**Review** opens the panel. **Send now** sends just the comments and leaves your
draft as it is; while the agent is working, they wait for its turn to end.
Pressing Enter on a typed message sends the comments with it, and an empty
message is allowed too: the agent is simply asked to work through them.

After the comments go, the strip leaves and a chip in the top-right corner of the
composer keeps count: blue while the agent has them, green once it has addressed
some. Its menu has **Address remaining** (sends the open comments again and asks
the agent to finish them), **Ask for an update** (sends them again and asks where
each one stands, without new changes), **Review comments**, **Resolve
addressed**, and **Pause sending**.

**Don't send** (in the strip) or **Pause sending** (in the chip) pauses delivery
for the thread — the strip then reads "paused — not sent" and the agent stops
receiving the comments until you press **Resume**. The comments stay open in the
panel either way.

## Where it applies

Comments are available in the web and desktop apps, on threads whose server
supports them. Mobile shows the conversation as usual but does not create or list
comments yet.
