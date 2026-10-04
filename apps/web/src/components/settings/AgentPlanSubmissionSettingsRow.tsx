// T3-CUSTOM(expbkt3): server-wide availability of the agent plan submission tool.
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
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
      description="Let agents use t3_submit_plan for a separate plan review. By default, this tool is disabled. Agents must write those plans in chat. This setting applies to every session on this server. Provider plan modes remain available."
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
