/**
 * T3-CUSTOM(expbkt3): Archived-session worktree reclaim settings.
 *
 * Server settings, because the sweep runs on the server against its own disk.
 * Rendered in the Experiments tab; the manual panel lives on the Archived page.
 *
 * The auto-sweep is off by default and deliberately hard to turn on casually:
 * it deletes from disk on a timer, and the retention window is the only thing
 * between it and a session someone archived an hour ago.
 */
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const DEFAULTS = DEFAULT_UNIFIED_SETTINGS.experimental.sessionArchive;
const MAX_RETENTION_DAYS = 365;

export function SessionArchiveSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const archive = settings.experimental.sessionArchive;

  // `updateSettings` takes a whole-value patch, so merge onto current values.
  const patch = (next: Partial<typeof archive>) => {
    updateSettings({
      experimental: {
        ...settings.experimental,
        sessionArchive: { ...archive, ...next },
      },
    });
  };

  const patchSweep = (next: Partial<typeof archive.autoSweep>) => {
    patch({ autoSweep: { ...archive.autoSweep, ...next } });
  };

  const sweepLabel = !archive.autoSweep.enabled
    ? "Off — sessions are only reclaimed when you ask on the Archived page."
    : archive.autoSweep.mode === "slim"
      ? `Deletes regenerable directories from worktrees archived more than ${archive.autoSweep.minArchivedDays} days ago.`
      : `Removes worktrees archived more than ${archive.autoSweep.minArchivedDays} days ago, when they are clean and pushed.`;

  return (
    <SettingsSection title="Archived session storage">
      <SettingsRow
        title="Keep session history when reclaiming"
        description="Archiving a session keeps its worktree on disk forever, so the only way to free the space is to delete the session. Turning this on lets the Archived page reclaim that disk after exporting the session's history — a digest plus a full transcript — to a directory outside the worktree."
        resetAction={
          archive.enabled !== DEFAULTS.enabled ? (
            <SettingResetButton
              label="session archive reclaim"
              onClick={() => patch({ enabled: DEFAULTS.enabled })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Enable archived session reclaim"
            checked={archive.enabled}
            onCheckedChange={(checked) => patch({ enabled: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title="Write full transcripts"
        description="Alongside each digest, write a .jsonl of every message in the session. Complete, but large — turn this off if you only want the readable summary."
        resetAction={
          archive.includeTranscriptSidecar !== DEFAULTS.includeTranscriptSidecar ? (
            <SettingResetButton
              label="transcript sidecars"
              onClick={() => patch({ includeTranscriptSidecar: DEFAULTS.includeTranscriptSidecar })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Write full transcript sidecars"
            checked={archive.includeTranscriptSidecar}
            disabled={!archive.enabled}
            onCheckedChange={(checked) => patch({ includeTranscriptSidecar: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title="Sweep automatically"
        description="Reclaim old archived sessions on a timer instead of by hand. Sessions whose worktree is shared with an active session, or that something is running out of, are never touched."
        status={sweepLabel}
        resetAction={
          archive.autoSweep.enabled !== DEFAULTS.autoSweep.enabled ? (
            <SettingResetButton
              label="automatic sweep"
              onClick={() => patchSweep({ enabled: DEFAULTS.autoSweep.enabled })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Sweep archived sessions automatically"
            checked={archive.autoSweep.enabled}
            disabled={!archive.enabled}
            onCheckedChange={(checked) => patchSweep({ enabled: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title="Sweep action"
        description="Slim deletes only regenerable directories and leaves a usable checkout. Remove runs git worktree remove, and refuses on anything dirty or unpushed."
        resetAction={
          archive.autoSweep.mode !== DEFAULTS.autoSweep.mode ? (
            <SettingResetButton
              label="sweep action"
              onClick={() => patchSweep({ mode: DEFAULTS.autoSweep.mode })}
            />
          ) : null
        }
        control={
          <Select
            aria-label="Automatic sweep action"
            disabled={!archive.enabled || !archive.autoSweep.enabled}
            value={archive.autoSweep.mode}
            onValueChange={(value) => {
              if (value === "slim" || value === "remove") {
                patchSweep({ mode: value });
              }
            }}
          >
            <SelectTrigger className="h-7 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="slim">Slim worktree</SelectItem>
              <SelectItem value="remove">Remove worktree</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Reclaim after"
        description="Days a session must sit archived before the sweep may touch it. This window is the only protection against reclaiming something you archived by mistake, so keep it generous."
        status={`${archive.autoSweep.minArchivedDays} days`}
        resetAction={
          archive.autoSweep.minArchivedDays !== DEFAULTS.autoSweep.minArchivedDays ? (
            <SettingResetButton
              label="retention window"
              onClick={() => patchSweep({ minArchivedDays: DEFAULTS.autoSweep.minArchivedDays })}
            />
          ) : null
        }
        control={
          <NumberField
            aria-label="Reclaim after N days"
            className="w-32 gap-0"
            disabled={!archive.enabled || !archive.autoSweep.enabled}
            max={MAX_RETENTION_DAYS}
            min={0}
            onValueChange={(next) => {
              if (typeof next === "number" && Number.isFinite(next)) {
                patchSweep({ minArchivedDays: Math.round(next) });
              }
            }}
            size="sm"
            step={1}
            value={archive.autoSweep.minArchivedDays}
          >
            <NumberFieldGroup className="h-7 rounded-md">
              <NumberFieldDecrement
                aria-label="Decrease retention window"
                className="px-2 [&_svg]:size-3.5"
              />
              <NumberFieldInput
                aria-label="Reclaim after N days"
                className="h-7 w-14 grow-0 px-0 text-xs leading-7"
                inputMode="numeric"
              />
              <NumberFieldIncrement
                aria-label="Increase retention window"
                className="px-2 [&_svg]:size-3.5"
              />
            </NumberFieldGroup>
          </NumberField>
        }
      />
    </SettingsSection>
  );
}
