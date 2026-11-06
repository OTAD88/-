import { Stack } from "expo-router";
import { JesrProvider } from "@/lib/jesr/runtime";
import { ThemeProvider } from "@/lib/theme-provider";

export default function RootLayout() {
  return (
    <ThemeProvider>
      <JesrProvider>
        <Stack screenOptions={{ headerShown: false, animation: "none" }}>
          <Stack.Screen name="index" />
        </Stack>
      </JesrProvider>
    </ThemeProvider>
  );
}
