// T3-CUSTOM(expbkt3): the "Preview browser" row, kept out of upstream's
// ProjectDefaultsSettings so that file only gains a one-line mount.
//
// The value is a host setting: every user of the selected hosts shares it, and
// a project cannot override it, so the row renders only at an environment scope.
import { DEFAULT_SERVER_SETTINGS, type PreviewBrowserHostSetting } from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const PREVIEW_BROWSER_LABELS: Record<PreviewBrowserHostSetting, string> = {
  client: "Client browser",
  server: "Server browser",
};

function isPreviewBrowserHostSetting(value: unknown): value is PreviewBrowserHostSetting {
  return value === "client" || value === "server";
}

export function PreviewBrowserHostRow() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["previewBrowser"]);
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["previewBrowser"]}
      mixed={mixed}
      {...searchableSetting("preview-browser-host")}
      description="Where preview tabs run for everyone on this host. Client uses the desktop app's own browser; web and phone clients still use the server browser."
      resetAction={
        settings.previewBrowser !== DEFAULT_SERVER_SETTINGS.previewBrowser ? (
          <SettingResetButton
            label="default preview browser"
            onClick={() =>
              updateSettings({ previewBrowser: DEFAULT_SERVER_SETTINGS.previewBrowser })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.previewBrowser}
          onValueChange={(value) => {
            if (isPreviewBrowserHostSetting(value)) updateSettings({ previewBrowser: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Preview browser">
            <SelectValue>
              {(value: string | null) =>
                isPreviewBrowserHostSetting(value) ? PREVIEW_BROWSER_LABELS[value] : "Mixed"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="client">{PREVIEW_BROWSER_LABELS.client}</SelectItem>
            <SelectItem value="server">{PREVIEW_BROWSER_LABELS.server}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
