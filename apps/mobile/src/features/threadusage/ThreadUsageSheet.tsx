// T3-CUSTOM(expbkt3): the per-thread cost breakdown, opened from the header pill.
//
// Same facts as the web popover — total, tokens in / cached / out, per-model
// rows, per-day rows, provenance — laid out for a form sheet.
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId, ThreadUsage } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { costSourceLabel, formatThreadCost, useThreadUsage } from "./useThreadUsage";

type ThreadUsageSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>;

function Stat(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="min-w-0 flex-1 gap-0.5">
      <Text className="text-[10px] uppercase tracking-wide text-foreground-tertiary">
        {props.label}
      </Text>
      <Text className="font-t3-mono text-sm tabular-nums text-foreground" numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  );
}

function SectionTitle(props: { readonly children: string }) {
  return (
    <Text className="px-4 pb-1.5 pt-4 text-[11px] font-t3-bold uppercase tracking-wide text-foreground-muted">
      {props.children}
    </Text>
  );
}

function Row(props: { readonly left: string; readonly sub?: string; readonly right: string }) {
  return (
    <View className="flex-row items-center gap-3 px-4 py-2">
      <View className="min-w-0 flex-1">
        <Text className="text-sm text-foreground" numberOfLines={1}>
          {props.left}
        </Text>
        {props.sub === undefined ? null : (
          <Text className="font-t3-mono text-[10px] text-foreground-tertiary" numberOfLines={1}>
            {props.sub}
          </Text>
        )}
      </View>
      <Text className="shrink-0 font-t3-mono text-sm tabular-nums text-foreground">
        {props.right}
      </Text>
    </View>
  );
}

function tokensOf(usage: ThreadUsage["models"][number] | ThreadUsage) {
  return (
    usage.totals.uncachedInputTokens + usage.totals.cachedInputTokens + usage.totals.outputTokens
  );
}

export function ThreadUsageSheet({ route }: ThreadUsageSheetProps) {
  const { environmentId, threadId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const iconColor = String(useUniwindTheme()["--color-icon"]);
  const { usage, isPending, refresh, label } = useThreadUsage(environmentId, threadId);
  const dismiss = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    // T3-CUSTOM(expbkt3): cold-linked sheets have no route to pop.
    navigation.dispatch(StackActions.replace("Home"));
  };

  return (
    <>
      {/* T3-CUSTOM(expbkt3): keep the form-sheet header as its own native view.
          RNS measures this sibling separately from the scroll owner at each detent. */}
      <View
        collapsable={false}
        className="flex-row items-center justify-between bg-sheet-solid px-4"
        style={{ paddingTop: Math.max(insets.top, 16) }}
      >
        <Text className="text-base font-t3-bold text-foreground">Session cost</Text>
        <View className="flex-row items-center gap-4">
          <Pressable
            accessibilityLabel="Refresh session cost"
            accessibilityRole="button"
            accessibilityState={{ disabled: isPending }}
            disabled={isPending}
            hitSlop={8}
            onPress={() => refresh()}
          >
            {isPending ? (
              <ActivityIndicator size="small" />
            ) : (
              <SymbolView
                name="arrow.clockwise"
                size={15}
                tintColor={iconColor}
                type="monochrome"
              />
            )}
          </Pressable>
          <Pressable
            accessibilityLabel="Done"
            accessibilityRole="button"
            hitSlop={8}
            onPress={dismiss}
          >
            <Text className="text-xs font-t3-bold text-primary">Done</Text>
          </Pressable>
        </View>
      </View>

      {/* T3-CUSTOM(expbkt3): RNS requires the scroll view to be the direct
          companion to the fixed header for form-sheet viewport sizing. */}
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 16 }}
        contentInsetAdjustmentBehavior="never"
      >
        <View className="px-4 pt-3">
          <Text className="font-t3-bold text-4xl tabular-nums text-foreground">{label}</Text>
          <Text className="mt-1 text-xs text-foreground-muted">
            {usage === null ? "Reading provider transcripts…" : costSourceLabel(usage)}
          </Text>
        </View>

        {usage === null ? null : (
          <>
            <View className="mx-4 mt-4 flex-row gap-3 rounded-xl border border-border bg-subtle p-3">
              <Stat label="Input" value={formatTokens(usage.totals.uncachedInputTokens)} />
              <Stat label="Cached" value={formatTokens(usage.totals.cachedInputTokens)} />
              <Stat label="Output" value={formatTokens(usage.totals.outputTokens)} />
              <Stat label="Usage records" value={String(usage.records)} />
            </View>
            {usage.cacheSavingsUsd > 0 ? (
              <Text className="px-4 pt-2 text-xs text-foreground-muted">
                Prompt caching saved about {formatThreadCost(usage.cacheSavingsUsd)} against full
                input rates.
              </Text>
            ) : null}

            {usage.models.length > 0 ? (
              <>
                <SectionTitle>By model</SectionTitle>
                {usage.models.map((row) => (
                  <Row
                    key={`${row.provider}:${row.model}`}
                    left={row.model}
                    right={formatThreadCost(row.costUsd)}
                    sub={`${row.provider.toUpperCase()} · ${formatTokens(tokensOf(row))} tokens · ${row.records} usage record${row.records === 1 ? "" : "s"}`}
                  />
                ))}
              </>
            ) : null}

            {usage.days.length > 1 ? (
              <>
                <SectionTitle>By day</SectionTitle>
                {usage.days.map((row) => (
                  <Row
                    key={row.day}
                    left={row.day}
                    right={formatThreadCost(row.costUsd)}
                    sub={`${formatTokens(tokensOf(row as unknown as ThreadUsage))} tokens`}
                  />
                ))}
              </>
            ) : null}

            <Text className="px-4 pt-5 text-[11px] leading-4 text-foreground-tertiary">
              Estimate at API list prices from the same rate table as the Usage page. A subscription
              bills differently; this is the yardstick for how heavy a session is.
            </Text>
          </>
        )}
      </ScrollView>
    </>
  );
}
