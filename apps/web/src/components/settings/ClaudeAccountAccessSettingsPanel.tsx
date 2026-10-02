/**
 * T3-CUSTOM(expbkt3): ClaudeAccountAccessSettingsPanel - admin-only Claude
 * account access per user (team mode).
 *
 * Lists each Claude account the server runs (from the live account snapshot,
 * which shows admins every account) with who may use it. An account with
 * nobody assigned is open to everyone; once an admin assigns people, only they
 * may use it — Auto skips it for everyone else and they cannot pin it. Renders
 * an access-denied notice for non-admins (the nav item is also hidden).
 *
 * @module components/settings/ClaudeAccountAccessSettingsPanel
 */
import type { ClaudeAccountStatus, OrchestrationUser, UserId } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { useClaudeAccountAccess, useClaudeAccountsSnapshot } from "../../fork/claudeAccounts/hooks";
import { orderAccounts } from "../../fork/claudeAccounts/model";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useIsTeamAdmin, useOrgMembers } from "../../state/orgMembers";
import { MemberPicker } from "../members/MemberPicker";
import { AvatarStack } from "../ui/avatar";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const NO_USERS: ReadonlyArray<UserId> = [];

export function ClaudeAccountAccessSettingsPanel() {
  const isAdmin = useIsTeamAdmin();
  const environmentId = usePrimaryEnvironmentId();
  const live = isAdmin ? environmentId : null;
  const snapshot = useClaudeAccountsSnapshot(live);
  const access = useClaudeAccountAccess(live);
  const { users, resolveUser } = useOrgMembers();
  const [managing, setManaging] = useState<ClaudeAccountStatus | null>(null);

  if (!isAdmin) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Claude account access">
          <p className="px-1 py-4 text-sm text-muted-foreground">
            Only workspace admins can manage Claude account access.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const accounts = snapshot === null ? [] : orderAccounts(snapshot.profiles);
  let emptyLine: string | null = null;
  if (snapshot === null) {
    emptyLine = "Loading accounts…";
  } else if (!snapshot.enabled) {
    emptyLine = "Claude account profiles are off on this server.";
  } else if (accounts.length === 0) {
    // Before its first poll the server reports available with no accounts.
    emptyLine = snapshot.available ? "Loading accounts…" : "Account data is unavailable right now.";
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Claude account access">
        <p className="px-3.5 pt-3.5 text-xs text-muted-foreground">
          Choose who may use each Claude account. An account with nobody assigned is open to
          everyone. Once you assign people, only they can pin it, and Auto places only their threads
          on it. A thread already running on an account someone loses moves on its next session.
        </p>
        {access.error !== null ? (
          <p className="px-3.5 pt-2 text-xs text-destructive">{access.error}</p>
        ) : null}
        {emptyLine !== null ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">{emptyLine}</p>
        ) : (
          accounts.map((account) => {
            const assigned = access.usersByProfile?.get(account.name) ?? NO_USERS;
            const assignedUsers: ReadonlyArray<OrchestrationUser> = assigned.map((id) =>
              resolveUser(id),
            );
            return (
              <SettingsRow
                key={account.name}
                title={account.name}
                description={account.emailMasked}
                control={
                  <div className="flex items-center gap-2">
                    {access.usersByProfile === null ? null : assignedUsers.length > 0 ? (
                      <AvatarStack users={assignedUsers} size="sm" />
                    ) : (
                      <span className="text-xs text-muted-foreground">Everyone</span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={access.usersByProfile === null}
                      onClick={() => setManaging(account)}
                    >
                      Manage
                    </Button>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>

      {managing !== null ? (
        <ClaudeAccountAccessDialog
          account={managing}
          assigned={access.usersByProfile?.get(managing.name) ?? NO_USERS}
          users={users}
          resolveUser={resolveUser}
          writeError={access.writeError}
          onSetUsers={(userIds) => access.setUsers(managing.name, userIds)}
          onClose={() => setManaging(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function ClaudeAccountAccessDialog(props: {
  readonly account: ClaudeAccountStatus;
  readonly assigned: ReadonlyArray<UserId>;
  readonly users: ReadonlyArray<OrchestrationUser>;
  readonly resolveUser: (id: UserId) => OrchestrationUser;
  readonly writeError: string | null;
  readonly onSetUsers: (userIds: ReadonlyArray<UserId>) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { assigned, onSetUsers } = props;
  // Toggles show at once; each write sends the whole list, so a quick run of
  // clicks lands as the last one. The server's list takes over once all land.
  const [optimistic, setOptimistic] = useState<ReadonlyArray<UserId> | null>(null);
  const [pending, setPending] = useState<ReadonlySet<UserId>>(() => new Set());
  const inFlight = useRef(0);
  const selected = optimistic ?? assigned;

  const onToggle = useCallback(
    (userId: UserId, nextChecked: boolean) => {
      const next = nextChecked
        ? [...selected.filter((id) => id !== userId), userId]
        : selected.filter((id) => id !== userId);
      setOptimistic(next);
      setPending((prev) => new Set(prev).add(userId));
      inFlight.current += 1;
      void onSetUsers(next).finally(() => {
        inFlight.current -= 1;
        if (inFlight.current === 0) setOptimistic(null);
        setPending((prev) => {
          const rest = new Set(prev);
          rest.delete(userId);
          return rest;
        });
      });
    },
    [onSetUsers, selected],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Who can use {props.account.name}</DialogTitle>
          <DialogDescription>
            {selected.length === 0
              ? "Nobody is assigned, so everyone can use this account. Check people to limit it to them."
              : "Only the people checked can use this account. Uncheck everyone to open it to all."}
          </DialogDescription>
          {props.writeError !== null ? (
            <p className="text-xs text-destructive">Not saved: {props.writeError}</p>
          ) : null}
        </DialogHeader>
        <DialogPanel>
          <MemberPicker
            users={props.users}
            ownerUserId={null}
            memberUserIds={selected}
            pendingUserIds={pending}
            onToggle={onToggle}
            resolveUser={props.resolveUser}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
