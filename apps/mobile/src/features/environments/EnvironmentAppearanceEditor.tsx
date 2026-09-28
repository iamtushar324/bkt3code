// T3-CUSTOM(expbkt3): set a host's nickname, icon and colour.
//
// Writes the host's `environmentAppearance` server setting, shared with everyone
// connected to it. Icon and colour write on tap; the nickname writes when the
// field loses focus or is submitted, so a half-typed name is not broadcast
// keystroke by keystroke. The preview at the top is the live server value.
import {
  ENVIRONMENT_COLOR_OPTIONS,
  ENVIRONMENT_ICON_DESCRIPTORS,
  type EnvironmentAppearance,
  environmentAppearanceSettingValue,
} from "@t3tools/client-runtime/state/environment-appearance";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { EnvironmentBadge } from "./EnvironmentBadge";
import { environmentIconSymbol, type MobileEnvironmentAppearance } from "./environmentAppearance";
import {
  useEnvironmentAppearanceLock,
  useStoredEnvironmentAppearance,
  useUpdateEnvironmentAppearance,
} from "./useEnvironmentAppearance";

function FieldLabel(props: { readonly children: string }) {
  return (
    <Text className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
      {props.children}
    </Text>
  );
}

export function EnvironmentAppearanceEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly appearance: MobileEnvironmentAppearance;
  /** The connection label, shown as the placeholder when no nickname is set. */
  readonly fallbackName: string;
}) {
  const { environmentId, appearance } = props;
  const stored = useStoredEnvironmentAppearance(environmentId);
  const update = useUpdateEnvironmentAppearance();
  const lock = useEnvironmentAppearanceLock(environmentId);
  const disabled = lock !== null;
  const checkColor = String(useUniwindTheme()["--color-primary-foreground"]);
  const [nicknameDraft, setNicknameDraft] = useState<string | null>(null);
  // Each write replaces the whole value and the host echoes it back only after a
  // round trip: build writes on the last value sent, so a quick second tap does not
  // undo the first.
  const [pending, setPending] = useState<EnvironmentAppearance | undefined>(undefined);
  const storedKey = JSON.stringify(environmentAppearanceSettingValue(stored ?? {}));
  useEffect(() => {
    if (pending === undefined) return;
    if (JSON.stringify(environmentAppearanceSettingValue(pending)) === storedKey) {
      setPending(undefined);
    }
  }, [pending, storedKey]);
  const current: EnvironmentAppearance = pending ?? stored ?? {};

  const patch = (changes: EnvironmentAppearance) => {
    if (disabled) return;
    const next = { ...current, ...changes };
    setPending(next);
    update(environmentId, next);
  };
  const commitNickname = () => {
    if (nicknameDraft === null) return;
    setNicknameDraft(null);
    if (nicknameDraft.trim() === (current.nickname ?? "")) return;
    patch({ nickname: nicknameDraft });
  };

  return (
    <View className="gap-5">
      <View className="flex-row items-center gap-3 rounded-[14px] border border-border bg-subtle px-3 py-2.5">
        <EnvironmentBadge appearance={appearance} variant="icon" />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
            {appearance.name}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {appearance.customized
              ? "Shared with everyone on this host"
              : "Derived from the environment id"}
          </Text>
        </View>
        {appearance.customized && !disabled ? (
          <Pressable
            accessibilityLabel="Reset environment appearance"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => update(environmentId, null)}
          >
            <Text className="text-xs font-t3-bold text-primary">Reset</Text>
          </Pressable>
        ) : null}
      </View>

      {lock !== null ? <Text className="text-xs text-foreground-muted">{lock}</Text> : null}

      <View className="gap-1.5">
        <FieldLabel>Nickname</FieldLabel>
        <TextInput
          autoCapitalize="words"
          autoCorrect={false}
          className="rounded-[14px] border border-input-border bg-input px-4 py-3 text-base text-foreground"
          editable={!disabled}
          maxLength={40}
          onBlur={commitNickname}
          onChangeText={setNicknameDraft}
          onSubmitEditing={commitNickname}
          placeholder={props.fallbackName}
          returnKeyType="done"
          value={nicknameDraft ?? current.nickname ?? ""}
        />
        <Text className="text-xs text-foreground-tertiary">
          Shown to everyone connected to this host. Leave empty to use the connection label.
        </Text>
      </View>

      <View className="gap-1.5">
        <FieldLabel>Icon</FieldLabel>
        <View className="flex-row flex-wrap gap-2">
          {ENVIRONMENT_ICON_DESCRIPTORS.map((descriptor) => {
            const active = (current.iconId ?? appearance.iconId) === descriptor.id;
            return (
              <Pressable
                accessibilityLabel={descriptor.label}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled }}
                className={cn(
                  "h-11 w-11 items-center justify-center rounded-[12px] border",
                  active ? "border-primary bg-primary/15" : "border-border bg-transparent",
                  disabled && "opacity-50",
                )}
                disabled={disabled}
                key={descriptor.id}
                onPress={() => patch({ iconId: descriptor.id })}
              >
                <SymbolView
                  fallback={
                    <Text className="text-[10px] text-foreground-muted">
                      {descriptor.label.slice(0, 2)}
                    </Text>
                  }
                  name={environmentIconSymbol(descriptor.id)}
                  size={17}
                  tintColor={appearance.color}
                  type="monochrome"
                />
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="gap-1.5">
        <FieldLabel>Colour</FieldLabel>
        <View className="flex-row flex-wrap gap-2.5">
          {ENVIRONMENT_COLOR_OPTIONS.map((option) => {
            const active = (current.colorId ?? appearance.colorId) === option.id;
            return (
              <Pressable
                accessibilityLabel={option.label}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled }}
                className={cn(
                  "h-8 w-8 items-center justify-center rounded-full",
                  disabled && "opacity-50",
                )}
                disabled={disabled}
                key={option.id}
                onPress={() => patch({ colorId: option.id })}
                style={{ backgroundColor: option.value }}
              >
                {active ? (
                  <SymbolView name="checkmark" size={12} tintColor={checkColor} type="monochrome" />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
