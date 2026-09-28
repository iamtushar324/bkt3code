// T3-CUSTOM(expbkt3): the row that opens the host appearance sheet from
// Connections. Self-contained so the seam inside the upstream connection row is
// one element.
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { EnvironmentBadge } from "./EnvironmentBadge";
import { useEnvironmentAppearance } from "./useEnvironmentAppearance";

export function EnvironmentAppearanceButton(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const appearance = useEnvironmentAppearance(props.environmentId);
  const mutedColor = useUniwindTheme()["--color-icon-subtle"];
  if (appearance === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-[14px] border border-input-border bg-input px-3.5 py-2.5 active:opacity-70"
      onPress={() =>
        navigation.navigate("EnvironmentAppearance", { environmentId: props.environmentId })
      }
    >
      <EnvironmentBadge appearance={appearance} variant="icon" size={12} />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-t3-medium text-foreground">Appearance</Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {appearance.customized ? appearance.name : "Nickname, icon and colour"}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColor={mutedColor} type="monochrome" />
    </Pressable>
  );
}
