#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()

def require_replace(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

def read(rel):
    return (root / rel).read_text(encoding="utf-8")

def write(rel, text):
    (root / rel).write_text(text, encoding="utf-8")

# Stack-level transitions, with no layout or style redesign.
p = "app/_layout.tsx"
s = read(p)
s = require_replace(s, '<Stack screenOptions={{ headerShown: false }}>', '<Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }}>', p)
write(p, s)

# Start the mesh on Android app launch. This runs independently of chat crypto setup.
p = "lib/jesr/runtime.tsx"
s = read(p)
s = require_replace(
    s,
    'import { addJesrDataListener, addMeshListener, isJesrNativeAvailable, sendJesrData, setJesrId, startMesh, stopMesh, type JesrSnapshot } from "@/modules/jesr-network";',
    'import { addJesrDataListener, addMeshListener, getMeshSnapshot, isJesrNativeAvailable, sendJesrData, setJesrId, startMesh, type JesrSnapshot } from "@/modules/jesr-network";',
    p + " import"
)
s = s.replace('  toggleMesh(): Promise<string | null>;\n', '')
a = s.index("async function askPermissions() {")
b = s.index("\n}\n\nfunction useNativeApi()", a) + 2
permission_fn = """async function askPermissions() {
  if (Platform.OS !== "android") return;
  const api = Number(Platform.Version);
  const required: Permission[] = api >= 31
    ? [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  required.push(api >= 33
    ? PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES
    : PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);

  const missing: Permission[] = [];
  for (const permission of [...new Set(required)]) {
    if (!(await PermissionsAndroid.check(permission))) missing.push(permission);
  }
  if (missing.length) {
    const result = await PermissionsAndroid.requestMultiple(missing);
    const denied = missing.filter((permission) => result[permission] !== PermissionsAndroid.RESULTS.GRANTED);
    if (denied.length) {
      throw new Error("يلزم السماح بأذونات Bluetooth والأجهزة القريبة لتفعيل شبكة جسر تلقائياً.");
    }
  }

  // Notification permission is optional for mesh transport.
  if (api >= 33 && !(await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS))) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
}"""
s = s[:a] + permission_fn + s[b:]
s = require_replace(
    s,
    """    (async () => {
      try {
        const e = new JesrEngine""",
    """    (async () => {
      // Auto-start local radios on app launch, regardless of chat-engine initialization.
      if (Platform.OS === "android" && isJesrNativeAvailable) {
        try {
          const current = await getMeshSnapshot();
          setSnap({ active: current.active, peers: current.peers });
          if (!current.active) {
            await askPermissions();
            const latest = await getMeshSnapshot();
            if (!latest.active) {
              const started = await startMesh("balanced");
              setSnap({ active: started.active, peers: started.peers });
            }
          }
        } catch (startError: any) {
          setError(String(startError?.message ?? startError));
        }
      }
      try {
        const e = new JesrEngine""",
    p + " auto start"
)
toggle = """      toggleMesh: async () => {
        try { if (snap.active) await stopMesh(); else { await askPermissions(); await startMesh("balanced"); } return null; }
        catch (err: any) { return String(err?.message ?? err); }
      },
"""
s = require_replace(s, toggle, "", p + " toggle method")
s = s.replace('    setName: async () => {}, toggleMesh: async () => "التشغيل الحقيقي يتطلب بناء Android أصليًا",\n', '    setName: async () => {},\n')
write(p, s)

# Remove only the obsolete manual mesh toggle card from Account.
p = "app/(tabs)/me.tsx"
s = read(p)
marker = '          <Text style={s.h}>الشبكة المحلية</Text>'
if marker not in s:
    raise SystemExit(p + ": network card marker not found")
m = s.index(marker)
a = s.rfind("        <View style={s.card}>", 0, m)
b = s.index("        </View>", m) + len("        </View>\n")
s = s[:a] + s[b:]
write(p, s)

# Remove start/stop and radio-mode controls from the diagnostics screen.
p = "app/(tabs)/index.tsx"
s = read(p)
s = s.replace("  PermissionsAndroid,\n  Platform,\n", "")
s = s.replace("  type Permission,\n", "")
s = s.replace("  startMesh,\n  stopMesh,\n", "")
s = s.replace("  type JesrMode,\n", "")
s = s.replace('  const [mode, setMode] = useState<JesrMode>("balanced");\n', "")
s = s.replace("      setMode(next.batteryMode);\n", "")
s = s.replace("      setMode(state.batteryMode);\n", "")
a = s.index("  async function requestAndroidPermissions() {")
b = s.index("\n  async function runAction", a)
s = s[:a] + s[b:]
a = s.index("  async function handleStart() {")
b = s.index("\n  async function handleDiscover()", a)
s = s[:a] + s[b:]
a = s.index("        <View style={styles.controlsPanel}>")
b = s.index("\n        <View style={styles.footer}>", a)
panel = """        <View style={styles.controlsPanel}>
          <Text style={styles.sectionTitle}>حالة الشبكة المحلية</Text>
          <Text style={styles.helperText}>{active ? "الشبكة مفعّلة تلقائياً وتعمل في الخلفية عبر خدمة Android." : "يجري تفعيل الشبكة تلقائياً عند فتح التطبيق بعد منح أذونات الأجهزة القريبة."}</Text>
          <View style={styles.buttonRow}>
            <ActionButton title="البحث عن أجهزة" onPress={handleDiscover} disabled={busy || !active} />
          </View>
          <Text style={styles.privacyNote}>لا حسابات ولا موقع GPS ولا خادم. لا يبدأ التطبيق نقل بيانات الجوال؛ الاتصال محلي بين الأجهزة.</Text>
        </View>"""
s = s[:a] + panel + s[b:]
mode_component = """function ModeChip({ title, selected, disabled = false, onPress }: { title: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.modeChip, selected && styles.modeChipSelected, disabled && styles.disabledButton]}><Text style={[styles.modeText, selected && styles.modeTextSelected]}>{title}</Text></Pressable>;
}

"""
s = s.replace(mode_component, "")
for line in [
'  modeRow: { flexDirection: "row-reverse", gap: 9 },\n',
'  modeChip: { borderWidth: 1, borderColor: palette.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },\n',
'  modeChipSelected: { borderColor: palette.teal, backgroundColor: "#173D3C" },\n',
'  modeText: { color: palette.muted, fontSize: 10, fontWeight: "700", writingDirection: "rtl" },\n',
'  modeTextSelected: { color: palette.teal },\n',
]:
    s = s.replace(line, "")
write(p, s)

# Motion only: same existing views, layout and colors.
p = "app/(tabs)/chats.tsx"
s = read(p)
s = require_replace(s, 'import { useMemo, useState } from "react";', 'import { useMemo, useState } from "react";\nimport Animated, { FadeIn, FadeInDown, FadeInUp } from "react-native-reanimated";', p)
s = require_replace(s, '    <View style={s.page}>', '    <Animated.View entering={FadeIn.duration(260)} style={s.page}>', p)
s = require_replace(s, '      <View style={s.sheet}>', '      <Animated.View entering={FadeInUp.duration(340)} style={s.sheet}>', p)
s = require_replace(s, 'renderItem={({ item }) => (\n              <Pressable style={s.row}', 'renderItem={({ item, index }) => (\n              <Animated.View entering={FadeInDown.delay(Math.min(index, 7) * 35).duration(280)}><Pressable style={s.row}', p + " friends")
s = require_replace(s, '              </Pressable>\n            )} />', '              </Pressable></Animated.View>\n            )} />', p + " friends close")
s = require_replace(s, 'renderItem={({ item }) => (\n              <View style={s.row}>', 'renderItem={({ item, index }) => (\n              <Animated.View entering={FadeInDown.delay(Math.min(index, 7) * 35).duration(280)}><View style={s.row}>', p + " requests")
s = require_replace(s, '              </View>\n            )} />', '              </View></Animated.View>\n            )} />', p + " requests close")
s = require_replace(s, '      </View>\n    </View>\n  );\n}', '      </Animated.View>\n    </Animated.View>\n  );\n}', p + " screen close")
write(p, s)

p = "app/(tabs)/me.tsx"
s = read(p)
s = require_replace(s, 'import { useState } from "react";', 'import { useState } from "react";\nimport Animated, { FadeInDown } from "react-native-reanimated";', p)
s = s.replace('<View style={s.card}>', '<Animated.View entering={FadeInDown.delay(60).duration(300)} style={s.card}>', 1)
s = s.replace('</View>\n        <View style={s.card}>', '</Animated.View>\n        <Animated.View entering={FadeInDown.delay(130).duration(300)} style={s.card}>', 1)
s = s.replace('</View>\n        <View style={s.card}>', '</Animated.View>\n        <Animated.View entering={FadeInDown.delay(200).duration(300)} style={s.card}>', 1)
s = require_replace(s, '</View>\n      </ScrollView>', '</Animated.View>\n      </ScrollView>', p + " cards close")
write(p, s)

p = "app/chat/[id].tsx"
s = read(p)
s = require_replace(s, 'import { useEffect, useRef, useState } from "react";', 'import { useEffect, useRef, useState } from "react";\nimport Animated, { FadeInUp } from "react-native-reanimated";', p)
s = require_replace(s, '<View style={[s.bubble, m.dir === "out" ? s.out : s.in]}>', '<Animated.View entering={FadeInUp.duration(220)} style={[s.bubble, m.dir === "out" ? s.out : s.in]}>', p)
s = require_replace(s, '</Text>\n            </View>)} />', '</Text>\n            </Animated.View>)} />', p + " message close")
write(p, s)

runtime = read("lib/jesr/runtime.tsx")
account = read("app/(tabs)/me.tsx")
diagnostics = read("app/(tabs)/index.tsx")
assert 'await startMesh("balanced")' in runtime
assert "toggleMesh" not in runtime and "toggleMesh" not in account
assert "بدء الشبكة" not in diagnostics and "إيقاف الشبكة" not in diagnostics
assert "handleStart" not in diagnostics and "ModeChip" not in diagnostics
assert "FadeInDown" in read("app/(tabs)/chats.tsx")
assert "FadeInUp" in read("app/chat/[id].tsx")
print("Jesr patch complete.")
