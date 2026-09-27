import type {
  EnvironmentId,
  EnvironmentUser,
  GitHubSourceControlProfile,
  SourceControlProfileId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { userManagementEnvironment } from "../../state/users";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "./components/SettingsSection";

function actionError(result: AtomCommandResult<unknown, unknown>): string {
  if (AsyncResult.isFailure(result)) {
    const cause = Cause.squash(result.cause);
    return cause instanceof Error ? cause.message : "The GitHub profile action failed.";
  }
  return "The GitHub profile action failed.";
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      className="rounded-full bg-subtle px-3 py-2 disabled:opacity-40"
    >
      <Text
        className={
          props.destructive
            ? "text-xs font-t3-bold text-danger-foreground"
            : "text-xs font-t3-bold text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function ProfileCard(props: {
  readonly profile: GitHubSourceControlProfile;
  readonly busy: boolean;
  readonly replacementToken: string;
  readonly setReplacementToken: (token: string) => void;
  readonly runAction: (action: "test" | "replace" | "disconnect" | "archive" | "restore") => void;
}) {
  const { profile } = props;
  return (
    <View className="gap-3 border-t border-border px-4 py-4 first:border-t-0">
      <View className="gap-1">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="min-w-0 flex-1 text-base font-t3-bold" numberOfLines={1}>
            {profile.label} · @{profile.login}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {profile.archived ? "Archived" : profile.credentialStatus}
          </Text>
        </View>
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {profile.gitName} &lt;{profile.gitEmail}&gt;
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <ActionButton label="Test" disabled={props.busy} onPress={() => props.runAction("test")} />
        <ActionButton
          label="Disconnect"
          disabled={props.busy || profile.credentialStatus === "missing"}
          destructive
          onPress={() => props.runAction("disconnect")}
        />
        <ActionButton
          label={profile.archived ? "Restore" : "Archive"}
          disabled={props.busy}
          onPress={() => props.runAction(profile.archived ? "restore" : "archive")}
        />
      </View>
      <View className="flex-row items-center gap-2">
        <TextInput
          className="h-11 min-h-11 flex-1 rounded-[20px] px-4 py-0 text-sm"
          value={props.replacementToken}
          onChangeText={props.setReplacementToken}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Replace fine-grained PAT"
        />
        <ActionButton
          label="Replace"
          disabled={props.busy || props.replacementToken.trim().length === 0}
          onPress={() => props.runAction("replace")}
        />
      </View>
    </View>
  );
}

function EnvironmentProfiles(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const profilesQuery = useEnvironmentQuery(
    sourceControlEnvironment.profiles({ environmentId: props.environmentId, input: {} }),
  );
  const directoryQuery = useEnvironmentQuery(
    userManagementEnvironment.directory({ environmentId: props.environmentId, input: {} }),
  );
  const upsert = useAtomCommand(sourceControlEnvironment.upsertProfile, { reportFailure: false });
  const test = useAtomCommand(sourceControlEnvironment.testProfile, { reportFailure: false });
  const replace = useAtomCommand(sourceControlEnvironment.replaceProfileCredential, {
    reportFailure: false,
  });
  const disconnect = useAtomCommand(sourceControlEnvironment.disconnectProfile, {
    reportFailure: false,
  });
  const archive = useAtomCommand(sourceControlEnvironment.archiveProfile, {
    reportFailure: false,
  });
  const updateUser = useAtomCommand(userManagementEnvironment.update, { reportFailure: false });
  const revokeUserSessions = useAtomCommand(userManagementEnvironment.revokeSessions, {
    reportFailure: false,
  });
  const assignProfile = useAtomCommand(userManagementEnvironment.setSourceControlProfile, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [label, setLabel] = useState("");
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const [token, setToken] = useState("");
  const [replacementTokens, setReplacementTokens] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profiles = profilesQuery.data?.profiles ?? [];
  const mode = profilesQuery.data?.identityMode ?? "machine";
  const directory = directoryQuery.data;
  const currentUser = directory?.users.find((user) => user.current) ?? null;
  const canManage = currentUser?.role === "admin" && currentUser.status === "active";

  useEffect(() => {
    const interval = setInterval(() => directoryQuery.refresh(), 10_000);
    return () => clearInterval(interval);
  }, [directoryQuery]);

  const run = async (action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      setError(actionError(result));
      return false;
    }
    profilesQuery.refresh();
    directoryQuery.refresh();
    return true;
  };

  const runUserAction = async (user: EnvironmentUser, action: "role" | "status" | "revoke") => {
    if (!canManage) return;
    if (action === "revoke") {
      await run(() =>
        revokeUserSessions({
          environmentId: props.environmentId,
          input: { userId: user.id },
        }),
      );
      return;
    }
    await run(() =>
      updateUser({
        environmentId: props.environmentId,
        input:
          action === "role"
            ? { userId: user.id, role: user.role === "admin" ? "member" : "admin" }
            : { userId: user.id, status: user.status === "blocked" ? "active" : "blocked" },
      }),
    );
  };

  const chooseProfile = (user: EnvironmentUser) => {
    if (!canManage) return;
    Alert.alert(
      "GitHub identity",
      `Choose the profile used by ${user.displayName ?? user.primaryEmail ?? user.id}.`,
      [
        {
          text: "Not connected",
          onPress: () =>
            void run(() =>
              assignProfile({
                environmentId: props.environmentId,
                input: { userId: user.id, sourceControlProfileId: null },
              }),
            ),
        },
        ...profiles
          .filter(
            (profile) =>
              !profile.archived &&
              (profile.ownerUserId === null || profile.ownerUserId === user.id),
          )
          .map((profile) => ({
            text: `@${profile.login}`,
            onPress: () =>
              void run(() =>
                assignProfile({
                  environmentId: props.environmentId,
                  input: { userId: user.id, sourceControlProfileId: profile.id },
                }),
              ),
          })),
        { text: "Cancel", style: "cancel" as const },
      ],
    );
  };

  const setMode = async (nextMode: "machine" | "thread-profile") => {
    await run(() =>
      updateSettings({
        environmentId: props.environmentId,
        input: { patch: { sourceControlIdentityMode: nextMode } },
      }),
    );
  };

  const confirmModeChange = () => {
    const nextMode = mode === "machine" ? "thread-profile" : "machine";
    Alert.alert(
      nextMode === "thread-profile" ? "Use user GitHub identities?" : "Use machine identity?",
      nextMode === "thread-profile"
        ? "Each new thread is owned by its creator automatically. Existing threads keep their durable owner, and GitHub activity uses the profile assigned to that user."
        : "Git and GitHub commands may use the environment's shared machine credentials.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Confirm", onPress: () => void setMode(nextMode) },
      ],
    );
  };

  const createProfile = async () => {
    if (![label, gitName, gitEmail, token].every((value) => value.trim().length > 0)) return;
    const succeeded = await run(() =>
      upsert({
        environmentId: props.environmentId,
        input: {
          label: label.trim(),
          gitName: gitName.trim(),
          gitEmail: gitEmail.trim(),
          credential: token.trim(),
        },
      }),
    );
    if (succeeded) {
      setLabel("");
      setGitName("");
      setGitEmail("");
      setToken("");
    }
  };

  const runProfileAction = async (
    profileId: SourceControlProfileId,
    action: "test" | "replace" | "disconnect" | "archive" | "restore",
  ) => {
    if (action === "test") {
      await run(() => test({ environmentId: props.environmentId, input: { profileId } }));
      return;
    }
    if (action === "replace") {
      const credential = replacementTokens[profileId]?.trim() ?? "";
      if (!credential) return;
      const succeeded = await run(() =>
        replace({ environmentId: props.environmentId, input: { profileId, credential } }),
      );
      if (succeeded) {
        setReplacementTokens((current) => ({ ...current, [profileId]: "" }));
      }
      return;
    }
    if (action === "disconnect") {
      await run(() => disconnect({ environmentId: props.environmentId, input: { profileId } }));
      return;
    }
    await run(() =>
      archive({
        environmentId: props.environmentId,
        input: { profileId, archived: action === "archive" },
      }),
    );
  };

  return (
    <View className="gap-4">
      <SettingsSection title={`${props.environmentLabel} users`}>
        <Pressable
          disabled={!canManage || busy}
          onPress={() =>
            void run(() =>
              updateSettings({
                environmentId: props.environmentId,
                input: {
                  patch: {
                    environmentUserIdentityMode:
                      directory?.identityMode === "required" ? "optional" : "required",
                  },
                },
              }),
            )
          }
          className="flex-row items-center justify-between gap-3 px-4 py-4 disabled:opacity-40"
        >
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-base font-t3-bold">Clerk identity</Text>
            <Text className="text-xs text-foreground-muted">
              {directory?.identityMode === "required" ? "Required" : "Optional"}
            </Text>
          </View>
          <Text className="text-sm text-foreground-muted">Change</Text>
        </Pressable>
        {directory?.users.map((user) => {
          const profile = profiles.find((entry) => entry.id === user.sourceControlProfileId);
          return (
            <View key={user.id} className="gap-3 border-t border-border px-4 py-4">
              <View className="gap-1">
                <Text className="text-base font-t3-bold" numberOfLines={1}>
                  {user.displayName ?? user.primaryEmail ?? user.id}
                  {user.current ? " · You" : ""}
                </Text>
                <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                  {user.presence} · {user.role} · {user.status} · {user.connectedSessionCount}/
                  {user.sessionCount} sessions · {profile ? `@${profile.login}` : "no GitHub"}
                </Text>
              </View>
              <View className="flex-row flex-wrap gap-2">
                <ActionButton
                  label={user.role === "admin" ? "Make member" : "Make admin"}
                  disabled={!canManage || busy}
                  onPress={() => void runUserAction(user, "role")}
                />
                <ActionButton
                  label={user.status === "blocked" ? "Unblock" : "Block"}
                  disabled={!canManage || busy}
                  destructive={user.status !== "blocked"}
                  onPress={() => void runUserAction(user, "status")}
                />
                <ActionButton
                  label="Sign out devices"
                  disabled={!canManage || busy || user.sessionCount === 0}
                  onPress={() => void runUserAction(user, "revoke")}
                />
                <ActionButton
                  label={profile ? `GitHub @${profile.login}` : "Connect GitHub"}
                  disabled={!canManage || busy}
                  onPress={() => chooseProfile(user)}
                />
              </View>
            </View>
          );
        })}
        {directory?.users.length === 0 ? (
          <Text className="px-4 py-4 text-sm text-foreground-muted">
            No Clerk users have connected to this environment yet.
          </Text>
        ) : null}
      </SettingsSection>

      <SettingsSection title={props.environmentLabel}>
        <Pressable
          disabled={!canManage || busy}
          onPress={confirmModeChange}
          className="flex-row items-center justify-between gap-3 px-4 py-4 disabled:opacity-40"
        >
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-base font-t3-bold">Attribution mode</Text>
            <Text className="text-xs text-foreground-muted">
              {mode === "thread-profile" ? "Thread owner's GitHub profile" : "Machine credentials"}
            </Text>
          </View>
          <Text className="text-sm text-foreground-muted">Change</Text>
        </Pressable>
        {profiles.map((profile) => (
          <ProfileCard
            key={profile.id}
            profile={profile}
            busy={busy || !canManage}
            replacementToken={replacementTokens[profile.id] ?? ""}
            setReplacementToken={(value) =>
              setReplacementTokens((current) => ({ ...current, [profile.id]: value }))
            }
            runAction={(action) => void runProfileAction(profile.id, action)}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Add GitHub profile">
        <View className="gap-3 p-4">
          <TextInput value={label} onChangeText={setLabel} placeholder="Profile label" />
          <TextInput value={gitName} onChangeText={setGitName} placeholder="Git commit name" />
          <TextInput
            value={gitEmail}
            onChangeText={setGitEmail}
            placeholder="Verified GitHub email or noreply email"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          <Text className="text-xs text-foreground-muted">
            Private emails require “Email addresses: read” on the PAT. A GitHub noreply email works
            without that permission.
          </Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="Fine-grained PAT"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ActionButton
            label="Add profile"
            disabled={
              !canManage || busy || ![label, gitName, gitEmail, token].every((v) => v.trim())
            }
            onPress={() => void createProfile()}
          />
        </View>
      </SettingsSection>
      {(error ?? profilesQuery.error) ? (
        <Text selectable className="px-2 text-sm text-danger-foreground">
          {error ?? profilesQuery.error}
        </Text>
      ) : null}
      {profilesQuery.isPending ? <ActivityIndicator /> : null}
    </View>
  );
}

export function SettingsUsersRouteScreen() {
  const insets = useSafeAreaInsets();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const environments = useMemo(
    () =>
      connectedEnvironments.filter((environment) => environment.connectionState === "connected"),
    [connectedEnvironments],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Manage who is signed in to each T3 environment and connect every person to their own
          write-only GitHub profile.
        </Text>
        {environments.map((environment) => (
          <EnvironmentProfiles
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.environmentLabel}
          />
        ))}
        {environments.length === 0 ? (
          <Text className="px-2 text-sm text-foreground-muted">
            Connect an environment to manage its users and GitHub profiles.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
