// T3-CUSTOM(expbkt3): tag users on a thread, from the phone.
//
// The commands (`addMember`, `removeMember`, `transferOwnership`) already live in
// client-runtime and are what web's ThreadMembersControl calls, so this is the
// directory plus a list. Ordering and filtering are in threadMembers.ts, kept
// pure so they are testable without a renderer.
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, OrchestrationUser, ThreadId, UserId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadShell } from "../../state/entities";
import {
  buildThreadMemberEntries,
  canRemoveThreadMember,
  filterThreadMemberEntries,
  threadMemberInitial,
  threadMemberLabel,
  type ThreadMemberEntry,
} from "./threadMembers";

type ThreadMembersSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>;

function MemberRow(props: {
  readonly entry: ThreadMemberEntry;
  readonly isBusy: boolean;
  readonly onToggle: (entry: ThreadMemberEntry) => void;
  readonly onTransferOwnership: (entry: ThreadMemberEntry) => void;
}) {
  const { entry } = props;
  const iconTint = String(useUniwindTheme()["--color-icon"]);
  const handleToggle = useCallback(() => props.onToggle(entry), [entry, props]);
  const handleTransfer = useCallback(() => props.onTransferOwnership(entry), [entry, props]);

  return (
    <View className="flex-row items-center gap-3 px-4 py-2.5">
      <View className="h-8 w-8 items-center justify-center rounded-full bg-primary/70">
        <Text className="text-xs font-t3-bold text-primary-foreground">
          {threadMemberInitial(entry.user)}
        </Text>
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {threadMemberLabel(entry.user)}
        </Text>
        {entry.isOwner ? (
          <Text className="text-[10px] uppercase text-foreground-muted">Owner</Text>
        ) : entry.user.email === null ? null : (
          <Text className="text-[10px] text-foreground-muted" numberOfLines={1}>
            {entry.user.email}
          </Text>
        )}
      </View>

      {props.isBusy ? (
        <ActivityIndicator size="small" />
      ) : entry.isOwner ? null : (
        <View className="flex-row items-center gap-3">
          {entry.isMember ? (
            <Pressable hitSlop={8} onPress={handleTransfer}>
              <Text className="text-xs font-t3-bold text-primary">Make owner</Text>
            </Pressable>
          ) : null}
          <Pressable hitSlop={8} onPress={handleToggle}>
            <SymbolView
              name={canRemoveThreadMember(entry) ? "minus.circle" : "plus.circle"}
              size={20}
              tintColor={iconTint}
              type="monochrome"
            />
          </Pressable>
        </View>
      )}
    </View>
  );
}

export function ThreadMembersSheet(props: ThreadMembersSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId } = props.route.params;
  const [query, setQuery] = useState("");
  const [pendingUserIds, setPendingUserIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const thread = useThreadShell({ environmentId, threadId });
  // The org directory: UserIds that can own or be tagged on a thread.
  const directoryQuery = useEnvironmentQuery(
    environmentSession.orchestrationUsersAtom(environmentId),
  );
  const addMember = useAtomCommand(threadEnvironment.addMember, "thread add member");
  const removeMember = useAtomCommand(threadEnvironment.removeMember, "thread remove member");
  const transferOwnership = useAtomCommand(
    threadEnvironment.transferOwnership,
    "thread transfer ownership",
  );

  const users: ReadonlyArray<OrchestrationUser> = directoryQuery.data?.users ?? [];
  const entries = useMemo(
    () =>
      filterThreadMemberEntries(
        buildThreadMemberEntries({
          users,
          ownerUserId: thread?.ownerUserId ?? null,
          memberUserIds: thread?.memberUserIds ?? [],
        }),
        query,
      ),
    [query, thread?.memberUserIds, thread?.ownerUserId, users],
  );

  const withPending = useCallback(
    (userId: UserId, run: () => Promise<{ readonly _tag: string }>) => {
      setPendingUserIds((current) => new Set(current).add(userId));
      setError(null);
      void run()
        .then((result) => {
          if (result._tag === "Failure") setError("That change could not be saved. Try again.");
        })
        .finally(() => {
          setPendingUserIds((current) => {
            const next = new Set(current);
            next.delete(userId);
            return next;
          });
        });
    },
    [],
  );

  const handleToggle = useCallback(
    (entry: ThreadMemberEntry) => {
      const userId = entry.user.id;
      withPending(userId, () =>
        canRemoveThreadMember(entry)
          ? removeMember({ environmentId, input: { threadId, userId } })
          : addMember({ environmentId, input: { threadId, userId } }),
      );
    },
    [addMember, environmentId, removeMember, threadId, withPending],
  );

  const handleTransferOwnership = useCallback(
    (entry: ThreadMemberEntry) => {
      const userId = entry.user.id;
      withPending(userId, () => transferOwnership({ environmentId, input: { threadId, userId } }));
    },
    [environmentId, threadId, transferOwnership, withPending],
  );

  return (
    <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom }}>
      <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
        <Pressable hitSlop={8} onPress={() => navigation.goBack()}>
          <Text className="text-base text-foreground-muted">Done</Text>
        </Pressable>
        <Text className="text-base font-t3-bold text-foreground">People</Text>
        <View className="w-12" />
      </View>

      <TextInput
        autoCapitalize="none"
        className="mx-4 mt-3 rounded-lg bg-subtle/40 px-3 py-2 text-sm text-foreground"
        onChangeText={setQuery}
        placeholder="Search people"
        value={query}
      />

      {error === null ? null : <Text className="px-4 pt-2 text-xs text-destructive">{error}</Text>}

      <ScrollView className="mt-2 flex-1" keyboardShouldPersistTaps="handled">
        {directoryQuery.isPending && users.length === 0 ? (
          <View className="items-center py-8">
            <ActivityIndicator />
          </View>
        ) : entries.length === 0 ? (
          <Text className="px-4 py-8 text-center text-sm text-foreground-muted">
            {users.length === 0
              ? "This environment has no user directory."
              : "Nobody matches that search."}
          </Text>
        ) : (
          entries.map((entry) => (
            <MemberRow
              entry={entry}
              isBusy={pendingUserIds.has(entry.user.id)}
              key={entry.user.id}
              onToggle={handleToggle}
              onTransferOwnership={handleTransferOwnership}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}
