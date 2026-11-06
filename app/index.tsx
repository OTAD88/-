import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  type Permission,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Svg, { Circle, Path } from "react-native-svg";
import { SafeAreaView } from "react-native-safe-area-context";
import { useJesr } from "@/lib/jesr/runtime";
import { MAX_TEXT_CHARS } from "@/lib/jesr/engine";
import {
  addMeshListener,
  discoverMeshPeers,
  getMeshSnapshot,
  isJesrNativeAvailable,
  startMesh,
  type JesrPeer,
  type JesrSnapshot,
} from "@/modules/jesr-network/src";

type ThemeMode = "auto" | "light" | "dark" | "custom";
type SavedColor = { id: string; name: string; hex: string };
type Palette = {
  page: string; top: string; surface: string; surfaceAlt: string; primary: string;
  primaryText: string; text: string; muted: string; border: string; subtle: string;
  chat: string; bubbleIn: string; bubbleOut: string; bubbleText: string; input: string;
};
const ORIGINAL = "#5B6654";
const THEME_MODE_KEY = "jesr_theme_mode";
const ACCENT_KEY = "jesr_accent_color";
const SAVED_COLORS_KEY = "jesr_saved_colors";
const ORIGINAL_COLOR: SavedColor = { id: "original", name: "الأصلي", hex: ORIGINAL };

function hexToRgb(hex: string) {
  const raw = hex.replace("#", "");
  const value = raw.length === 3 ? raw.split("").map((x) => x + x).join("") : raw;
  const number = parseInt(value, 16);
  return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
}
function rgbToHex(r: number, g: number, b: number) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
}
function mix(a: string, b: string, amount: number) {
  const x = hexToRgb(a); const y = hexToRgb(b);
  return rgbToHex(x.r * (1 - amount) + y.r * amount, x.g * (1 - amount) + y.g * amount, x.b * (1 - amount) + y.b * amount);
}
function luminance(hex: string) {
  const c = hexToRgb(hex);
  const channel = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}
