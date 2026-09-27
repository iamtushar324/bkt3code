import { useAuth, useClerk, useUser } from "@clerk/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ShieldCheckIcon, UserRoundIcon, UsersIcon } from "lucide-react";

import type { EnvironmentUser, SourceControlProfileId } from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { resolveAppClerkMode } from "../../cloud/publicConfig";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { isElectron } from "../../env";
import { bindPrimaryEnvironmentClerkIdentity } from "../../environments/primary";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { userManagementEnvironment } from "../../state/users";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { GitHubProfilesSettingsSection } from "./GitHubProfilesSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function userLabel(user: EnvironmentUser): string {
  return user.displayName ?? user.primaryEmail ?? user.id;
}

function ClerkIdentityBootstrap({ onBound }: { readonly onBound: () => void }) {
  const clerk = useClerk();
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const { user } = useUser();
  const onBoundRef = useRef(onBound);
  const boundUserRef = useRef<string | null>(null);
  const [bindingState, setBindingState] = useState<"idle" | "binding" | "bound" | "error">("idle");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    onBoundRef.current = onBound;
  }, [onBound]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId || boundUserRef.current === userId) return;

    let cancelled = false;
    boundUserRef.current = userId;
    setBindingState("binding");
    void (async () => {
      try {
        const identityToken = await getToken();
        if (!identityToken) throw new Error("Clerk did not issue an identity token.");
        await bindPrimaryEnvironmentClerkIdentity(identityToken);
        if (cancelled) return;
        setBindingState("bound");
        onBoundRef.current();
      } catch {
        if (cancelled) return;
        boundUserRef.current = null;
        setBindingState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt, getToken, isLoaded, isSignedIn, userId]);

  if (!isLoaded) {
    return <p className="text-xs text-muted-foreground">Loading Clerk sign-in…</p>;
  }

  if (!isSignedIn) {
    return (
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Clerk administrator</p>
          <p className="text-xs text-muted-foreground">
            Sign in to link this administrative T3 session to your durable user.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron))
          }
        >
          Sign in with Clerk
        </Button>
      </div>
    );
  }

  const identityLabel = user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? userId;
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium">Clerk administrator</p>
        <p className="text-xs text-muted-foreground">
          {bindingState === "binding"
            ? `Connecting ${identityLabel}…`
            : bindingState === "bound"
              ? `${identityLabel} is connected to this environment.`
              : bindingState === "error"
                ? `Could not connect ${identityLabel} to this environment.`
                : `Signed in as ${identityLabel}.`}
        </p>
      </div>
      {bindingState === "error" ? (
        <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          Retry connection
        </Button>
      ) : null}
    </div>
  );
}

