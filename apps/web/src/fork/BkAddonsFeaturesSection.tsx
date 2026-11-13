/**
 * T3-CUSTOM(expbkt3): the BK Add-ons feature switches. Each row shows one sentence; the full
 * explanation stays one click away behind "More".
 */
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { AgentPlanSubmissionSettingsRow } from "../components/settings/AgentPlanSubmissionSettingsRow";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { Switch } from "../components/ui/switch";
import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { SettingDescription } from "./SettingDescription";

function ClientSwitch({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <Switch
      checked={checked}
      disabled={disabled}
      onCheckedChange={(value) => onChange(Boolean(value))}
      aria-label={label}
    />
  );
}

export function BkAddonsFeaturesSection() {
  const phaseGroupedSidebarEnabled = useClientSettings(
    (settings) => settings.phaseGroupedSidebarEnabled,
  );
  const nativePlanReviewEnabled = useClientSettings((settings) => settings.nativePlanReviewEnabled);
  const planReviewAutoOpenEnabled = useClientSettings(
    (settings) => settings.planReviewAutoOpenEnabled,
  );
  const agentUiSurfacesEnabled = useClientSettings((settings) => settings.agentUiSurfacesEnabled);
  const smartGitPromptsEnabled = useClientSettings((settings) => settings.smartGitPromptsEnabled);
  const chatCommentsEnabled = useClientSettings((settings) => settings.chatCommentsEnabled);
  const nativePullRequestViewEnabled = useClientSettings(
    (settings) => settings.nativePullRequestViewEnabled,
  );
  const openLinksInIntegratedBrowser = useClientSettings(
    (settings) => settings.openLinksInIntegratedBrowser,
  );

  return (
    <SettingsSection title="Features">
      <SettingsRow
        title="BK sidebar"
        description={
          <SettingDescription
            summary="Group threads by lifecycle phase instead of repository."
            details="Repository, branch, and provider stay visible as row labels, and the original sidebar remains available when this is off."
          />
        }
        resetAction={
          phaseGroupedSidebarEnabled !== DEFAULT_UNIFIED_SETTINGS.phaseGroupedSidebarEnabled ? (
            <SettingResetButton
              label="BK sidebar"
              onClick={() =>
                updateClientSettings({
                  phaseGroupedSidebarEnabled: DEFAULT_UNIFIED_SETTINGS.phaseGroupedSidebarEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <ClientSwitch
            checked={phaseGroupedSidebarEnabled}
            label="Enable the BK sidebar"
            onChange={(checked) => updateClientSettings({ phaseGroupedSidebarEnabled: checked })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("native-plan-review")}
        description={
          <SettingDescription
            summary="Review proposed plans in a side panel."
            details="Comment on exact lines, edit the plan with tracked changes, and step through every version with its author. Approving sends a short acknowledgement instead of repeating the whole plan."
          />
        }
        control={
          <ClientSwitch
            checked={nativePlanReviewEnabled}
            label="Native plan review"
            onChange={(checked) => updateClientSettings({ nativePlanReviewEnabled: checked })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("plan-review-takeover")}
        description={
          <SettingDescription
            summary="Open a plan for review the moment it is ready (needs native plan review)."
            details="The review opens over the conversation. The chat header, the composer and the sidebar stay usable, and closing a plan keeps it closed. While off, a ready plan stays a card in the conversation."
          />
        }
        control={
          <ClientSwitch
            checked={planReviewAutoOpenEnabled}
            disabled={!nativePlanReviewEnabled}
            label="Open a ready plan automatically"
            onChange={(checked) => updateClientSettings({ planReviewAutoOpenEnabled: checked })}
          />
        }
      />
      {/* Saved on the server for every session, independent of this device's plan review. */}
      <AgentPlanSubmissionSettingsRow />
      <SettingsRow
        {...searchableSetting("agent-ui-surfaces")}
        description={
          <SettingDescription
            summary="Let an agent render a chart, diagram or table inline in the conversation."
            details="The document runs in a sandbox that cannot reach T3, your session or the network as you. While off, a t3_show_ui call stays an ordinary collapsed tool row. URL targets stay disabled either way: a framed app can show origin-local state instead of the page the agent asked for."
          />
        }
        control={
          <ClientSwitch
            checked={agentUiSurfacesEnabled}
            label="Agent views in chat"
            onChange={(checked) => updateClientSettings({ agentUiSurfacesEnabled: checked })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("chat-comments")}
        description={
          <SettingDescription
            summary="Comment on selected text in agent messages; open comments go to the agent."
            details="Mark a selection Good, Okay or Remove, or leave a comment. Open comments are highlighted in the message, listed in the Comments panel beside the chat, and sent to the agent with every message until you resolve them; the agent can reply and mark one addressed. Turning this off only hides the comment controls on this device (selection actions, highlights, the Comments panel and the composer strip). It does not stop delivery: comments that are already open on a thread still go to the agent with every message until they are resolved, so resolve them or choose Don't send first."
          />
        }
        control={
          <ClientSwitch
            checked={chatCommentsEnabled}
            label="Chat comments"
            onChange={(checked) => updateClientSettings({ chatCommentsEnabled: checked })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("smart-git-prompts")}
        description={
          <SettingDescription
            summary="The git button in a thread's header asks the agent to commit, push or open a pull request."
            details="It lights up as Commit while the worktree has uncommitted changes, then as Create PR (or Push, when a pull request is already open) once everything is committed. A click sends the request into the chat, or queues it while the agent is busy. Pull, sync and every direct git action stay in the button's dropdown. While off, the header shows the standard git button."
          />
        }
        control={
          <ClientSwitch
            checked={smartGitPromptsEnabled}
            label="Smart git button"
            onChange={(checked) => updateClientSettings({ smartGitPromptsEnabled: checked })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("native-pull-request-view")}
        description={
          <SettingDescription
            summary="Open pull request links in T3's own pull request view."
            details="It shows the summary, checks, diff and review in the side panel. While off, a pull request link opens its GitHub page in the integrated browser beside the thread. Cmd/Ctrl-click still opens the system browser either way."
          />
        }
        control={
          <ClientSwitch
            checked={nativePullRequestViewEnabled}
            label="Native pull request view"
            onChange={(checked) => updateClientSettings({ nativePullRequestViewEnabled: checked })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("open-links-in-integrated-browser")}
        description={
          <SettingDescription
            summary="Open every link in the integrated browser beside the open thread."
            details="This covers links in messages, the composer, the sidebar's Linear and pull request tags, and anywhere else. Cmd/Ctrl-click still opens the system browser. While off, links follow Settings → Integrations → Open links in."
          />
        }
        control={
          <ClientSwitch
            checked={openLinksInIntegratedBrowser}
            label="Open links in the integrated browser"
            onChange={(checked) => updateClientSettings({ openLinksInIntegratedBrowser: checked })}
          />
        }
      />
    </SettingsSection>
  );
}
