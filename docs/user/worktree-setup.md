# Worktree setup and new-thread defaults

T3 Code can prepare a new Git worktree before an agent receives its first message. Use this for
dependency installation, generated files, local configuration, or any other repeatable project
bootstrap step.

## Configure a setup action

1. Open **Settings → Projects** and expand the project.
2. Under **Worktree setup action**, select or create a project action.
3. Enter the command that makes a fresh checkout ready, such as `./tools/setup.sh`.

The action runs only when T3 creates a new worktree. It does not run for the project directory or
for an existing worktree path supplied by a user or integration. Keep the command idempotent so
Retry is safe after a partial run.

Only one action is used automatically. If older project data flags more than one action, T3 uses
the first and shows a warning until you save a single selection.

## Ship the setup action in the repository

A repository can declare its setup action in a `t3.json` file at the repository root, so everyone
who opens it gets a prepared worktree without configuring anything:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "scripts": [{ "name": "Bootstrap", "command": "./tools/setup.sh", "runOnWorktreeCreate": true }]
}
```

The checked-in action runs on every new worktree, with no import step, on every machine and server
where the repository is opened. A worktree setup action configured under **Settings → Projects**
always wins; the checked-in one is the fallback. T3 uses the first `t3.json` script flagged
`runOnWorktreeCreate`, and a missing or invalid `t3.json` simply means no setup action runs.

## Choose app and project defaults

The **New threads** app settings define the environment-local defaults for:

- Local project directory or a new worktree.
- Repository default branch from Local or Origin.
- Agent provider, model, and model options.
- Access mode.
- Build or Plan starting mode.

Each project can inherit those values or override them under **Settings → Projects**. A project can
select an exact local branch or exact `origin/*` branch. Origin choices are fetched and pinned to
the resolved remote commit when the worktree is created.

Explicit choices in the new-thread composer win over project settings, and project settings win
over the app settings on the environment that owns the project. A remote project therefore uses
its remote server's defaults. New threads do not copy the model, access, or Plan/Build mode from the
thread you were previously viewing. Use **Use project/app defaults** in the composer to clear fresh
thread overrides.

## Follow workspace preparation

After sending the first message, the thread opens immediately and shows these durable steps:

1. Creating the worktree, or using the project directory.
2. Running the setup script.
3. Starting the agent, or marking a prompt-free workspace ready.

The thread continues to identify a pending or failed new worktree as **New
worktree** until preparation finishes, including after reconnecting.

Setup output is hidden by default. Select **Show output** to open that setup attempt in the terminal
panel. Interactive prompts can be answered there; closing the panel does not stop the command.

If setup fails, its worktree and terminal history remain available. Choose **Retry** after fixing
the action, **Continue anyway** to start the pending agent turn without successful setup, or **Stop
setup** while it is still running. A worktree creation failure cannot be bypassed; retry it or
change the base ref.

Preparation continues if the browser disconnects. If the server restarts during setup, the setup
step becomes an interrupted failure and waits for Retry or Continue instead of running again
automatically.
