import { CheckCircle2Icon, GithubIcon, PlusIcon, UnplugIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { GitHubSourceControlProfile, SourceControlProfileId } from "@t3tools/contracts";

import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { githubProfileActionErrorMessage } from "./GitHubProfilesSettings.logic";
import { SettingsSection } from "./settingsLayout";

interface ProfileDraft {
  readonly label: string;
  readonly gitName: string;
  readonly gitEmail: string;
  readonly credential: string;
}

const EMPTY_DRAFT: ProfileDraft = {
  label: "",
  gitName: "",
  gitEmail: "",
  credential: "",
};

function credentialBadge(profile: GitHubSourceControlProfile) {
  switch (profile.credentialStatus) {
    case "connected":
      return <Badge>Connected</Badge>;
    case "invalid":
      return <Badge variant="destructive">Invalid</Badge>;
    case "missing":
      return <Badge variant="outline">Disconnected</Badge>;
  }
}

export function GitHubProfilesSettingsSection(props: { readonly disabled?: boolean }) {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const profilesQuery = useEnvironmentQuery(
    environmentId === null ? null : sourceControlEnvironment.profiles({ environmentId, input: {} }),
  );
  const upsertProfile = useAtomCommand(sourceControlEnvironment.upsertProfile, {
    reportFailure: false,
  });
  const testProfile = useAtomCommand(sourceControlEnvironment.testProfile, {
    reportFailure: false,
  });
  const replaceCredential = useAtomCommand(sourceControlEnvironment.replaceProfileCredential, {
    reportFailure: false,
  });
  const disconnectProfile = useAtomCommand(sourceControlEnvironment.disconnectProfile, {
    reportFailure: false,
  });
  const archiveProfile = useAtomCommand(sourceControlEnvironment.archiveProfile, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [replacementTokens, setReplacementTokens] = useState<Record<string, string>>({});
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const profiles = profilesQuery.data?.profiles ?? [];
  const canCreate = useMemo(
    () =>
      draft.label.trim().length > 0 &&
      draft.gitName.trim().length > 0 &&
      draft.gitEmail.trim().length > 0 &&
      draft.credential.trim().length > 0,
    [draft],
  );

  const run = async <A, E>(key: string, action: () => Promise<AtomCommandResult<A, E>>) => {
    setPendingAction(key);
    setActionError(null);
    const result = await action();
    setPendingAction(null);
    const errorMessage = githubProfileActionErrorMessage(result);
    if (errorMessage !== null) {
      setActionError(errorMessage);
      return false;
    }
    profilesQuery.refresh();
    return true;
  };

  const createProfile = async () => {
    if (environmentId === null || !canCreate) return;
    const succeeded = await run("create", () =>
      upsertProfile({
        environmentId,
        input: {
          label: draft.label.trim(),
          gitName: draft.gitName.trim(),
          gitEmail: draft.gitEmail.trim(),
          credential: draft.credential.trim(),
        },
      }),
    );
    if (succeeded) setDraft(EMPTY_DRAFT);
  };

  const profileAction = (
    profileId: SourceControlProfileId,
    action: "test" | "disconnect" | "archive" | "restore" | "replace",
  ) => {
    if (environmentId === null) return Promise.resolve();
    const key = `${action}:${profileId}`;
    if (action === "replace") {
      const credential = replacementTokens[profileId]?.trim() ?? "";
      if (!credential) return Promise.resolve();
      return run(key, () =>
        replaceCredential({ environmentId, input: { profileId, credential } }),
      ).then((succeeded) => {
        if (succeeded) setReplacementTokens((current) => ({ ...current, [profileId]: "" }));
      });
    }
    if (action === "test") {
      return run(key, () => testProfile({ environmentId, input: { profileId } })).then(() => {});
    }
    if (action === "disconnect") {
      return run(key, () => disconnectProfile({ environmentId, input: { profileId } })).then(
        () => {},
      );
    }
    return run(key, () =>
      archiveProfile({
        environmentId,
        input: { profileId, archived: action === "archive" },
      }),
    ).then(() => {});
  };

  if (environmentId === null) return null;

  return (
    <SettingsSection title="GitHub profiles">
      <div className="space-y-3 p-3">
        <p className="text-xs text-muted-foreground">
          Each thread uses one profile for commits, pushes, pull requests, reviews, and agent-run
          GitHub commands. Tokens are write-only and remain in the server secret store.
        </p>
        {profiles.map((profile) => (
          <div key={profile.id} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                {profile.avatarUrl ? (
                  <img
                    src={profile.avatarUrl}
                    alt=""
                    className="size-8 rounded-full"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <GithubIcon className="size-7 rounded-full border border-border p-1.5" />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{profile.label}</span>
                    {credentialBadge(profile)}
                    {profile.archived ? <Badge variant="outline">Archived</Badge> : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    @{profile.login} · {profile.gitName} &lt;{profile.gitEmail}&gt;
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {profile.ownerUserId ? "Assigned to a T3 user" : "Not assigned"}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={props.disabled || pendingAction !== null}
                  onClick={() => void profileAction(profile.id, "test")}
                >
                  <CheckCircle2Icon className="size-3" /> Test
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={props.disabled || pendingAction !== null}
                  onClick={() => void profileAction(profile.id, "disconnect")}
                >
                  <UnplugIcon className="size-3" /> Disconnect
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={props.disabled || pendingAction !== null}
                  onClick={() =>
                    void profileAction(profile.id, profile.archived ? "restore" : "archive")
                  }
                >
                  {profile.archived ? "Restore" : "Archive"}
                </Button>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Input
                nativeInput
                type="password"
                autoComplete="new-password"
                placeholder="Replace fine-grained PAT"
                value={replacementTokens[profile.id] ?? ""}
                onChange={(event) =>
                  setReplacementTokens((current) => ({
                    ...current,
                    [profile.id]: event.currentTarget.value,
                  }))
                }
              />
              <Button
                size="sm"
                variant="outline"
                disabled={
                  props.disabled ||
                  pendingAction !== null ||
                  !(replacementTokens[profile.id]?.trim().length ?? 0)
                }
                onClick={() => void profileAction(profile.id, "replace")}
              >
                Replace token
              </Button>
            </div>
          </div>
        ))}

        <div className="grid gap-3 rounded-lg border border-dashed border-border p-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="github-profile-label">Profile label</Label>
            <Input
              id="github-profile-label"
              nativeInput
              placeholder="Alice"
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.currentTarget.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="github-profile-name">Git commit name</Label>
            <Input
              id="github-profile-name"
              nativeInput
              placeholder="Alice Example"
              value={draft.gitName}
              onChange={(event) => setDraft({ ...draft, gitName: event.currentTarget.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="github-profile-email">Verified GitHub email</Label>
            <Input
              id="github-profile-email"
              nativeInput
              type="email"
              placeholder="alice@users.noreply.github.com"
              value={draft.gitEmail}
              onChange={(event) => setDraft({ ...draft, gitEmail: event.currentTarget.value })}
            />
            <p className="text-xs text-muted-foreground">
              Private emails require “Email addresses: read” on the PAT. A GitHub noreply email
              works without that permission.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="github-profile-token">Fine-grained PAT</Label>
            <Input
              id="github-profile-token"
              nativeInput
              type="password"
              autoComplete="new-password"
              placeholder="github_pat_…"
              value={draft.credential}
              onChange={(event) => setDraft({ ...draft, credential: event.currentTarget.value })}
            />
          </div>
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <p className="text-xs text-destructive">{actionError ?? profilesQuery.error}</p>
            <Button
              size="sm"
              disabled={props.disabled || !canCreate || pendingAction !== null}
              onClick={() => void createProfile()}
            >
              <PlusIcon className="size-3.5" /> Add profile
            </Button>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
