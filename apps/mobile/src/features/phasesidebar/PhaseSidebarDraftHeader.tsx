// T3-CUSTOM(expbkt3): a separate collapsible shelf for unstarted mobile drafts.
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

export function PhaseSidebarDraftHeader(props: {
  readonly count: number;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`Drafts, ${props.count} draft${props.count === 1 ? "" : "s"}${props.collapsed ? ", collapsed" : ""}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: !props.collapsed }}
      className="flex-row items-center gap-2 px-4 pb-1.5 pt-4"
      onPress={props.onToggle}
    >
      <SymbolView
        name={props.collapsed ? "chevron.right" : "chevron.down"}
        size={10}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
      <Text className="flex-1 font-t3-bold text-[11px] uppercase tracking-wide text-foreground-secondary">
        Drafts
      </Text>
      <Text className="font-t3-mono text-[10px] text-foreground-tertiary">{props.count}</Text>
    </Pressable>
  );
}
