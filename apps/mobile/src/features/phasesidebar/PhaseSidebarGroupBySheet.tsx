// T3-CUSTOM(expbkt3): the "Group by" sheet — lifecycle, projects, or custom
// groups — plus the management of those groups. Same chip idiom as the filter
// sheet so the two read as one control set.
//
// The groups are the threads' shared labels plus the hosts' shared registry
// (names and colours, XFN-59); the pane owns the reads and the server writes,
// this sheet only asks. Naming a group is an inline text field
// rather than a system prompt: `Alert.prompt` is iOS-only, and a field the
// user can see is easier to correct than a dialog that has already closed.
import {
  PHASE_SIDEBAR_GROUP_BY_LABELS,
  PHASE_SIDEBAR_GROUP_BY_MODES,
  PHASE_SIDEBAR_GROUP_LABEL_MAX_LENGTH,
  PHASE_SIDEBAR_GROUP_ORDER_LABELS,
  PHASE_SIDEBAR_GROUP_ORDERS,
  setPhaseSidebarGroupBy,
  setPhaseSidebarGroupOrder,
  type PhaseSidebarCustomGroupOption,
  type PhaseSidebarGroupingPreferences,
  type PhaseSidebarGroupOrder,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
// T3-CUSTOM(expbkt3): a custom group's colour (XFN-59).
import { PHASE_SIDEBAR_CUSTOM_GROUP_COLOR_OPTIONS } from "@t3tools/client-runtime/state/phase-sidebar-custom-group-registry";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { EnvironmentBadge } from "../environments/EnvironmentBadge";
import type { MobileEnvironmentAppearance } from "../environments/environmentAppearance";

function Chip(props: {
  readonly label: string;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      className={cn(
        "rounded-full border px-3 py-1.5",
        props.active ? "border-primary bg-primary/15" : "border-border bg-transparent",
      )}
      onPress={props.onPress}
    >
      <Text className={cn("text-xs", props.active ? "font-t3-bold" : "")}>{props.label}</Text>
    </Pressable>
  );
}

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-[11px] font-t3-bold uppercase tracking-wide text-foreground-muted">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

/** What the sheet was opened to do, beyond browsing. */
export type PhaseSidebarGroupBySheetIntent =
  | { readonly kind: "browse" }
  | { readonly kind: "create"; readonly seedThreadKey: string | null }
  | { readonly kind: "rename"; readonly groupId: string; readonly label: string };

export function PhaseSidebarGroupBySheet(props: {
  /** Every known environment with its resolved identity, for the picker below. */
  readonly environments: ReadonlyMap<string, MobileEnvironmentAppearance>;
  readonly grouping: PhaseSidebarGroupingPreferences;
  /** Every custom group in view, in manual order (see listPhaseSidebarCustomGroups). */
  readonly groups: ReadonlyArray<PhaseSidebarCustomGroupOption>;
  readonly intent: PhaseSidebarGroupBySheetIntent;
  readonly onChange: (
    apply: (current: PhaseSidebarGroupingPreferences) => PhaseSidebarGroupingPreferences,
  ) => void;
  /** A seed thread is filed straight into the new group; without one it is an empty placeholder. */
  readonly onCreateGroup: (label: string, seedThreadKey: string | null) => void;
  readonly onRenameGroup: (id: string, label: string) => void;
  readonly onDeleteGroup: (id: string) => void;
  readonly onMoveGroup: (
    orderedIds: ReadonlyArray<string>,
    id: string,
    direction: "up" | "down",
  ) => void;
  /** Absent when no connected host keeps shared groups for this session. */
  readonly onRecolorGroup?: (id: string, colorId: string | null) => void;
  readonly onClose: () => void;
  /** Opens the host appearance sheet for one environment. */
  readonly onOpenEnvironment: (environmentId: EnvironmentId) => void;
}) {
  const { grouping, groups, intent, onChange } = props;
  const iconColor = String(useUniwindTheme()["--color-icon"]);
  const placeholderColor = String(useUniwindTheme()["--color-foreground-tertiary"]);
  const checkColor = String(useUniwindTheme()["--color-primary-foreground"]);
  // The group whose colour swatches are open inline, if any.
  const [colorEditingId, setColorEditingId] = useState<string | null>(null);
  // The inline editor: null when closed, otherwise what it is naming.
  const [editor, setEditor] = useState<
    | { readonly kind: "create"; readonly seedThreadKey: string | null; readonly label: string }
    | { readonly kind: "rename"; readonly groupId: string; readonly label: string }
    | null
  >(null);

  useEffect(() => {
    if (intent.kind === "create") {
      setEditor({ kind: "create", seedThreadKey: intent.seedThreadKey, label: "" });
    } else if (intent.kind === "rename") {
      setEditor({ kind: "rename", groupId: intent.groupId, label: intent.label });
    }
    // Only when the intent changes: editing must not reset on every prefs write.
  }, [intent]);

  const orders: ReadonlyArray<PhaseSidebarGroupOrder> =
    grouping.groupBy === "custom"
      ? PHASE_SIDEBAR_GROUP_ORDERS
      : PHASE_SIDEBAR_GROUP_ORDERS.filter((order) => order !== "manual");
  const effectiveOrder =
    grouping.groupBy === "project" && grouping.groupOrder === "manual"
      ? "name"
      : grouping.groupOrder;
  const orderedIds = groups.map((group) => group.id);

  const commitEditor = () => {
    if (editor === null) return;
    const label = editor.label.trim();
    if (label.length === 0) return;
    if (editor.kind === "create") props.onCreateGroup(label, editor.seedThreadKey);
    else props.onRenameGroup(editor.groupId, label);
    setEditor(null);
  };

  return (
    // Sized by content and clamped by the parent's max height — a flex-1
    // ScrollView inside an unsized parent renders zero pixels tall.
    <ScrollView keyboardShouldPersistTaps="handled">
      <View className="flex-row items-center justify-between px-4 pt-3">
        <Text className="text-base font-t3-bold text-foreground">Group by</Text>
        <Pressable hitSlop={8} onPress={props.onClose}>
          <Text className="text-xs font-t3-bold text-primary">Done</Text>
        </Pressable>
      </View>

      <Section title="Group by">
        <View className="flex-row flex-wrap gap-2">
          {PHASE_SIDEBAR_GROUP_BY_MODES.map((mode) => (
            <Chip
              active={grouping.groupBy === mode}
              key={mode}
              label={PHASE_SIDEBAR_GROUP_BY_LABELS[mode]}
              onPress={() => onChange((current) => setPhaseSidebarGroupBy(current, mode))}
            />
          ))}
        </View>
      </Section>

      {grouping.groupBy === "lifecycle" ? null : (
        <Section title="Order groups">
          <View className="flex-row flex-wrap gap-2">
            {orders.map((order) => (
              <Chip
                active={effectiveOrder === order}
                key={order}
                label={PHASE_SIDEBAR_GROUP_ORDER_LABELS[order]}
                onPress={() => onChange((current) => setPhaseSidebarGroupOrder(current, order))}
              />
            ))}
          </View>
        </Section>
      )}

      {grouping.groupBy === "custom" || editor !== null ? (
        <Section title="Groups">
          {groups.length === 0 && editor === null ? (
            <Text className="text-xs text-foreground-muted">
              No groups yet. Create one, then hold any session and choose “Move to group”. Groups
              are shared with everyone who can see the session.
            </Text>
          ) : null}
          {groups.map((group, index) =>
            editor?.kind === "rename" && editor.groupId === group.id ? null : (
              <View key={group.id}>
                <View className="flex-row items-center gap-2 py-1">
                  <View
                    accessibilityElementsHidden
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      group.color === undefined && "border border-foreground-tertiary",
                    )}
                    importantForAccessibility="no"
                    style={group.color === undefined ? undefined : { backgroundColor: group.color }}
                  />
                  <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                    {group.label}
                  </Text>
                  <Text className="font-t3-mono text-[10px] text-foreground-muted">
                    {group.count}
                  </Text>
                  {grouping.groupOrder === "manual" ? (
                    <>
                      <Pressable
                        accessibilityLabel={`Move ${group.label} up`}
                        disabled={index === 0}
                        hitSlop={6}
                        onPress={() => props.onMoveGroup(orderedIds, group.id, "up")}
                        style={{ opacity: index === 0 ? 0.3 : 1 }}
                      >
                        <SymbolView
                          name="arrow.up"
                          size={13}
                          tintColor={iconColor}
                          type="monochrome"
                        />
                      </Pressable>
                      <Pressable
                        accessibilityLabel={`Move ${group.label} down`}
                        disabled={index === groups.length - 1}
                        hitSlop={6}
                        onPress={() => props.onMoveGroup(orderedIds, group.id, "down")}
                        style={{ opacity: index === groups.length - 1 ? 0.3 : 1 }}
                      >
                        <SymbolView
                          name="arrow.down"
                          size={13}
                          tintColor={iconColor}
                          type="monochrome"
                        />
                      </Pressable>
                    </>
                  ) : null}
                  {props.onRecolorGroup ? (
                    <Pressable
                      accessibilityLabel={`Change colour of ${group.label}`}
                      accessibilityState={{ expanded: colorEditingId === group.id }}
                      hitSlop={6}
                      onPress={() =>
                        setColorEditingId((current) => (current === group.id ? null : group.id))
                      }
                    >
                      <SymbolView
                        name="paintbrush"
                        size={13}
                        tintColor={iconColor}
                        type="monochrome"
                      />
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityLabel={`Rename ${group.label}`}
                    hitSlop={6}
                    onPress={() =>
                      setEditor({ kind: "rename", groupId: group.id, label: group.label })
                    }
                  >
                    <SymbolView name="pencil" size={13} tintColor={iconColor} type="monochrome" />
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`Delete ${group.label}`}
                    hitSlop={6}
                    onPress={() => props.onDeleteGroup(group.id)}
                  >
                    <SymbolView name="trash" size={13} tintColor={iconColor} type="monochrome" />
                  </Pressable>
                </View>
                {props.onRecolorGroup && colorEditingId === group.id ? (
                  <View className="flex-row flex-wrap items-center gap-2 pb-2 pl-4">
                    <Pressable
                      accessibilityLabel="Default colour"
                      accessibilityRole="button"
                      accessibilityState={{ selected: group.colorId === undefined }}
                      className={cn(
                        "rounded-full border px-2.5 py-1",
                        group.colorId === undefined ? "border-primary" : "border-border",
                      )}
                      onPress={() => {
                        props.onRecolorGroup?.(group.id, null);
                        setColorEditingId(null);
                      }}
                    >
                      <Text className="text-xs text-foreground">Default</Text>
                    </Pressable>
                    {PHASE_SIDEBAR_CUSTOM_GROUP_COLOR_OPTIONS.map((option) => {
                      const active = group.colorId === option.id;
                      return (
                        <Pressable
                          accessibilityLabel={option.label}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          className="h-7 w-7 items-center justify-center rounded-full"
                          key={option.id}
                          onPress={() => {
                            props.onRecolorGroup?.(group.id, option.id);
                            setColorEditingId(null);
                          }}
                          style={{ backgroundColor: option.value }}
                        >
                          {active ? (
                            <SymbolView
                              name="checkmark"
                              size={11}
                              tintColor={checkColor}
                              type="monochrome"
                            />
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            ),
          )}
          {editor === null ? (
            <Pressable
              accessibilityRole="button"
              className="mt-1 flex-row items-center gap-1.5 self-start rounded-full border border-border px-3 py-1.5"
              onPress={() => setEditor({ kind: "create", seedThreadKey: null, label: "" })}
            >
              <SymbolView name="plus" size={11} tintColor={iconColor} type="monochrome" />
              <Text className="text-xs text-foreground">New group</Text>
            </Pressable>
          ) : (
            <View className="mt-1 flex-row items-center gap-2">
              <TextInput
                accessibilityLabel="Group name"
                autoFocus
                className="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm text-foreground"
                maxLength={PHASE_SIDEBAR_GROUP_LABEL_MAX_LENGTH}
                onChangeText={(label) => setEditor({ ...editor, label })}
                onSubmitEditing={commitEditor}
                placeholder={editor.kind === "create" ? "e.g. This week" : "Group name"}
                placeholderTextColor={placeholderColor}
                returnKeyType="done"
                value={editor.label}
              />
              <Pressable hitSlop={8} onPress={() => setEditor(null)}>
                <Text className="text-xs text-foreground-muted">Cancel</Text>
              </Pressable>
              <Pressable
                disabled={editor.label.trim().length === 0}
                hitSlop={8}
                onPress={commitEditor}
                style={{ opacity: editor.label.trim().length === 0 ? 0.4 : 1 }}
              >
                <Text className="text-xs font-t3-bold text-primary">
                  {editor.kind === "create" ? "Create" : "Save"}
                </Text>
              </Pressable>
            </View>
          )}
        </Section>
      ) : null}

      {props.environments.size > 0 ? (
        <Section title="Environments">
          <Text className="text-xs text-foreground-muted">
            Give each host a nickname, icon and colour so its sessions stand out. Shared with
            everyone connected to that host.
          </Text>
          {[...props.environments.entries()].map(([environmentId, appearance]) => (
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-3 py-1.5"
              key={environmentId}
              onPress={() => props.onOpenEnvironment(environmentId as EnvironmentId)}
            >
              <EnvironmentBadge appearance={appearance} variant="icon" size={12} />
              <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                {appearance.name}
              </Text>
              <SymbolView name="chevron.right" size={11} tintColor={iconColor} type="monochrome" />
            </Pressable>
          ))}
        </Section>
      ) : null}
    </ScrollView>
  );
}
