// T3-CUSTOM(expbkt3): the sheet that hosts the environment appearance editor.
// Opened from Settings → Connections and from the phase sidebar's Group-by
// sheet. The appearance is the host's shared server setting, so a change here
// shows for everyone connected to that host, on every device.
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useEnvironments } from "../../state/environments";
import { EnvironmentAppearanceEditor } from "./EnvironmentAppearanceEditor";
import { useEnvironmentAppearance } from "./useEnvironmentAppearance";

type EnvironmentAppearanceSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
}>;

export function EnvironmentAppearanceSheet({ route }: EnvironmentAppearanceSheetProps) {
  const { environmentId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId) ?? null;
  const appearance = useEnvironmentAppearance(environmentId);
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
      {/* T3-CUSTOM(expbkt3): preserve separate native header and scroll views
          so RNS can size the form sheet safely at either detent. */}
      <View
        collapsable={false}
        className="flex-row items-center justify-between bg-sheet-solid px-4"
        style={{ paddingTop: Math.max(insets.top, 16) }}
      >
        <Text className="text-base font-t3-bold text-foreground">Environment appearance</Text>
        <Pressable
          accessibilityLabel="Done"
          accessibilityRole="button"
          hitSlop={8}
          onPress={dismiss}
        >
          <Text className="text-xs font-t3-bold text-primary">Done</Text>
        </Pressable>
      </View>
      {/* T3-CUSTOM(expbkt3): keep this as the header's direct sibling. An
          ordinary wrapper prevents RNS from measuring the sheet viewport. */}
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 16,
        }}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
      >
        {environment === null || appearance === null ? (
          <Text className="text-sm text-foreground-muted">
            This environment is no longer known.
          </Text>
        ) : (
          <EnvironmentAppearanceEditor
            appearance={appearance}
            environmentId={environmentId}
            fallbackName={environment.label}
          />
        )}
      </ScrollView>
    </>
  );
}