function hslToHex(h: number, s: number, l: number) {
  const sat = s / 100; const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0; let g = 0; let b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
function getHue(hex: string) {
  const { r: rr, g: gg, b: bb } = hexToRgb(hex);
  const r = rr / 255; const g = gg / 255; const b = bb / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const delta = max - min;
  if (delta === 0) return 0;
  let h = 0;
  if (max === r) h = 60 * (((g - b) / delta) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  return (h + 360) % 360;
}
function makePalette(mode: ThemeMode, accent: string, systemDark: boolean): Palette {
  const dark = mode === "dark" || (mode === "auto" && systemDark) || (mode === "custom" && luminance(accent) < 0.24);
  if (mode === "custom") {
    const onAccent = luminance(accent) < 0.42 ? "#FFFFFF" : "#212529";
    if (dark) {
      const background = mix(accent, "#212529", 0.88);
      return {
        page: background, top: accent, surface: mix(accent, "#212529", 0.68),
        surfaceAlt: mix(accent, "#212529", 0.54), primary: accent, primaryText: onAccent,
        text: "#FFFFFF", muted: mix(accent, "#D0D7DC", 0.58), border: mix(accent, "#D0D7DC", 0.2),
        subtle: mix(accent, "#212529", 0.38), chat: background,
        bubbleIn: mix(accent, "#212529", 0.58), bubbleOut: mix(accent, "#212529", 0.32),
        bubbleText: "#FFFFFF", input: mix(accent, "#212529", 0.42),
      };
    }
    return {
      page: mix(accent, "#FFFFFF", 0.82), top: accent, surface: "#FFFFFF",
      surfaceAlt: mix(accent, "#FFFFFF", 0.9), primary: accent, primaryText: onAccent,
      text: "#212529", muted: mix(accent, "#212529", 0.42), border: mix(accent, "#A3ADB2", 0.55),
      subtle: mix(accent, "#FFFFFF", 0.72), chat: accent,
      bubbleIn: "#FFFFFF", bubbleOut: mix(accent, "#FFFFFF", 0.73),
      bubbleText: "#212529", input: mix(accent, "#FFFFFF", 0.76),
    };
  }
  if (dark) {
    return {
      page: "#212529", top: "#212529", surface: "#2B3136", surfaceAlt: "#343B40",
      primary: "#8FA187", primaryText: "#212529", text: "#FFFFFF", muted: "#D0D7DC",
      border: "#4B555B", subtle: "#394147", chat: "#212529",
      bubbleIn: "#343B40", bubbleOut: "#5B6654", bubbleText: "#FFFFFF", input: "#394147",
    };
  }
  return {
    page: "#A3ADB2", top: ORIGINAL, surface: "#FFFFFF", surfaceAlt: "#F5F7F6",
    primary: ORIGINAL, primaryText: "#FFFFFF", text: "#212529", muted: "#5F6B63",
    border: "#D0D7DC", subtle: "#D0D7DC", chat: ORIGINAL,
    bubbleIn: "#FFFFFF", bubbleOut: "#D0D7DC", bubbleText: "#212529", input: "#D0D7DC",
  };
}
async function requestNearbyPermissions() {
  if (Platform.OS !== "android") return;
  const api = Number(Platform.Version);
  const permissions: Permission[] = [];
  if (api >= 31) {
    permissions.push(
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    );
  }
  if (api >= 33) permissions.push(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES);
  else permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  const unique = [...new Set(permissions)];
  const result = await PermissionsAndroid.requestMultiple(unique);
  const denied = unique.filter((permission) => result[permission] !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied.length) throw new Error("يلزم السماح بأذونات الأجهزة القريبة حتى يبدأ جسر الاتصال تلقائيًا.");
  if (api >= 33) await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}

const wheelSlices = Array.from({ length: 72 }, (_, i) => {
  const start = (-90 + i * 5) * Math.PI / 180;
  const end = (-90 + (i + 1) * 5) * Math.PI / 180;
  const x1 = 88 + 82 * Math.cos(start); const y1 = 88 + 82 * Math.sin(start);
  const x2 = 88 + 82 * Math.cos(end); const y2 = 88 + 82 * Math.sin(end);
  const d = "M 88 88 L " + x1 + " " + y1 + " A 82 82 0 0 1 " + x2 + " " + y2 + " Z";
  return { d, color: "hsl(" + (i * 5) + ", 88%, 36%)" };
});

function ColorWheel({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const hue = getHue(value);
  const angle = (hue - 90) * Math.PI / 180;
  const markerX = 88 + 57 * Math.cos(angle); const markerY = 88 + 57 * Math.sin(angle);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="عجلة اختيار اللون"
      onPress={(event) => {
        const x = event.nativeEvent.locationX - 88;
        const y = event.nativeEvent.locationY - 88;
        const radius = Math.min(1, Math.sqrt(x * x + y * y) / 82);
        const angleNow = Math.atan2(y, x) * 180 / Math.PI;
        const selectedHue = (angleNow + 90 + 360) % 360;
        const saturation = 72 + radius * 25;
        onChange(hslToHex(selectedHue, saturation, 36));
      }}
      style={styles.wheel}
    >
      <Svg width={176} height={176} viewBox="0 0 176 176">
        {wheelSlices.map((slice, index) => <Path key={index} d={slice.d} fill={slice.color} />)}
        <Circle cx={88} cy={88} r={82} stroke="#FFFFFF" strokeWidth={2} fill="none" />
        <Circle cx={markerX} cy={markerY} r={9} fill={value} stroke="#FFFFFF" strokeWidth={3} />
      </Svg>
    </Pressable>
  );
}

export default function HomeScreen() {
  const api = useJesr();
  const systemScheme = useColorScheme();
  const systemDark = systemScheme === "dark";
  const autoStarted = useRef(false);
  const [tab, setTab] = useState<"chats" | "profile">("chats");
  const [peer, setPeer] = useState<string | null>(null);
  const [requestTab, setRequestTab] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [friendId, setFriendId] = useState("");
  const [friendMethod, setFriendMethod] = useState<"id" | "nearby">("id");
  const [nearbyPeers, setNearbyPeers] = useState<JesrPeer[]>([]);
  const [name, setName] = useState("مستخدم جسر");
  const [addOpen, setAddOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [networkError, setNetworkError] = useState("");
  const [sending, setSending] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  const [accent, setAccent] = useState(ORIGINAL);
  const [savedColors, setSavedColors] = useState<SavedColor[]>([ORIGINAL_COLOR]);
  const [themeLoaded, setThemeLoaded] = useState(false);

  const colors = useMemo(() => makePalette(themeMode, accent, systemDark), [themeMode, accent, systemDark]);

  useEffect(() => {
    let alive = true;
    AsyncStorage.multiGet([THEME_MODE_KEY, ACCENT_KEY, SAVED_COLORS_KEY, "jesr_display_name"]).then((entries) => {
      if (!alive) return;
      const values = Object.fromEntries(entries);
      if (values[THEME_MODE_KEY] === "auto" || values[THEME_MODE_KEY] === "light" || values[THEME_MODE_KEY] === "dark" || values[THEME_MODE_KEY] === "custom") {
        setThemeMode(values[THEME_MODE_KEY] as ThemeMode);
      }
      if (values[ACCENT_KEY] && /^#[0-9A-Fa-f]{6}$/.test(values[ACCENT_KEY])) setAccent(values[ACCENT_KEY].toUpperCase());
      if (values[SAVED_COLORS_KEY]) {
        try {
          const parsed = JSON.parse(values[SAVED_COLORS_KEY]) as SavedColor[];
          const valid = Array.isArray(parsed) ? parsed.filter((item) => item && /^#[0-9A-Fa-f]{6}$/.test(item.hex)) : [];
          setSavedColors([ORIGINAL_COLOR, ...valid.filter((item) => item.id !== "original")]);
        } catch { setSavedColors([ORIGINAL_COLOR]); }
      }
      if (values.jesr_display_name) setName(values.jesr_display_name);
      setThemeLoaded(true);
    }).catch(() => setThemeLoaded(true));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!themeLoaded) return;
    void AsyncStorage.multiSet([
      [THEME_MODE_KEY, themeMode],
      [ACCENT_KEY, accent],
      [SAVED_COLORS_KEY, JSON.stringify(savedColors)],
    ]);
  }, [themeLoaded, themeMode, accent, savedColors]);

  useEffect(() => {
    if (api.profile.name && api.profile.name !== "…") setName(api.profile.name);
  }, [api.profile.name]);

  useEffect(() => {
    if (!isJesrNativeAvailable) return;
    let alive = true;
    const stateSub = addMeshListener<JesrSnapshot>("onMeshState", (snapshot) => setNearbyPeers(snapshot.peers));
    const peerSub = addMeshListener<JesrPeer>("onPeerDiscovered", (newPeer) => {
      setNearbyPeers((items) => [...items.filter((item) => item.id !== newPeer.id), newPeer]);
    });
    void getMeshSnapshot().then((snapshot) => { if (alive) setNearbyPeers(snapshot.peers); }).catch(() => {});
    return () => { alive = false; stateSub.remove(); peerSub.remove(); };
  }, []);

  useEffect(() => {
    if (!isJesrNativeAvailable || autoStarted.current) return;
    autoStarted.current = true;
    let alive = true;
    const begin = async () => {
      try {
        await requestNearbyPermissions();
        if (!alive) return;
        const snapshot = await getMeshSnapshot();
        if (!snapshot.active) await startMesh("balanced");
        if (alive) await discoverMeshPeers();
      } catch (error) {
        if (alive) setNetworkError(error instanceof Error ? error.message : "تعذر بدء الشبكة تلقائيًا.");
      }
    };
    void begin();
    return () => { alive = false; };
  }, []);

  const stylesColor = colors;
  const isChat = peer !== null;
  const messages = peer ? api.history(peer) : [];
  useEffect(() => {
    if (peer) void api.markRead(peer);
  }, [peer, messages.length]);

  const visibleChats = useMemo(
    () => api.conversations.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()) || item.peer.toLowerCase().includes(query.toLowerCase())),
    [api.conversations, query],
  );

  async function submitFriendById(idValue: string) {
    const id = idValue.trim();
    if (!id) { Alert.alert("إضافة صديق", "أدخل معرّف جسر الخاص بصديقك."); return; }
    if (!api.ready) { Alert.alert("جسر", "المحرك لم يجهز بعد."); return; }
    const result = await api.addFriend(id);
    if (result) Alert.alert("تعذرت الإضافة", result);
    else { setFriendId(""); setAddOpen(false); Alert.alert("طلب الصداقة", "أُرسل الطلب. سيظهر عند وصوله إلى الجهاز الآخر."); }
  }

  async function submitFriend() {
    await submitFriendById(friendId);
  }

  async function sendMessage() {
    if (!peer || !message.trim() || sending) return;
    const text = message.trim();
    setSending(true);
    try { await api.sendText(peer, text); setMessage(""); }
    catch (error) { Alert.alert("تعذر الإرسال", error instanceof Error ? error.message : "تعذر إرسال الرسالة."); }
    finally { setSending(false); }
  }

  async function saveName() {
    if (!api.ready) return;
    try { await api.setName(name); await AsyncStorage.setItem("jesr_display_name", name); Alert.alert("الحساب", "تم حفظ الاسم."); }
    catch (error) { Alert.alert("الحساب", error instanceof Error ? error.message : "تعذر حفظ الاسم."); }
  }

  function saveCurrentColor() {
    const hex = accent.toUpperCase();
    if (savedColors.some((item) => item.hex === hex)) return;
    const next = [...savedColors, { id: hex, name: "لون محفوظ", hex }];
    setSavedColors(next);
  }

  function chooseSavedColor(item: SavedColor) {
    setAccent(item.hex);
    setThemeMode("custom");
  }

  const networkLabel = !isJesrNativeAvailable
    ? "معاينة"
    : api.meshActive ? "الشبكة تعمل" : networkError ? "بحاجة إلى إذن" : "يجري الاتصال";
  const networkColor = !isJesrNativeAvailable ? colors.muted : api.meshActive ? "#4B9B73" : networkError ? "#C18B45" : colors.muted;

  return (
    <SafeAreaView style={[styles.app, { backgroundColor: stylesColor.page }]} edges={["top", "bottom"]}>
      <StatusBar barStyle={luminance(stylesColor.top) < 0.35 ? "light-content" : "dark-content"} backgroundColor={stylesColor.top} />
      {isChat ? (
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={[styles.chatHeader, { backgroundColor: stylesColor.surface, borderBottomColor: stylesColor.border }]}>
            <Pressable onPress={() => setPeer(null)} style={styles.backButton}><Text style={[styles.backText, { color: stylesColor.primary }]}>‹</Text></Pressable>
            <View style={[styles.avatar, { backgroundColor: stylesColor.primary }]}><Text style={[styles.avatarLetter, { color: stylesColor.primaryText }]}>{api.nameOf(peer || "").slice(0, 1)}</Text></View>
            <View style={styles.flex}>
              <Text style={[styles.contactName, { color: stylesColor.text }]}>{api.nameOf(peer || "")}</Text>
              <Text style={[styles.contactState, { color: stylesColor.muted }]}>{api.meshActive ? "متصل بالشبكة المحلية" : "ستُرسل الرسائل عند عودة الاتصال"}</Text>
            </View>
          </View>
          <ScrollView
            style={[styles.chatBody, { backgroundColor: stylesColor.chat }]}
            contentContainerStyle={styles.messageList}
            keyboardShouldPersistTaps="handled"
          >
            {messages.length === 0 ? <Text style={styles.chatEmpty}>ابدأ المحادثة برسالتك الأولى</Text> : messages.map((item) => (
              <View key={item.id} style={[styles.bubble, { alignSelf: item.dir === "out" ? "flex-end" : "flex-start", backgroundColor: item.dir === "out" ? stylesColor.bubbleOut : stylesColor.bubbleIn }]}>
                <Text style={[styles.messageText, { color: stylesColor.bubbleText }]}>{item.text}</Text>
                <Text style={[styles.messageMeta, { color: stylesColor.muted }]}>
                  {new Date(item.ts).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })} {item.dir === "out" ? (item.status === "delivered" ? "✓✓" : item.status === "failed" ? "!" : "✓") : ""}
                </Text>
              </View>
            ))}
          </ScrollView>
          <View style={[styles.composer, { backgroundColor: stylesColor.surface, borderTopColor: stylesColor.border }]}>
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder="اكتب رسالة..."
              placeholderTextColor={stylesColor.muted}
              style={[styles.messageInput, { color: stylesColor.text, backgroundColor: stylesColor.input }]}
              multiline
              maxLength={MAX_TEXT_CHARS}
              textAlign="right"
            />
            <Pressable accessibilityRole="button" accessibilityLabel="إرسال الرسالة" disabled={!message.trim() || sending || !api.ready} onPress={sendMessage} style={[styles.sendButton, { backgroundColor: stylesColor.primary, opacity: !message.trim() || sending || !api.ready ? 0.5 : 1 }]}>
              {sending ? <ActivityIndicator color={stylesColor.primaryText} /> : <Text style={[styles.sendGlyph, { color: stylesColor.primaryText }]}>➤</Text>}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      ) : (
        <>
          <View style={[styles.mainHeader, { backgroundColor: stylesColor.top }]}>
            <View style={styles.headerMainRow}>
              <View>
                <Text style={[styles.brand, { color: luminance(stylesColor.top) < 0.45 ? "#FFFFFF" : "#212529" }]}>جسر</Text>
                <Text style={[styles.brandSub, { color: luminance(stylesColor.top) < 0.45 ? "#E5EAE4" : "#303A33" }]}>مراسلة محلية بلا إنترنت</Text>
              </View>
              <View style={[styles.statusWrap, { backgroundColor: luminance(stylesColor.top) < 0.45 ? "rgba(255,255,255,0.15)" : "rgba(33,37,41,0.08)" }]}>
                <View style={[styles.statusDot, { backgroundColor: networkColor }]} />
                <Text style={[styles.statusText, { color: luminance(stylesColor.top) < 0.45 ? "#FFFFFF" : "#212529" }]}>{networkLabel}</Text>
              </View>
            </View>
            {tab === "chats" ? (
              <View style={styles.headerTitleRow}>
                <Text style={[styles.headerTitle, { color: luminance(stylesColor.top) < 0.45 ? "#FFFFFF" : "#212529" }]}>المحادثات</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="إضافة صديق" onPress={() => setAddOpen(true)} style={[styles.addButton, { borderColor: luminance(stylesColor.top) < 0.45 ? "rgba(255,255,255,0.8)" : "rgba(33,37,41,0.65)" }]}>
                  <Text style={[styles.addButtonText, { color: stylesColor.primaryText }]}>+</Text>
                </Pressable>
              </View>
            ) : <Text style={[styles.headerTitle, { color: luminance(stylesColor.top) < 0.45 ? "#FFFFFF" : "#212529" }]}>حسابي</Text>}
          </View>

          <View style={[styles.sheet, { backgroundColor: stylesColor.surface }]}>
            {tab === "chats" ? (
              <>
                <View style={styles.filterRow}>
                  <Pressable onPress={() => setRequestTab(false)} style={[styles.filterChip, { backgroundColor: !requestTab ? stylesColor.primary : stylesColor.subtle }]}>
                    <Text style={{ color: !requestTab ? stylesColor.primaryText : stylesColor.text }}>الرسائل</Text>
                  </Pressable>
                  <Pressable onPress={() => setRequestTab(true)} style={[styles.filterChip, { backgroundColor: requestTab ? stylesColor.primary : stylesColor.subtle }]}>
                    <Text style={{ color: requestTab ? stylesColor.primaryText : stylesColor.text }}>الطلبات {api.requests.length ? "(" + api.requests.length + ")" : ""}</Text>
                  </Pressable>
                  <View style={styles.flex} />
                  <Pressable accessibilityRole="button" accessibilityLabel="بحث" onPress={() => { setSearchOpen((v) => !v); setQuery(""); }} style={styles.searchButton}>
                    <Text style={[styles.searchGlyph, { color: stylesColor.primary }]}>⌕</Text>
                  </Pressable>
                </View>
                {searchOpen && <TextInput value={query} onChangeText={setQuery} placeholder="ابحث عن محادثة أو معرّف..." placeholderTextColor={stylesColor.muted} style={[styles.searchInput, { backgroundColor: stylesColor.input, color: stylesColor.text }]} textAlign="right" />}
                <Text style={[styles.listHeading, { color: stylesColor.text }]}>{requestTab ? "طلبات الصداقة" : "أحدث الرسائل"}</Text>
                {requestTab ? (
                  <FlatList
                    data={api.requests}
                    keyExtractor={(item) => item.jesrId}
                    ListEmptyComponent={<Text style={[styles.emptyText, { color: stylesColor.muted }]}>لا توجد طلبات حاليًا</Text>}
                    renderItem={({ item }) => (
                      <View style={[styles.contactRow, { borderBottomColor: stylesColor.border }]}>
                        <View style={[styles.avatar, { backgroundColor: stylesColor.primary }]}><Text style={[styles.avatarLetter, { color: stylesColor.primaryText }]}>{item.name.slice(0, 1)}</Text></View>
                        <View style={styles.flex}>
                          <Text style={[styles.contactName, { color: stylesColor.text }]}>{item.name}</Text>
                          <Text style={[styles.preview, { color: stylesColor.muted }]}>{item.state === "incoming" ? "يريد إضافتك" : "بانتظار الموافقة"}</Text>
                        </View>
                        {item.state === "incoming" && (
                          <View style={styles.requestActions}>
                            <Pressable onPress={() => void api.accept(item.jesrId)} style={[styles.miniAction, { backgroundColor: stylesColor.primary }]}><Text style={{ color: stylesColor.primaryText }}>قبول</Text></Pressable>
                            <Pressable onPress={() => void api.reject(item.jesrId)} style={[styles.miniAction, { backgroundColor: stylesColor.subtle }]}><Text style={{ color: stylesColor.text }}>رفض</Text></Pressable>
                          </View>
                        )}
                      </View>
                    )}
                  />
                ) : (
                  <FlatList
                    data={visibleChats}
                    keyExtractor={(item) => item.peer}
                    ListEmptyComponent={<Text style={[styles.emptyText, { color: stylesColor.muted }]}>{api.ready ? "لا توجد محادثات بعد. أضف صديقًا للبدء." : "يتم تجهيز المحرك المحلي..."}</Text>}
                    renderItem={({ item }) => (
                      <Pressable onPress={() => setPeer(item.peer)} style={[styles.contactRow, { borderBottomColor: stylesColor.border }]}>
                        <View style={[styles.avatar, { backgroundColor: stylesColor.primary }]}><Text style={[styles.avatarLetter, { color: stylesColor.primaryText }]}>{item.name.slice(0, 1)}</Text></View>
                        <View style={styles.flex}>
                          <Text numberOfLines={1} style={[styles.contactName, { color: stylesColor.text }]}>{item.name}</Text>
                          <Text numberOfLines={1} style={[styles.preview, { color: stylesColor.muted }]}>{item.last?.text ?? "ابدأ محادثة جديدة"}</Text>
                        </View>
                        <View style={styles.chatMeta}>
                          <Text style={[styles.timeText, { color: stylesColor.muted }]}>{item.last ? new Date(item.last.ts).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" }) : ""}</Text>
                          {item.unread > 0 ? <Text style={[styles.unread, { backgroundColor: stylesColor.primary, color: stylesColor.primaryText }]}>{item.unread}</Text> : <Text style={{ color: stylesColor.primary, fontSize: 12 }}>{item.last?.dir === "out" ? (item.last.status === "delivered" ? "✓✓" : "✓") : ""}</Text>}
                        </View>
                      </Pressable>
                    )}
                  />
                )}
                {networkError ? <Text style={[styles.networkError, { color: stylesColor.muted }]}>{networkError}</Text> : null}
                {!api.ready && <Text style={[styles.networkError, { color: stylesColor.muted }]}>إن كانت هذه نسخة معاينة، فالإرسال الحقيقي يتطلب APK أندرويد مدمجًا بمحرك جسر.</Text>}
              </>
            ) : (
              <ScrollView contentContainerStyle={styles.profileContent}>
                <View style={[styles.profileCard, { backgroundColor: stylesColor.surfaceAlt, borderColor: stylesColor.border }]}>
                  <Text style={[styles.cardTitle, { color: stylesColor.text }]}>ملفك الشخصي</Text>
                  <Text style={[styles.profileLabel, { color: stylesColor.muted }]}>معرّف جسر</Text>
                  <Text selectable style={[styles.profileId, { color: stylesColor.text }]}>{api.profile.jesrId}</Text>
                  <Pressable disabled={!api.ready} onPress={() => Share.share({ message: "أضفني على جسر باستخدام هذا المعرّف:\n" + api.profile.jesrId })} style={[styles.primaryWide, { backgroundColor: stylesColor.primary, opacity: api.ready ? 1 : 0.5 }]}>
                    <Text style={{ color: stylesColor.primaryText, fontWeight: "700" }}>مشاركة المعرّف</Text>
                  </Pressable>
                  <Text style={[styles.profileLabel, { color: stylesColor.muted }]}>اسم العرض</Text>
                  <TextInput value={name} onChangeText={setName} maxLength={30} style={[styles.profileInput, { color: stylesColor.text, backgroundColor: stylesColor.input }]} textAlign="right" />
                  <Pressable onPress={() => void saveName()} disabled={!api.ready} style={[styles.primaryWide, { backgroundColor: stylesColor.primary, opacity: api.ready ? 1 : 0.5 }]}>
                    <Text style={{ color: stylesColor.primaryText, fontWeight: "700" }}>حفظ الاسم</Text>
                  </Pressable>
                </View>
                <View style={[styles.profileCard, { backgroundColor: stylesColor.surfaceAlt, borderColor: stylesColor.border }]}>
                  <Text style={[styles.cardTitle, { color: stylesColor.text }]}>المظهر والألوان</Text>
                  <Text style={[styles.profileLabel, { color: stylesColor.muted }]}>اختر مظهر جسر، ويمكن تخصيص اللون وحفظه.</Text>
                  <Pressable onPress={() => setThemeOpen(true)} style={[styles.primaryWide, { backgroundColor: stylesColor.primary }]}>
                    <Text style={{ color: stylesColor.primaryText, fontWeight: "700" }}>فتح إعدادات المظهر</Text>
                  </Pressable>
                </View>
                <View style={[styles.profileCard, { backgroundColor: stylesColor.surfaceAlt, borderColor: stylesColor.border }]}>
                  <Text style={[styles.cardTitle, { color: stylesColor.text }]}>حالة الشبكة</Text>
                  <Text style={[styles.profileLabel, { color: stylesColor.muted }]}>{api.meshActive ? "الشبكة المحلية تعمل ويجري اكتشاف الأجهزة تلقائيًا." : isJesrNativeAvailable ? "يحاول جسر بدء الشبكة تلقائيًا عند فتح التطبيق." : "المعاينة لا تتصل بالأجهزة الحقيقية."}</Text>
                </View>
              </ScrollView>
            )}
          </View>
          <View style={[styles.bottomNav, { backgroundColor: stylesColor.surface, borderTopColor: stylesColor.border }]}>
            <Pressable onPress={() => setTab("chats")} style={styles.navItem}>
              <Text style={[styles.navGlyph, { color: tab === "chats" ? stylesColor.primary : stylesColor.muted }]}>▤</Text>
              <Text style={[styles.navLabel, { color: tab === "chats" ? stylesColor.primary : stylesColor.muted }]}>المحادثات</Text>
            </Pressable>
            <Pressable onPress={() => setTab("profile")} style={styles.navItem}>
              <Text style={[styles.navGlyph, { color: tab === "profile" ? stylesColor.primary : stylesColor.muted }]}>◉</Text>
              <Text style={[styles.navLabel, { color: tab === "profile" ? stylesColor.primary : stylesColor.muted }]}>حسابي</Text>
            </Pressable>
          </View>
        </>
      )}

      <Modal visible={addOpen} animationType="slide" transparent onRequestClose={() => setAddOpen(false)}>
        <View style={styles.backdrop}>
          <View style={[styles.sheetModal, { backgroundColor: stylesColor.surface }]}>
            <Text style={[styles.modalTitle, { color: stylesColor.text }]}>إضافة صديق</Text>
            <Text style={[styles.modalHint, { color: stylesColor.muted }]}>اختر طريقة الإضافة المتاحة حاليًا. اكتشاف الأجهزة القريبة يعمل تلقائيًا في الخلفية.</Text>
            <View style={styles.methodRow}>
              <Pressable onPress={() => setFriendMethod("id")} style={[styles.methodChip, { backgroundColor: friendMethod === "id" ? stylesColor.primary : stylesColor.subtle }]}>
                <Text style={{ color: friendMethod === "id" ? stylesColor.primaryText : stylesColor.text }}>بالمعرّف</Text>
              </Pressable>
              <Pressable onPress={() => setFriendMethod("nearby")} style={[styles.methodChip, { backgroundColor: friendMethod === "nearby" ? stylesColor.primary : stylesColor.subtle }]}>
                <Text style={{ color: friendMethod === "nearby" ? stylesColor.primaryText : stylesColor.text }}>الأجهزة القريبة</Text>
              </Pressable>
            </View>
            {friendMethod === "id" ? (
              <>
                <TextInput value={friendId} onChangeText={setFriendId} placeholder="JESR-XXXX-XXXX" placeholderTextColor={stylesColor.muted} autoCapitalize="characters" autoCorrect={false} style={[styles.profileInput, { color: stylesColor.text, backgroundColor: stylesColor.input }]} />
                <Pressable onPress={() => void submitFriend()} disabled={!api.ready} style={[styles.primaryWide, { backgroundColor: stylesColor.primary, opacity: api.ready ? 1 : 0.5 }]}>
                  <Text style={{ color: stylesColor.primaryText, fontWeight: "700" }}>إرسال طلب الصداقة</Text>
                </Pressable>
              </>
            ) : (
              <FlatList
                data={nearbyPeers}
                keyExtractor={(item) => item.id}
                style={{ maxHeight: 240 }}
                ListEmptyComponent={<Text style={[styles.modalHint, { color: stylesColor.muted }]}>لا توجد أجهزة مكتشفة حاليًا. يواصل جسر البحث تلقائيًا.</Text>}
                renderItem={({ item }) => (
                  <Pressable onPress={() => void submitFriendById(item.id)} style={[styles.nearbyRow, { borderBottomColor: stylesColor.border }]}>
                    <View style={[styles.avatar, { backgroundColor: stylesColor.primary }]}><Text style={[styles.avatarLetter, { color: stylesColor.primaryText }]}>ج</Text></View>
                    <View style={styles.flex}>
                      <Text style={[styles.contactName, { color: stylesColor.text }]}>{item.id}</Text>
                      <Text style={[styles.preview, { color: stylesColor.muted }]}>{item.connected ? "متصل" : "تم اكتشافه"}</Text>
                    </View>
                    <Text style={[styles.nearbyAction, { color: stylesColor.primary }]}>إضافة</Text>
                  </Pressable>
                )}
              />
            )}
            <Pressable onPress={() => setAddOpen(false)} style={[styles.secondaryWide, { borderColor: stylesColor.border }]}>
              <Text style={{ color: stylesColor.text }}>إغلاق</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={themeOpen} animationType="slide" transparent onRequestClose={() => setThemeOpen(false)}>
        <View style={styles.backdrop}>
          <View style={[styles.themeSheet, { backgroundColor: stylesColor.surface }]}>
            <Text style={[styles.modalTitle, { color: stylesColor.text }]}>المظهر والألوان</Text>
            <Text style={[styles.modalHint, { color: stylesColor.muted }]}>أربعة اختيارات، مع الاحتفاظ بالثيم الأصلي وإتاحة ألوانك الخاصة.</Text>
            <View style={styles.themeModes}>
              {([
                ["auto", "تلقائي"],
                ["light", "أبيض"],
                ["dark", "أسود"],
                ["custom", "لون مخصص"],
              ] as [ThemeMode, string][]).map(([value, label]) => (
                <Pressable key={value} onPress={() => setThemeMode(value)} style={[styles.modeButton, { backgroundColor: themeMode === value ? stylesColor.primary : stylesColor.subtle, borderColor: stylesColor.border }]}>
                  <Text style={{ color: themeMode === value ? stylesColor.primaryText : stylesColor.text, fontWeight: "700", fontSize: 12 }}>{label}</Text>
                </Pressable>
              ))}
            </View>
            {themeMode === "custom" && (
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.colorPickerContent}>
                <Text style={[styles.profileLabel, { color: stylesColor.muted }]}>اختر اللون من العجلة</Text>
                <ColorWheel value={accent} onChange={setAccent} />
                <Text style={[styles.hexValue, { color: stylesColor.text }]}>{accent.toUpperCase()}</Text>
                <View style={styles.savedHeader}>
                  <Text style={[styles.profileLabel, { color: stylesColor.muted }]}>الألوان المحفوظة</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel="حفظ اللون الحالي" onPress={saveCurrentColor} style={[styles.saveColorButton, { backgroundColor: stylesColor.primary }]}>
                    <Text style={[styles.saveColorText, { color: stylesColor.primaryText }]}>+</Text>
                  </Pressable>
                </View>
                <View style={styles.swatchList}>
                  {savedColors.map((item) => (
                    <View key={item.id} style={styles.swatchItem}>
                      <Pressable onPress={() => chooseSavedColor(item)} style={[styles.swatch, { backgroundColor: item.hex, borderColor: accent === item.hex ? stylesColor.text : stylesColor.border, borderWidth: accent === item.hex ? 3 : 1 }]} />
                      <Text style={[styles.swatchLabel, { color: stylesColor.text }]}>{item.name}</Text>
                      {item.id !== "original" && (
                        <Pressable accessibilityRole="button" accessibilityLabel="حذف اللون المحفوظ" onPress={() => setSavedColors((items) => items.filter((color) => color.id !== item.id))} style={styles.removeSwatch}>
                          <Text style={{ color: stylesColor.muted }}>×</Text>
                        </Pressable>
                      )}
                    </View>
                  ))}
                </View>
              </ScrollView>
            )}
            <Pressable onPress={() => setThemeOpen(false)} style={[styles.primaryWide, { backgroundColor: stylesColor.primary }]}>
              <Text style={{ color: stylesColor.primaryText, fontWeight: "700" }}>تم</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  flex: { flex: 1 },
  mainHeader: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 23, borderBottomLeftRadius: 26, borderBottomRightRadius: 26 },
  headerMainRow: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center" },
  brand: { color: "#FFFFFF", fontSize: 27, fontWeight: "800", textAlign: "right" },
  brandSub: { color: "#E5EAE4", fontSize: 11, textAlign: "right", marginTop: 2 },
  statusWrap: { flexDirection: "row-reverse", alignItems: "center", gap: 7, backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 20, paddingHorizontal: 11, paddingVertical: 7 },
  statusDot: { width: 7, height: 7, borderRadius: 5 },
  statusText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  headerTitleRow: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", marginTop: 18 },
  headerTitle: { color: "#FFFFFF", fontSize: 19, fontWeight: "700", textAlign: "right" },
  addButton: { width: 40, height: 40, borderRadius: 22, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.8)", alignItems: "center", justifyContent: "center" },
  addButtonText: { fontSize: 28, lineHeight: 31, fontWeight: "300" },
  sheet: { flex: 1, marginTop: -1, borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 8 },
  filterRow: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  filterChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 22 },
  searchButton: { width: 35, height: 35, alignItems: "center", justifyContent: "center" },
  searchGlyph: { fontSize: 27, lineHeight: 31 },
  searchInput: { marginTop: 12, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11, fontSize: 13 },
  listHeading: { textAlign: "right", fontSize: 17, fontWeight: "700", marginTop: 18, marginBottom: 8 },
  emptyText: { textAlign: "center", paddingTop: 40, fontSize: 13 },
  contactRow: { flexDirection: "row-reverse", alignItems: "center", gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  avatarLetter: { fontSize: 21, fontWeight: "700" },
  contactName: { fontSize: 14, fontWeight: "700", textAlign: "right" },
  preview: { fontSize: 12, textAlign: "right", marginTop: 4 },
  chatMeta: { alignItems: "flex-end", gap: 5 },
  timeText: { fontSize: 10 },
  unread: { minWidth: 19, height: 19, lineHeight: 19, textAlign: "center", borderRadius: 10, fontSize: 10, overflow: "hidden" },
  requestActions: { flexDirection: "row-reverse", gap: 5 },
  miniAction: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 7 },
  methodRow: { flexDirection: "row-reverse", gap: 8 },
  methodChip: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 13 },
  nearbyRow: { flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  nearbyAction: { fontSize: 12, fontWeight: "700" },
  networkError: { fontSize: 11, textAlign: "right", marginTop: 7 },
  bottomNav: { minHeight: 62, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: "row", justifyContent: "space-around", alignItems: "center" },
  navItem: { minWidth: 96, alignItems: "center", gap: 2, paddingVertical: 5 },
  navGlyph: { fontSize: 22 },
  navLabel: { fontSize: 10, fontWeight: "600" },
  profileContent: { gap: 14, paddingBottom: 20 },
  profileCard: { padding: 16, borderRadius: 20, borderWidth: 1, gap: 10 },
  cardTitle: { fontSize: 16, fontWeight: "800", textAlign: "right" },
  profileLabel: { fontSize: 12, textAlign: "right" },
  profileId: { fontSize: 14, textAlign: "center", letterSpacing: 1 },
  profileInput: { borderRadius: 13, paddingHorizontal: 13, paddingVertical: 12, fontSize: 14 },
  primaryWide: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, paddingHorizontal: 14 },
  secondaryWide: { minHeight: 42, alignItems: "center", justifyContent: "center", borderRadius: 14, borderWidth: 1 },
  chatHeader: { flexDirection: "row-reverse", alignItems: "center", gap: 11, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  backButton: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
  backText: { fontSize: 34, lineHeight: 38 },
  contactState: { fontSize: 10, textAlign: "right", marginTop: 3 },
  chatBody: { flex: 1, margin: 7, borderRadius: 27 },
  messageList: { padding: 14, gap: 9, flexGrow: 1, justifyContent: "flex-end" },
  chatEmpty: { textAlign: "center", color: "#FFFFFF", fontSize: 13, marginVertical: 35 },
  bubble: { maxWidth: "82%", borderRadius: 19, paddingHorizontal: 13, paddingVertical: 9 },
  messageText: { fontSize: 14, textAlign: "right", lineHeight: 21 },
  messageMeta: { fontSize: 9, textAlign: "left", marginTop: 4 },
  composer: { flexDirection: "row-reverse", alignItems: "flex-end", gap: 9, padding: 11, borderTopWidth: StyleSheet.hairlineWidth },
  messageInput: { flex: 1, minHeight: 43, maxHeight: 110, borderRadius: 22, paddingHorizontal: 15, paddingVertical: 10, fontSize: 14 },
  sendButton: { width: 43, height: 43, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  sendGlyph: { fontSize: 21 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.52)", justifyContent: "flex-end" },
  sheetModal: { padding: 20, borderTopLeftRadius: 25, borderTopRightRadius: 25, gap: 13 },
  themeSheet: { maxHeight: "88%", padding: 20, borderTopLeftRadius: 25, borderTopRightRadius: 25, gap: 13 },
  modalTitle: { fontSize: 19, fontWeight: "800", textAlign: "right" },
  modalHint: { fontSize: 12, lineHeight: 19, textAlign: "right" },
  themeModes: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 8 },
  modeButton: { minWidth: "47%", alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 13, paddingVertical: 11 },
  colorPickerContent: { alignItems: "center", gap: 9, paddingVertical: 4 },
  wheel: { width: 176, height: 176 },
  hexValue: { fontSize: 13, fontWeight: "700", letterSpacing: 1 },
  savedHeader: { width: "100%", flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", marginTop: 5 },
  saveColorButton: { width: 34, height: 34, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  saveColorText: { fontSize: 27, lineHeight: 30 },
  swatchList: { width: "100%", flexDirection: "row-reverse", flexWrap: "wrap", gap: 10 },
  swatchItem: { alignItems: "center", gap: 4, minWidth: 58 },
  swatch: { width: 33, height: 33, borderRadius: 18 },
  swatchLabel: { fontSize: 9 },
  removeSwatch: { position: "absolute", top: -5, left: -3, width: 17, height: 17, borderRadius: 9, backgroundColor: "#D0D7DC", alignItems: "center", justifyContent: "center" },
});

