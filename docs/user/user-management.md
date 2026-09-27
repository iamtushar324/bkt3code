# User management

Shared T3 Code environments can connect each signed-in Clerk account to a durable environment user.
Open **Settings → Users** on web, desktop, or mobile to see who has connected, whether they are
online, their role and status, their active session count, and their assigned GitHub identity.

## Enable signed-in users

An environment administrator can turn on **Require Clerk identity**. Once enabled, new browser,
desktop, and mobile sessions must include a valid Clerk session. Existing sessions that are not
linked to a Clerk user are signed out and must reconnect.

The first Clerk user admitted through an administrative environment bootstrap becomes the initial
administrator. Later users join as members. Administrators can then manage users from any connected
web, desktop, or mobile client. Administrators can:

- promote a member or demote an administrator;
- block or unblock a user;
- sign a user out of every environment session;
- add and maintain GitHub profiles;
- connect one GitHub profile to each user;
- enable required Clerk identity and owner-based GitHub attribution.

T3 Code prevents demoting or blocking the last active administrator. Blocking a user immediately
revokes that user's environment sessions. Clerk controls the person's sign-in account; the T3
environment controls their local role, status, sessions, and GitHub profile assignment.

## Presence and sessions

**Online** means at least one of the user's T3 environment sessions currently has a WebSocket
connection. Closing a browser or losing connectivity changes presence to **Offline**, but the
durable user remains in the directory. **Sign out devices** revokes every active environment session
for that user; it does not delete their Clerk account.

On web, open **Settings** and choose **Log out** in the Settings sidebar footer to end only the
current browser session. T3 revokes the environment session, clears its browser cookie, signs out
of Clerk, and returns to the sign-in screen. Other devices and browser sessions remain connected.

## Connect GitHub attribution

Administrators create GitHub profiles in **Settings → Users → GitHub profiles**. Each profile needs
an expiring fine-grained personal access token, a Git commit name, and a verified GitHub email or
GitHub-provided noreply email. Tokens are write-only and are stored in the environment's server
secret store.

Assign exactly one profile to each user, then enable **Use each thread owner's GitHub identity**.
The user who creates a thread becomes its owner automatically. Commits, pushes, pull requests,
reviews, integrated terminals, and locally managed agents use the profile currently assigned to
that durable owner. A profile can be assigned to only one user. Thread ownership controls
attribution, not access: trusted collaborators may still work in or transfer another person's
thread, and future GitHub activity switches to the new owner's profile after a transfer.

Sessions created by a trusted external integration follow the same rule when the integration
identifies the initiating T3 user. For example, a new Linear agent session is owned immediately by
the matched human starter, before its first provider turn begins. Existing externally created
threads are not reassigned; reconciliation may add their starter as a member without changing the
durable owner.

If a user is blocked, a token is disconnected, or a thread has no valid owner, authenticated GitHub
operations fail instead of falling back to a machine-wide account.
