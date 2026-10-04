/** T3-CUSTOM(expbkt3): The server controls whether agents can submit plans through MCP. */
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function PlanSubmissionSettingsRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const enabled = settings.experimental.planSubmissionToolEnabled;

  return (
    <SettingsRow
      {...searchableSetting("plan-submission-tool")}
      description="Let agents use t3_submit_plan for a separate plan review. By default, this tool is disabled. Agents must write those plans in chat. This setting applies to every session on this server. Provider plan modes remain available."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({
              experimental: {
                planSubmissionToolEnabled: Boolean(checked),
              },
            })
          }
          aria-label="Plan submission tool"
        />
      }
    />
  );
}
