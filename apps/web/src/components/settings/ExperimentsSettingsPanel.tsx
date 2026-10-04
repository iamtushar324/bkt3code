import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SessionSummarySettingsSection } from "./SessionSummarySettingsSection";
// T3-CUSTOM(expbkt3): server-wide plan submission tool experiment.
import { PlanSubmissionSettingsRow } from "./PlanSubmissionSettingsRow";
// T3-CUSTOM(expbkt3): session work summary + progress assessment.
import { SessionWorkSummarySettingsSection } from "./SessionWorkSummarySettingsSection";
import { ExternalMcpSettingsSection } from "./ExternalMcpSettingsSection";
// T3-CUSTOM(expbkt3): session title maintenance.
import { ThreadTitleMaintenanceSettingsSection } from "./ThreadTitleMaintenanceSettingsSection";
// T3-CUSTOM(expbkt3): archived-session worktree reclaim.
import { SessionArchiveSettingsSection } from "./SessionArchiveSettingsSection";
import { EXPERIMENTAL_CONTROL_CENTER_ENABLED } from "../../experimentalFeatures";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
// T3-CUSTOM(expbkt3): native plan review (moved here from the removed Beta panel).
import { searchableSetting } from "./settingsSearch";

export function ExperimentsSettingsPanel() {
  const phaseGroupedSidebarEnabled = useClientSettings(
    (settings) => settings.phaseGroupedSidebarEnabled,
  );
  const resourceMonitorEnabled = useClientSettings((settings) => settings.resourceMonitorEnabled);
  const providerRateLimitsEnabled = useClientSettings(
    (settings) => settings.providerRateLimitsEnabled,
  );
  const updateSettings = useUpdateClientSettings();
  // T3-CUSTOM(expbkt3): native plan review (moved here from the removed Beta panel).
  const nativePlanReviewEnabled = useClientSettings((settings) => settings.nativePlanReviewEnabled);
  // T3-CUSTOM(expbkt3): plan review takeover.
  const planReviewAutoOpenEnabled = useClientSettings(
    (settings) => settings.planReviewAutoOpenEnabled,
  );
  // T3-CUSTOM(expbkt3): agent-rendered UI surfaces in chat.
  const agentUiSurfacesEnabled = useClientSettings((settings) => settings.agentUiSurfacesEnabled);
  // T3-CUSTOM(expbkt3): upstream's pull request view.
  const nativePullRequestViewEnabled = useClientSettings(
    (settings) => settings.nativePullRequestViewEnabled,
  );
  // T3-CUSTOM(expbkt3): every link opens in the integrated browser.
  const openLinksInIntegratedBrowser = useClientSettings(
    (settings) => settings.openLinksInIntegratedBrowser,
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Experimental features">
        {/* T3-CUSTOM(expbkt3): server-wide plan submission tool experiment. */}
        <PlanSubmissionSettingsRow />
        {/* T3-CUSTOM(expbkt3): BEGIN — native plan review. */}
        <SettingsRow
          {...searchableSetting("native-plan-review")}
          description="Review proposed plans in a side panel: comment on exact lines, edit the plan with tracked changes, and step through every version with its author. Approving sends a short acknowledgement instead of repeating the whole plan. While off, plan review goes through Plannotator only."
          control={
            <Switch
              checked={nativePlanReviewEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ nativePlanReviewEnabled: Boolean(checked) })
              }
              aria-label="Native plan review"
            />
          }
        />
        {/* T3-CUSTOM(expbkt3): END */}
        {/* T3-CUSTOM(expbkt3): BEGIN — plan review takeover. */}
        <SettingsRow
          {...searchableSetting("plan-review-takeover")}
          description="Open a plan for review the moment it is ready, over the conversation. The chat header, the composer and the sidebar stay usable, and closing a plan keeps it closed. While off, a ready plan waits behind the Preview button on its card. Needs native plan review."
          control={
            <Switch
              checked={planReviewAutoOpenEnabled}
              disabled={!nativePlanReviewEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ planReviewAutoOpenEnabled: Boolean(checked) })
              }
              aria-label="Open a ready plan automatically"
            />
          }
        />
        {/* T3-CUSTOM(expbkt3): END */}
        {/* T3-CUSTOM(expbkt3): BEGIN — agent-rendered UI surfaces in chat. */}
        <SettingsRow
          {...searchableSetting("agent-ui-surfaces")}
          description="Let an agent render a chart, diagram or table inline in the conversation. The document runs in a sandbox that cannot reach T3, your session or the network as you. While off, a t3_show_ui call stays an ordinary collapsed tool row. URL targets stay disabled either way: a framed app can show origin-local state instead of the page the agent asked for."
          control={
            <Switch
              checked={agentUiSurfacesEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ agentUiSurfacesEnabled: Boolean(checked) })
              }
              aria-label="Agent views in chat"
            />
          }
        />
        {/* T3-CUSTOM(expbkt3): END */}
        {/* T3-CUSTOM(expbkt3): BEGIN — upstream's pull request view. */}
        <SettingsRow
          {...searchableSetting("native-pull-request-view")}
          description="Open pull request links in T3's own pull request view: summary, checks, diff and review in the side panel. While off, a pull request link opens its GitHub page in the integrated browser beside the thread. Cmd/Ctrl-click still opens the system browser either way."
          control={
            <Switch
              checked={nativePullRequestViewEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ nativePullRequestViewEnabled: Boolean(checked) })
              }
              aria-label="Native pull request view"
            />
          }
        />
        {/* T3-CUSTOM(expbkt3): END */}
        {/* T3-CUSTOM(expbkt3): BEGIN — every link opens in the integrated browser. */}
        <SettingsRow
          {...searchableSetting("open-links-in-integrated-browser")}
          description="Open every link — in messages, the composer, the sidebar's Linear and pull request tags, and anywhere else — in the integrated browser beside the open thread. Cmd/Ctrl-click still opens the system browser. While off, links follow Settings → Integrations → Open links in."
          control={
            <Switch
              checked={openLinksInIntegratedBrowser}
              onCheckedChange={(checked) =>
                updateSettings({ openLinksInIntegratedBrowser: Boolean(checked) })
              }
              aria-label="Open links in the integrated browser"
            />
          }
        />
        {/* T3-CUSTOM(expbkt3): END */}
        <SettingsRow
          title="Phase-grouped sidebar"
          description="Group threads by lifecycle phase instead of repository. Repository, branch, and provider stay visible as row labels, and the original sidebar remains available when this is off."
          resetAction={
            phaseGroupedSidebarEnabled !== DEFAULT_UNIFIED_SETTINGS.phaseGroupedSidebarEnabled ? (
              <SettingResetButton
                label="phase-grouped sidebar"
                onClick={() =>
                  updateSettings({
                    phaseGroupedSidebarEnabled: DEFAULT_UNIFIED_SETTINGS.phaseGroupedSidebarEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={phaseGroupedSidebarEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ phaseGroupedSidebarEnabled: Boolean(checked) })
              }
              aria-label="Enable the phase-grouped sidebar"
            />
          }
        />
        <SettingsRow
          title="Live resource monitor"
          description="Show live CPU, memory, and disk usage of the T3 Code server."
          resetAction={
            resourceMonitorEnabled !== DEFAULT_UNIFIED_SETTINGS.resourceMonitorEnabled ? (
              <SettingResetButton
                label="live resource monitor"
                onClick={() =>
                  updateSettings({
                    resourceMonitorEnabled: DEFAULT_UNIFIED_SETTINGS.resourceMonitorEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={resourceMonitorEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ resourceMonitorEnabled: Boolean(checked) })
              }
              aria-label="Enable the live resource monitor"
            />
          }
        />
        {EXPERIMENTAL_CONTROL_CENTER_ENABLED ? (
          <SettingsRow
            title="Provider usage limits"
            description="Show compact Codex and Claude subscription-limit bars in the sidebar header. The indicator wraps below the T3 Code brand when the sidebar is too narrow."
            resetAction={
              providerRateLimitsEnabled !== DEFAULT_UNIFIED_SETTINGS.providerRateLimitsEnabled ? (
                <SettingResetButton
                  label="provider usage limits"
                  onClick={() =>
                    updateSettings({
                      providerRateLimitsEnabled: DEFAULT_UNIFIED_SETTINGS.providerRateLimitsEnabled,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={providerRateLimitsEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ providerRateLimitsEnabled: Boolean(checked) })
                }
                aria-label="Show provider usage limits"
              />
            }
          />
        ) : null}
      </SettingsSection>
      {/* T3-CUSTOM(expbkt3): BEGIN — experimental operator MCP settings seam. */}
      {EXPERIMENTAL_CONTROL_CENTER_ENABLED ? <ExternalMcpSettingsSection /> : null}
      {/* T3-CUSTOM(expbkt3): END */}
      <SessionSummarySettingsSection />
      {/* T3-CUSTOM(expbkt3): BEGIN — session work summary + progress assessment. */}
      <SessionWorkSummarySettingsSection />
      {/* T3-CUSTOM(expbkt3): END */}
      {/* T3-CUSTOM(expbkt3): BEGIN — session title maintenance. */}
      <ThreadTitleMaintenanceSettingsSection />
      {/* T3-CUSTOM(expbkt3): END */}
      {/* T3-CUSTOM(expbkt3): BEGIN — archived-session worktree reclaim. */}
      <SessionArchiveSettingsSection />
      {/* T3-CUSTOM(expbkt3): END */}
    </SettingsPageContainer>
  );
}
