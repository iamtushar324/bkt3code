// T3-CUSTOM(expbkt3): the phase sidebar's filter and sort controls.
//
// Which facets exist, what they match and how they sanitize are all decided in
// client-runtime; this is a sheet of toggles over that. Filters live in the
// caller's state rather than here so the list and this sheet cannot disagree.
import {
  buildPhaseSidebarRepositoryOptions,
  EMPTY_PHASE_SIDEBAR_FILTERS,
  PHASE_SIDEBAR_PHASES,
  PHASE_SIDEBAR_SORT_DIRECTION_LABELS,
  type PhaseSidebarFilters,
  type PhaseSidebarRow,
  type PhaseSidebarSortPreferences,
} from "@t3tools/client-runtime/state/phase-sidebar";
import {
  PHASE_SIDEBAR_UNGROUPED_ID,
  type PhaseSidebarCustomGroupOption,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { phaseSidebarFiltersActive } from "@t3tools/client-runtime/state/phase-sidebar-tree";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { phaseSidebarSectionToneClassName } from "./phaseSidebarRowTone";

function Chip(props: {
  readonly label: string;
  readonly active: boolean;
  readonly toneClassName?: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      className={cn(
        "rounded-full border px-3 py-1.5",
        props.active ? "border-primary bg-primary/15" : "border-border bg-transparent",
      )}
      onPress={props.onPress}
    >
      <Text className={cn("text-xs", props.active ? "font-t3-bold" : "", props.toneClassName)}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-[11px] font-t3-bold uppercase tracking-wide text-foreground-muted">
        {props.title}
      </Text>
      <View className="flex-row flex-wrap gap-2">{props.children}</View>
    </View>
  );
}

export function PhaseSidebarFilterSheet(props: {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly filters: PhaseSidebarFilters;
  /** The custom groups in view, for the Group facet; works in every grouping mode. */
  readonly groups: ReadonlyArray<PhaseSidebarCustomGroupOption>;
  readonly sort: PhaseSidebarSortPreferences;
  readonly onChangeFilters: (filters: PhaseSidebarFilters) => void;
  readonly onChangeSort: (sort: PhaseSidebarSortPreferences) => void;
  readonly onClose: () => void;
}) {
  const repositories = useMemo(
    () => buildPhaseSidebarRepositoryOptions(props.projects),
    [props.projects],
  );
  // Only offer providers actually present, so the sheet does not list drivers
  // this operator never uses.
  const providers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of props.rows) seen.set(row.providerKind, row.providerName);
    return [...seen.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [props.rows]);

  const toggle = <T,>(list: ReadonlyArray<T>, value: T): ReadonlyArray<T> =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  return (
    // Sized by content and clamped by the parent's max height — a flex-1
    // ScrollView inside an unsized parent renders zero pixels tall.
    <ScrollView>
      <View className="flex-row items-center justify-between px-4 pt-3">
        <Text className="text-base font-t3-bold text-foreground">Filter</Text>
        <View className="flex-row items-center gap-4">
          {phaseSidebarFiltersActive(props.filters) ? (
            <Pressable
              hitSlop={8}
              onPress={() => props.onChangeFilters(EMPTY_PHASE_SIDEBAR_FILTERS)}
            >
              <Text className="text-xs font-t3-bold text-foreground-muted">Clear all</Text>
            </Pressable>
          ) : null}
          <Pressable hitSlop={8} onPress={props.onClose}>
            <Text className="text-xs font-t3-bold text-primary">Done</Text>
          </Pressable>
        </View>
      </View>

      <Section title="Lifecycle">
        {PHASE_SIDEBAR_PHASES.map((phase) => (
          <Chip
            active={props.filters.phaseIds.includes(phase.id)}
            key={phase.id}
            label={phase.label}
            onPress={() =>
              props.onChangeFilters({
                ...props.filters,
                phaseIds: toggle(props.filters.phaseIds, phase.id),
              })
            }
            toneClassName={phaseSidebarSectionToneClassName(phase.id)}
          />
        ))}
      </Section>

      {repositories.length === 0 ? null : (
        <Section title="Repository">
          {repositories.map((repository) => (
            <Chip
              active={props.filters.repositoryKeys.includes(repository.key)}
              key={repository.key}
              label={repository.label}
              onPress={() =>
                props.onChangeFilters({
                  ...props.filters,
                  repositoryKeys: toggle(props.filters.repositoryKeys, repository.key),
                })
              }
            />
          ))}
        </Section>
      )}

      {providers.length === 0 ? null : (
        <Section title="Provider">
          {providers.map(([kind, name]) => (
            <Chip
              active={props.filters.providerKinds.includes(kind)}
              key={kind}
              label={name}
              onPress={() =>
                props.onChangeFilters({
                  ...props.filters,
                  providerKinds: toggle(props.filters.providerKinds, kind),
                })
              }
            />
          ))}
        </Section>
      )}

      {props.groups.length === 0 && props.filters.customGroups.length === 0 ? null : (
        <Section title="Group">
          {[
            ...props.groups,
            // A selected group whose sessions all moved stays listed so the
            // selection can be undone here.
            ...props.filters.customGroups
              .filter(
                (id) => id !== PHASE_SIDEBAR_UNGROUPED_ID && !props.groups.some((g) => g.id === id),
              )
              .map((id) => ({ id, label: id, count: 0 })),
            { id: PHASE_SIDEBAR_UNGROUPED_ID, label: "Ungrouped", count: 0 },
          ].map((group) => (
            <Chip
              active={props.filters.customGroups.includes(group.id)}
              key={group.id}
              label={group.label}
              onPress={() =>
                props.onChangeFilters({
                  ...props.filters,
                  customGroups: toggle(props.filters.customGroups, group.id),
                })
              }
            />
          ))}
        </Section>
      )}

      <Section title="Ownership">
        <Chip
          active={props.filters.ownedByMe}
          label="Started by me"
          onPress={() =>
            props.onChangeFilters({ ...props.filters, ownedByMe: !props.filters.ownedByMe })
          }
        />
      </Section>

      <Section title="Sort">
        <Chip
          active={props.sort.priorityFirst}
          label="Priority first"
          onPress={() =>
            props.onChangeSort({ ...props.sort, priorityFirst: !props.sort.priorityFirst })
          }
        />
        {(["newest_first", "oldest_first"] as const).map((direction) => (
          <Chip
            active={props.sort.direction === direction}
            key={direction}
            label={PHASE_SIDEBAR_SORT_DIRECTION_LABELS[direction]}
            onPress={() => props.onChangeSort({ ...props.sort, direction })}
          />
        ))}
      </Section>
    </ScrollView>
  );
}
