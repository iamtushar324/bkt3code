// T3-CUSTOM(expbkt3): the fork's extra "New threads" rows and the option-carrying
// model change, kept out of upstream's ProjectDefaultsSettings so that file
// only gains one-line mounts.
//
// Both rows follow upstream's scoped-write pattern: at an environment scope
// they edit the host value (on every selected host), at a project or checkout
// scope they edit that project's override entry, through the same hooks the
// Model and Workspace rows use.
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { getProviderModelCapabilities } from "../../providerModels";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Build",
  plan: "Plan",
};

function isInteractionMode(value: string | null): value is ProviderInteractionMode {
  return value === "default" || value === "plan";
}

/** Plan or Build for new threads. Applies where the plan toggle is available. */
export function StartingModeDefaultRow({ isProjectScope }: { isProjectScope: boolean }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["defaultThreadInteractionMode"]);
  const value = settings.defaultThreadInteractionMode;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["defaultThreadInteractionMode"]}
      mixed={mixed}
      {...searchableSetting("default-starting-mode")}
      description={
        isProjectScope
          ? "Whether new threads in this project start in Plan or Build mode."
          : "Whether new threads start in Plan or Build mode. Projects can override it."
      }
      resetAction={
        value !== DEFAULT_SERVER_SETTINGS.defaultThreadInteractionMode ? (
          <SettingResetButton
            label="default starting mode"
            onClick={() =>
              updateSettings({
                defaultThreadInteractionMode: DEFAULT_SERVER_SETTINGS.defaultThreadInteractionMode,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : value}
          onValueChange={(next) => {
            if (isInteractionMode(next)) updateSettings({ defaultThreadInteractionMode: next });
          }}
        >
          <SelectTrigger size="sm" aria-label="Default starting mode">
            <SelectValue>
              {(current: string | null) =>
                isInteractionMode(current) ? INTERACTION_MODE_LABELS[current] : "Mixed"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="default">{INTERACTION_MODE_LABELS.default}</SelectItem>
            <SelectItem value="plan">{INTERACTION_MODE_LABELS.plan}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

/**
 * The permissions row for a project scope. Upstream renders this row inline at
 * the environment scope only; a project's override entry supports the key, so
 * the project panel gets the same control.
 */
export function PermissionsDefaultRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["defaultRuntimeMode"]);
  const PermissionIcon = runtimeModeConfig[settings.defaultRuntimeMode].icon;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["defaultRuntimeMode"]}
      mixed={mixed}
      {...searchableSetting("default-permissions")}
      description="Permissions for new threads in this project."
      control={
        <Select
          value={mixed ? null : settings.defaultRuntimeMode}
          onValueChange={(value) => {
            if (value) updateSettings({ defaultRuntimeMode: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Default permissions">
            {!mixed && <PermissionIcon className="size-3.5 shrink-0 text-muted-foreground" />}
            <SelectValue>
              {mixed ? "Mixed" : runtimeModeConfig[settings.defaultRuntimeMode].label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const Icon = option.icon;
              return (
                <SelectItem key={mode} value={mode} className="min-w-64">
                  <div className="grid gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      {option.label}
                    </span>
                    <span className="text-xs leading-4 text-muted-foreground">
                      {option.description}
                    </span>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
      }
    />
  );
}

/**
 * A default-model change that keeps the saved effort and context options.
 * Options carry when the new instance runs the same driver (option ids are
 * per driver) and only where the new model has a matching trait; a value the
 * model does not offer falls back to that trait's default, an unknown trait is
 * dropped.
 */
export function carryModelOptionsToSelection(input: {
  readonly previous: ModelSelection | null;
  readonly previousEntry: Pick<ProviderInstanceEntry, "driverKind"> | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly entry: Pick<ProviderInstanceEntry, "driverKind" | "models"> | undefined;
  readonly planModeAvailable: boolean;
}): ModelSelection {
  const { previous, previousEntry, instanceId, model, entry, planModeAvailable } = input;
  if (
    !previous?.options?.length ||
    entry === undefined ||
    previousEntry === undefined ||
    previousEntry.driverKind !== entry.driverKind
  ) {
    return createModelSelection(instanceId, model);
  }
  const caps = getProviderModelCapabilities(
    entry.models,
    model,
    entry.driverKind,
    planModeAvailable,
  );
  const descriptors = getProviderOptionDescriptors({ caps, selections: previous.options });
  return createModelSelection(
    instanceId,
    model,
    buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, previous.options),
  );
}
