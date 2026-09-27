# Plan review

> **T3-CUSTOM(expbkt3):** This feature is maintained as an experimental,
> upstream-isolated extension. See the
> [customization boundary registry](../operations/expbkt3-customizations.md).

When an agent proposes a plan, you can open it in a side panel, comment on exact
lines, edit it, and send the result back — without the agent re-reading the whole
plan every round.

Turn it on or off in **Settings → Beta features → Native plan review**. It is on
by default. While it is off, plan review goes through Plannotator only.

## Opening a plan

Two ways in, both of which appear once an agent has proposed a plan that has not
been implemented yet:

- **Preview** on the plan card in the conversation.
- A floating **Open the plan in preview** button above the composer.

The panel opens beside the chat as a tab, so the conversation stays visible. Use
the maximise control in the panel header for a full-width read.

## Commenting

Select any text in the plan and choose **Comment**. The selection highlights as
soon as you start, and a comment box opens under the plan, quoting what you
selected — `⌘/Ctrl+Enter` saves, `Esc` cancels. Your place in the plan is not
disturbed, and the box grows as you write, up to a third of the window, so a
longer comment stays readable while you write it.

The comment is anchored to the exact lines you selected, and those lines are
quoted back to the agent when you send feedback — the rest of the plan is not
repeated.

Saved comments keep an amber highlight on the text they point at, so you can see
what has already been commented on without reading the rail. Hovering or clicking
a comment in the rail brightens its highlight and scrolls to it; clicking a
highlight selects its comment in the rail. Highlights survive closing and
reopening the panel, and a teammate's comments are highlighted too.

For the two things you say most often there is no need to type: the selection
toolbar also carries a 👍 (**Looks good**) and a **Remove this** button, each of
which files a comment in one click.

Comments appear in the rail beside the plan. **Resolve** a comment once it no
longer applies; resolved comments fade to a hairline in the document and are left
out of what gets sent.

## Finding your way around a long plan

When the panel is wide enough, a **Contents** rail lists the plan's headings with
a count of the open comments in each section — so you can see at a glance which
parts you have been through. Selecting a heading scrolls to it. Narrow the panel
and the rail gets out of the way, because the plan itself needs the width.

## Editing

The panel edits the plan directly. **Suggest edits** is on by default, so your
changes are recorded as tracked changes attributed to you rather than silently
overwriting what the agent wrote. Turn it off to edit in place.

**Save version** records your edits as a new version without sending anything.
While you have unsaved edits, **Save the plan** replaces the decision buttons:
approving or sending feedback on a plan whose edits are not yet a version leaves
it ambiguous which text was actually agreed, so saving comes first.

If two people edit the same plan at once, the second save is refused with a
notice rather than overwriting the first. Reload the panel to pick up their
changes.

## Versions

The **Versions** tab lists every revision of the plan in order, each with its
author — the agent, you, or a teammate — and when it was made. Select any two
versions to see what changed between them. **Restore** brings an older version
back as a new version; history is never rewritten.

The list is one continuous history: when you send feedback and the agent
rewrites the plan, its revision lands in the same list rather than starting a new
one.

## Sending the result

- **Approve** starts implementation. The agent is told the plan is approved
  rather than being sent the plan again, because it already has it. If you edited
  the plan first, only your changes are sent. In the few cases where the agent
  genuinely cannot see the plan any more — the session compacted its context
  after the plan was written, or it is no longer running — the full plan is
  repeated, and the confirmation says so.
  - With open comments the button reads **Approve with comments**. Implementation
    still starts; your comments travel as refinements to apply along the way,
    rather than as a request to go back and re-plan.
- **Send feedback** asks for a revision. The agent receives your comments with
  the lines they point at, plus a diff of any edits you made — not the document.
- **Discard** closes the review without telling the agent anything.

**Send feedback** only appears once there is something to send — an open comment,
a note, or an edit — so **Approve** is the single obvious action on a plan you
agree with.

**Add an overall note** above the buttons opens a box for anything you want to
say about the plan as a whole; it is sent with either decision. It is not the
chat bar along the bottom of the panel — a chat message is its own turn, while
the note travels with Approve or Send feedback. Once the note has text it stays
open, so nothing you typed is sent invisibly or left behind.

Whatever you send, each anchored comment reaches the agent as a card quoting the
lines it points at, followed by your note.

## Which plans this applies to

Plan review works on plans produced by T3's normal plan mode, for any provider
that supports it. Only the newest plan on a session that has not been implemented
yet is reviewable. Once a plan is approved and implementation starts, its review
becomes read-only history.

Plan review is available in the web and desktop apps. On mobile, plan decisions
appear in the session history but the panel itself is not available yet.