export function UserManagementSettingsPanel() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const directoryQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : userManagementEnvironment.directory({ environmentId, input: {} }),
  );
  const profilesQuery = useEnvironmentQuery(
    environmentId === null ? null : sourceControlEnvironment.profiles({ environmentId, input: {} }),
  );
  const updateUser = useAtomCommand(userManagementEnvironment.update, { reportFailure: false });
  const revokeSessions = useAtomCommand(userManagementEnvironment.revokeSessions, {
    reportFailure: false,
  });
  const setSourceControlProfile = useAtomCommand(
    userManagementEnvironment.setSourceControlProfile,
    { reportFailure: false },
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const directory = directoryQuery.data;
  const profiles = profilesQuery.data?.profiles ?? [];
  const clerkMode = resolveAppClerkMode();
  const currentUser = directory?.users.find((user) => user.current) ?? null;
  const canManage = currentUser?.role === "admin" && currentUser.status === "active";
  const assignableProfiles = useMemo(
    () => profiles.filter((profile) => !profile.archived),
    [profiles],
  );

  useEffect(() => {
    if (environmentId === null) return;
    const interval = window.setInterval(() => directoryQuery.refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, [directoryQuery, environmentId]);

  const run = async (key: string, operation: () => Promise<{ readonly _tag: string }>) => {
    setPendingAction(key);
    setActionError(null);
    const result = await operation();
    setPendingAction(null);
    if (result._tag !== "Success") {
      setActionError("The user-management action failed. Check your administrator access.");
      return;
    }
    directoryQuery.refresh();
    profilesQuery.refresh();
  };

  if (environmentId === null) return null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Access policy" icon={<ShieldCheckIcon className="size-5" />}>
        <div className="space-y-3 rounded-xl px-3 py-3 sm:px-4">
          {clerkMode === "disabled" ? (
            <p className="text-xs text-destructive">
              Clerk identity is unavailable because this build has no Clerk publishable key.
            </p>
          ) : (
            <ClerkIdentityBootstrap onBound={() => directoryQuery.refresh()} />
          )}
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Require Clerk identity</p>
              <p className="text-xs text-muted-foreground">
                New sessions must be signed in and are recorded as a durable T3 user.
              </p>
            </div>
            <Switch
              checked={settings.environmentUserIdentityMode === "required"}
              disabled={!canManage}
              onCheckedChange={(checked) => {
                void updateSettings({
                  environmentUserIdentityMode: checked ? "required" : "optional",
                });
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Use each thread owner's GitHub identity</p>
              <p className="text-xs text-muted-foreground">
                The creator owns a new thread automatically. GitHub activity always follows the
                durable owner's profile assigned below and never falls back to the machine account.
              </p>
            </div>
            <Switch
              checked={settings.sourceControlIdentityMode === "thread-profile"}
              disabled={!canManage}
              onCheckedChange={(checked) => {
                void updateSettings({
                  sourceControlIdentityMode: checked ? "thread-profile" : "machine",
                });
              }}
            />
          </div>
          {!canManage ? (
            <p className="text-xs text-muted-foreground">
              Sign in as an environment administrator to change access policy.
            </p>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title="Environment users" icon={<UsersIcon className="size-5" />}>
        <div className="space-y-3 px-3 sm:px-4">
          <p className="text-xs text-muted-foreground">
            Users appear after signing in with Clerk and connecting to this environment. Online
            status comes from live T3 sessions, not browser presence.
          </p>
          {directory?.users.map((user) => {
            const profile = profiles.find((entry) => entry.id === user.sourceControlProfileId);
            return (
              <div key={user.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {user.avatarUrl ? (
                      <img
                        src={user.avatarUrl}
                        alt=""
                        className="size-9 rounded-full"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <UserRoundIcon className="size-9 rounded-full border border-border p-2" />
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{userLabel(user)}</span>
                        {user.current ? <Badge>Current</Badge> : null}
                        <Badge variant={user.presence === "online" ? "default" : "outline"}>
                          {user.presence === "online" ? "Online" : "Offline"}
                        </Badge>
                        <Badge variant="outline">{user.role}</Badge>
                        {user.status === "blocked" ? (
                          <Badge variant="destructive">Blocked</Badge>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {user.primaryEmail ?? user.id} · {user.connectedSessionCount} connected /{" "}
                        {user.sessionCount} active sessions
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        GitHub: {profile ? `@${profile.login}` : "not connected"}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canManage || pendingAction !== null}
                      onClick={() =>
                        void run(`role:${user.id}`, () =>
                          updateUser({
                            environmentId,
                            input: {
                              userId: user.id,
                              role: user.role === "admin" ? "member" : "admin",
                            },
                          }),
                        )
                      }
                    >
                      {user.role === "admin" ? "Make member" : "Make admin"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canManage || pendingAction !== null}
                      onClick={() =>
                        void run(`status:${user.id}`, () =>
                          updateUser({
                            environmentId,
                            input: {
                              userId: user.id,
                              status: user.status === "blocked" ? "active" : "blocked",
                            },
                          }),
                        )
                      }
                    >
                      {user.status === "blocked" ? "Unblock" : "Block"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!canManage || pendingAction !== null || user.sessionCount === 0}
                      onClick={() =>
                        void run(`revoke:${user.id}`, () =>
                          revokeSessions({ environmentId, input: { userId: user.id } }),
                        )
                      }
                    >
                      Sign out devices
                    </Button>
                  </div>
                </div>
                <label className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                  GitHub identity
                  <select
                    className="h-8 min-w-48 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    value={user.sourceControlProfileId ?? ""}
                    disabled={!canManage || pendingAction !== null}
                    onChange={(event) => {
                      const selected = event.currentTarget.value;
                      void run(`profile:${user.id}`, () =>
                        setSourceControlProfile({
                          environmentId,
                          input: {
                            userId: user.id,
                            sourceControlProfileId: selected
                              ? (selected as SourceControlProfileId)
                              : null,
                          },
                        }),
                      );
                    }}
                  >
                    <option value="">Not connected</option>
                    {assignableProfiles.map((entry) => (
                      <option
                        key={entry.id}
                        value={entry.id}
                        disabled={entry.ownerUserId !== null && entry.ownerUserId !== user.id}
                      >
                        @{entry.login}
                        {entry.ownerUserId !== null && entry.ownerUserId !== user.id
                          ? " (assigned)"
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            );
          })}
          {directory?.users.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No Clerk users have connected to this environment yet.
            </p>
          ) : null}
          {directory && directory.unidentifiedSessionCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {directory.unidentifiedSessionCount} legacy session(s) are not linked to a Clerk user.
              Reconnect them after enabling required identity.
            </p>
          ) : null}
          <p className="text-xs text-destructive">{actionError ?? directoryQuery.error}</p>
        </div>
      </SettingsSection>

      <GitHubProfilesSettingsSection disabled={!canManage} />
    </SettingsPageContainer>
  );
}
