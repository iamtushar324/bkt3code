# Opening a Worktree in Another App

The **Open** button in a thread's header opens that thread's project or worktree outside T3 Code — in your editor, and in any other app you configure.

## When the Work Is on Another Machine

Most remote setups run the server on one machine (a dev box) and the app on another (your laptop). The folder you want to open only exists on the server, so T3 Code does not try to launch an editor there. Instead it hands your own machine a link that opens the folder over SSH.

VS Code, VS Code Insiders, VSCodium, and Cursor all support this. Pick one from the **Open** menu and it connects to the server and opens the worktree.

Three things have to be true for that to work:

- **Your editor is installed on the machine you are looking at.** The desktop app detects which of them you have; a browser cannot, so it offers VS Code.
- **The server accepts SSH connections.** T3 Code only offers the link when the server can see its own SSH service running. Otherwise the menu says "No SSH route".
- **Your SSH key is authorized on the server.** Nothing in T3 Code can grant this for you — the first connection uses your normal SSH setup.

The server tells the app which name to connect to, preferring its tailnet name (which works from anywhere on the tailnet) over `machine.local` (same network only). It also sends the account its own server runs as, so the link logs in as the right user. Each machine reports its own name and account, so several servers with different logins all work without configuring anything per machine.

If your SSH config already defines a host for that machine, add the environment as an SSH connection rather than a URL. T3 Code then reuses that host entry, including its user, port, and key.

## Obsidian, Finder, and Other Apps

Editors know how to reach another machine over SSH. Most apps do not: Obsidian and your file manager can only open a folder that exists on the machine you are sitting at. To use them against a remote worktree, tell T3 Code where that folder appears locally.

Go to **Settings → General → Open in… targets**. Add a target with a starting point (Obsidian, Finder, or Zed over SSH) or build your own, then fill in:

- **Menu label** — what the Open menu calls it.
- **URL template** — the link that opens the app, with `{path}` where the folder goes. `{host}` and `{user}` are also available. For example `obsidian://open?path={path}`.
- **Path mappings** — for remote environments, the folder on the server and the matching folder on your machine. If the server keeps worktrees under `/srv/worktrees` and you sync them to `~/Mirror`, that is the pair. Leave **Only for host** empty to apply it everywhere, or name a host to give one machine its own mapping.
- **Needs a local path** — on for apps that can only see your machine, which is most of them. Turn it off for an app that connects over SSH itself, such as Zed, and it receives the server's own path.

Targets appear in the **Open** menu under your editors. On a local server the path is used as it is, so no mapping is needed. On a remote one, a target whose path cannot be mapped is greyed out and says so, rather than opening a folder that is not there.

A file manager target only works in the desktop app; a browser cannot open a folder on your disk.

For connection setup, see [Remote access](./remote-access.md).
