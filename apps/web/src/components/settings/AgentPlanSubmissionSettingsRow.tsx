// T3-CUSTOM(expbkt3): server-wide availability of the agent plan submission tool.
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { SettingDescription } from "../../fork/SettingDescription";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AgentPlanSubmissionSettingsRow() {
  const enabled = usePrimarySettings(
    (settings) => settings.experimental.agentPlanSubmissionEnabled,
  );
  const available = usePrimarySettingsAvailable();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("plan-submission-tool")}
      description={
        <SettingDescription
          summary="Let agents submit plans with t3_submit_plan, for every session on this server."
          details="By default, this tool is disabled and agents must write their plans in chat. Provider plan modes remain available."
        />
      }
      control={
        <Switch
          checked={enabled}
          disabled={!available}
          onCheckedChange={(checked) =>
            updateSettings({ experimental: { agentPlanSubmissionEnabled: Boolean(checked) } })
          }
          aria-label="Plan submission tool"
        />
      }
    />
  );
}
