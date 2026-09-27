const SCP_GITHUB_REMOTE = /^git@(github\.com|ssh\.github\.com):([^/\s]+)\/([^/\s]+)$/i;

function repositoryParts(remoteUrl: string): readonly [string, string] | null {
  const scpMatch = SCP_GITHUB_REMOTE.exec(remoteUrl);
  if (scpMatch?.[2] && scpMatch[3]) {
    return [scpMatch[2], scpMatch[3]];
  }
  if (!remoteUrl.toLowerCase().startsWith("ssh://")) {
    return null;
  }
  try {
    const parsed = new URL(remoteUrl);
    if (
      parsed.username !== "git" ||
      (parsed.hostname.toLowerCase() !== "github.com" &&
        parsed.hostname.toLowerCase() !== "ssh.github.com")
    ) {
      return null;
    }
    const [owner, repository, ...rest] = parsed.pathname.split("/").filter(Boolean);
    return owner && repository && rest.length === 0 ? [owner, repository] : null;
  } catch {
    return null;
  }
}

export function githubSshRemoteToHttps(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const parts = repositoryParts(trimmed);
  const owner = parts?.[0];
  const repository = parts?.[1].replace(/\.git$/i, "");
  return owner && repository ? `https://github.com/${owner}/${repository}.git` : null;
}

export function isGitHubSshRemote(remoteUrl: string): boolean {
  return githubSshRemoteToHttps(remoteUrl) !== null;
}
