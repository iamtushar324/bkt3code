/**
 * T3-CUSTOM(expbkt3): EnvironmentAppearanceEditor - set a host's nickname, icon
 * and colour.
 *
 * The appearance is the host's `environmentAppearance` server setting, so a
 * change here shows for everyone connected to that host. Icon and colour write
 * on click; the nickname writes when the field loses focus or on Enter, so a
 * half-typed name is not broadcast keystroke by keystroke. The preview is the
 * live server value rather than a copy of it.
 *
 * Locked with the same rules as upstream's icon picker: the host must be
 * connected, new enough to keep the setting, and this session must be allowed
 * to change its settings (the server enforces the operate scope regardless).
 *
 * @module components/environment/EnvironmentAppearanceEditor
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  ENVIRONMENT_COLOR_OPTIONS,
  ENVIRONMENT_ICON_OPTIONS,
  environmentAccentBorder,
  environmentAccentSurface,
  environmentAppearanceSettingValue,
  type EnvironmentAppearance,
} from "../../state/environmentAppearance";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentOperateAccess } from "../settings/EnvironmentIconPicker";
import { EnvironmentBadgeView } from "./EnvironmentBadge";
import { resolveEnvironmentAppearanceLock } from "./EnvironmentAppearanceEditor.logic";

export function EnvironmentAppearanceEditor({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const environment = useEnvironment(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const operateAccess = useEnvironmentOperateAccess(environmentId);
  const serverConfig = environment?.serverConfig ?? null;
  const stored: EnvironmentAppearance = serverConfig?.settings.environmentAppearance ?? {};
  const lock = resolveEnvironmentAppearanceLock({ serverConfig, operateAccess });
  const disabled = lock !== null;
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null);

  if (environment === null) {
    return <p className="text-sm text-muted-foreground">This environment is no longer known.</p>;
  }
  const { appearance } = environment;

  const write = (next: EnvironmentAppearance | null) => {
    if (disabled) return;
    updateSettings({
      environmentAppearance: next === null ? null : environmentAppearanceSettingValue(next),
    });
  };
  const commitNickname = () => {
    if (nicknameDraft === null) return;
    setNicknameDraft(null);
    if (nicknameDraft.trim() === (stored.nickname ?? "")) return;
    write({ ...stored, nickname: nicknameDraft });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <EnvironmentBadgeView appearance={appearance} />
        {appearance.customized ? null : (
          <span className="text-xs text-muted-foreground">Derived from the environment id</span>
        )}
      </div>

      {lock !== null ? <p className="text-xs text-muted-foreground">{lock}</p> : null}

      <div className="flex flex-col gap-1.5">
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor={`environment-nickname-${environmentId}`}
        >
          Nickname
        </label>
        <Input
          id={`environment-nickname-${environmentId}`}
          value={nicknameDraft ?? stored.nickname ?? ""}
          placeholder={environment.connectionLabel}
          maxLength={40}
          disabled={disabled}
          onChange={(event) => setNicknameDraft(event.target.value)}
          onBlur={commitNickname}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitNickname();
          }}
        />
        <p className="text-xs text-muted-foreground">
          Shared with everyone connected to this environment. Leave empty to use the connection
          label.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Colour</span>
        <div className="flex flex-wrap gap-1.5">
          {ENVIRONMENT_COLOR_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-label={option.label}
              aria-pressed={appearance.colorId === option.id}
              disabled={disabled}
              onClick={() => write({ ...stored, colorId: option.id })}
              className={cn(
                "size-6 rounded-full border-2 disabled:opacity-50",
                appearance.colorId === option.id ? "border-foreground" : "border-transparent",
              )}
              style={{ backgroundColor: option.value }}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Icon</span>
        <div className="flex flex-wrap gap-1.5">
          {ENVIRONMENT_ICON_OPTIONS.map((option) => {
            const selected = appearance.iconId === option.id;
            const Icon = option.Icon;
            return (
              <button
                key={option.id}
                type="button"
                aria-label={option.label}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => write({ ...stored, iconId: option.id })}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-md border disabled:opacity-50",
                  selected ? "" : "border-border text-muted-foreground hover:text-foreground",
                )}
                style={
                  selected
                    ? {
                        color: appearance.color,
                        backgroundColor: environmentAccentSurface(appearance.color),
                        borderColor: environmentAccentBorder(appearance.color),
                      }
                    : undefined
                }
              >
                <Icon className="size-3.5" />
              </button>
            );
          })}
        </div>
      </div>

      {appearance.customized ? (
        <div>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => write(null)}>
            <RotateCcwIcon />
            Reset to default
          </Button>
        </div>
      ) : null}
    </div>
  );
}
