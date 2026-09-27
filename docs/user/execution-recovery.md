# Recovering Interrupted Work

T3 Code saves an accepted message before an agent starts it. If the server or provider restarts,
the thread stays visible and T3 Code tries to continue the accepted work automatically.

The status beneath the thread tells you what is happening:

- **Sending** means the message is saved on this device but the server has not accepted it yet.
- **Queued**, **Preparing**, or **Starting** means the server has accepted it.
- **Running** means the provider confirmed the turn.
- **Recovering** or **Retrying** means T3 Code is restoring interrupted work.
- **Recovery failed** means automatic recovery stopped and needs your attention.

T3 Code makes up to ten recovery attempts. It checks the existing provider conversation and
workspace before continuing so it does not blindly repeat an original request that may already have
started.

When recovery fails, choose **Retry** to start a fresh recovery budget or **Dismiss** to clear the
attention item without deleting the conversation or its history. Sending a new message creates new
work and does not reuse the failed item.

Stopping a thread cancels queued work and prevents an older recovery attempt from starting it again.
An approval or requested input is never answered automatically after a restart; return to the thread
and respond when prompted.

Messages waiting in **Sending** are scoped to the current environment and account. They are retried
with the same identity after reconnection. Removing an environment also removes its unsent messages;
T3 Code warns before doing so.
