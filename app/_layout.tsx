import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Platform } from "react-native";

import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { JesrProvider } from "@/lib/jesr/runtime";
import { ThemeProvider } from "@/lib/theme-provider";

/**
 * Keep every context-dependent hook inside its provider.
 * In particular, useColors() reads ThemeContext and must not run in the
 * same component that only creates ThemeProvider in its returned JSX.
 */
function AppTabs() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomPadding = Platform.OS === "web" ? 12 : Math.max(insets.bottom, 8);
  const tabBarHeight = 56 + bottomPadding;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.tint,
        headerShown: false,
        tabBarStyle: {
          paddingTop: 8,
          paddingBottom: bottomPadding,
          height: tabBarHeight,
          backgroundColor: colors.background,
          borderTopColor: colors.border,
          borderTopWidth: 0.5,
        },
      }}
    >
      <Tabs.Screen name="chat/[id]" options={{ href: null }} />
      <Tabs.Screen name="chats" options={{ title: "المحادثات", tabBarIcon: ({ color }) => <IconSymbol size={28} name="paperplane.fill" color={color} /> }} />
      <Tabs.Screen name="me" options={{ title: "حسابي", tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} /> }} />
      <Tabs.Screen
        name="index"
        options={{
          title: "الشبكة",
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="point.3.connected.trianglepath.dotted" color={color} />,
        }}
      />
      <Tabs.Screen
        name="lab"
        options={{
          title: "مختبر المحاكاة",
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="paperplane.fill" color={color} />,
        }}
      />
    </Tabs>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <JesrProvider>
        <AppTabs />
      </JesrProvider>
    </ThemeProvider>
  );
}
