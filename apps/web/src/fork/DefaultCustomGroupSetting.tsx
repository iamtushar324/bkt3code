// T3-CUSTOM(expbkt3): the host's default custom group for new sessions.
//
// A new top-level session with no group named by its creator joins this group
// on the server (a child joins its parent's group instead). The choices are the
// host's shared group registry; a renamed group stays the default and a
// deleted one stops being it (packages/shared threadCustomGroupRegistry).
import {
  AuthSettingsWriteScope,
  normalizeThreadCustomGroup,
  resolveDefaultThreadCustomGroup,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { SettingsRow } from "../components/settings/settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select";
import { serverEnvironment } from "../state/server";
import { useEnvironmentsWithScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

/** The select's value for "no default"; a group key is never empty. */
const UNGROUPED_VALUE = "";

export function EnvironmentDefaultCustomGroupSetting({
  environmentId,
  label,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: ServerConfig;
}) {
  const environments = useMemo(() => [{ environmentId }], [environmentId]);
  const writable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope).has(
    environmentId,
  );
  const updateSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "default custom group update",
  );
  const { settings } = serverConfig;
  const groups = useMemo(
    () =>
      Object.values(settings.threadCustomGroups)
        .map((definition) => ({
          value: normalizeThreadCustomGroup(definition.label),
          label: definition.label,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [settings.threadCustomGroups],
  );
  if (serverConfig.environment.capabilities.threadCustomGroupRegistry !== true) return null;
  const current = resolveDefaultThreadCustomGroup(settings);
  const value = current === null ? UNGROUPED_VALUE : normalizeThreadCustomGroup(current);
  const labelFor = (selected: string | null) =>
    selected === null || selected === UNGROUPED_VALUE
      ? "Ungrouped"
      : (groups.find((group) => group.value === selected)?.label ?? selected);

  return (
    <SettingsRow
      title="Default group for new sessions"
      description={
        groups.length === 0
          ? "Create a custom group in the sidebar first. New sessions stay ungrouped until then."
          : `New sessions on ${label} join this group when nobody picks one. A child session joins its parent's group.`
      }
      control={
        <Select
          value={value}
          disabled={!writable || groups.length === 0}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            const group = groups.find((candidate) => candidate.value === next);
            void updateSettings({
              environmentId,
              input: { patch: { defaultThreadCustomGroup: group?.label ?? null } },
            });
          }}
        >
          <SelectTrigger size="sm" aria-label={`Default group for new sessions on ${label}`}>
            <SelectValue>{labelFor}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={UNGROUPED_VALUE}>Ungrouped</SelectItem>
            {groups.map((group) => (
              <SelectItem key={group.value} value={group.value}>
                {group.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
