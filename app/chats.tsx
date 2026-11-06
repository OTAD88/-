import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useJesr } from "@/lib/jesr/runtime";
import { sage } from "@/lib/jesr/palette";

const time = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" }) : "");
const tick = (s?: string) => (s === "delivered" ? "✓✓" : s === "sent" ? "✓" : s === "failed" ? "!" : s === "sending" ? "…" : "");
type Tab = "private" | "requests";

export default function Chats() {
  const api = useJesr(); const router = useRouter();
  const [tab, setTab] = useState<Tab>("private"); const [q, setQ] = useState(""); const [search, setSearch] = useState(false);
  const rows = useMemo(() => api.conversations.filter((c) => c.name.includes(q)), [api.conversations, q]);
  return (
    <View style={s.page}>
      <SafeAreaView edges={["top"]} style={s.top}>
        <View style={s.stories}>
          <View style={s.addStory}><Text style={s.plus}>+</Text></View>
          <Text style={s.storyLabel}>{api.meshActive ? `متصل · ${api.peers} جار` : "الشبكة متوقفة"}</Text>
        </View>
      </SafeAreaView>
      <View style={s.sheet}>
        {api.mode === "preview" && <Text style={s.banner}>وضع معاينة التصميم — لا اتصال حقيقي ولا تشفير</Text>}
        {!!api.error && <Text style={s.banner}>{api.error}</Text>}
        <View style={s.chips}>
          <Pressable onPress={() => setTab("private")} style={[s.chip, tab === "private" && s.chipOn]}><Text style={s.chipT}>رسائل خاصة</Text></Pressable>
          <Pressable onPress={() => setTab("requests")} style={[s.chip, tab === "requests" && s.chipOn]}><Text style={s.chipT}>طلبات {api.requests.length ? `(${api.requests.length})` : ""}</Text></Pressable>
          <Pressable onPress={() => setSearch(!search)} style={{ marginStart: "auto" }}><Text style={s.search}>⌕</Text></Pressable>
        </View>
        {search && <TextInput value={q} onChangeText={setQ} placeholder="بحث بالاسم" placeholderTextColor={sage.textSoft} style={s.input} />}
        <Text style={s.h}>أحدث الرسائل</Text>
        {tab === "private" ? (
          <FlatList data={rows} keyExtractor={(r) => r.peer}
            ListEmptyComponent={<Text style={s.empty}>لا محادثات بعد. أضف صديقًا من «حسابي» بمعرّف Jesr.</Text>}
            renderItem={({ item }) => (
              <Pressable style={s.row} onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.peer } })}>
                <View style={s.avatar}><Text style={s.avatarT}>{item.name.slice(0, 1)}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={s.prev} numberOfLines={1}>{item.last?.text ?? "لا رسائل"}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={s.name}>{time(item.last?.ts)}</Text>
                  {item.unread > 0 ? <Text style={s.badge}>{item.unread}</Text> : <Text style={s.prev}>{item.last?.dir === "out" ? tick(item.last.status) : ""}</Text>}
                </View>
              </Pressable>
            )} />
        ) : (
          <FlatList data={api.requests} keyExtractor={(r) => r.jesrId}
            ListEmptyComponent={<Text style={s.empty}>لا طلبات حاليًا</Text>}
            renderItem={({ item }) => (
              <View style={s.row}>
                <View style={s.avatar}><Text style={s.avatarT}>{item.name.slice(0, 1)}</Text></View>
                <View style={{ flex: 1 }}><Text style={s.name} numberOfLines={1}>{item.name}</Text><Text style={s.prev}>{item.state === "incoming" ? "يريد إضافتك" : "بانتظار موافقته"}</Text></View>
                {item.state === "incoming" && <>
                  <Pressable onPress={() => api.accept(item.jesrId)} style={s.chipOn2}><Text style={s.chipT}>قبول</Text></Pressable>
                  <Pressable onPress={() => api.reject(item.jesrId)} style={s.chip}><Text style={s.chipT}>رفض</Text></Pressable></>}
              </View>
            )} />
        )}
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: sage.bg }, top: { backgroundColor: sage.bg, paddingBottom: 16 },
  stories: { alignItems: "center", paddingTop: 8 }, addStory: { width: 56, height: 56, borderRadius: 28, borderWidth: 2, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  plus: { color: "#fff", fontSize: 28 }, storyLabel: { color: "#fff", fontSize: 12, marginTop: 6 },
  sheet: { flex: 1, backgroundColor: "#fff", borderTopLeftRadius: 36, borderTopRightRadius: 36, padding: 18 },
  banner: { backgroundColor: "#F3E9C8", color: "#6b5a1e", padding: 8, borderRadius: 12, marginBottom: 8, textAlign: "center", fontSize: 12 },
  chips: { flexDirection: "row-reverse", gap: 8, alignItems: "center" }, chip: { backgroundColor: sage.chip, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16 },
  chipOn: { backgroundColor: sage.bgDark }, chipOn2: { backgroundColor: sage.bgDark, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, marginStart: 6 },
  chipT: { color: "#fff", fontSize: 12 }, search: { fontSize: 26, color: sage.text },
  input: { marginTop: 10, borderRadius: 14, backgroundColor: "#F3F6F3", padding: 10, color: sage.text, textAlign: "right" },
  h: { color: sage.text, fontSize: 18, fontWeight: "600", marginVertical: 14, textAlign: "right" }, empty: { color: sage.textSoft, textAlign: "center", marginTop: 40 },
  row: { flexDirection: "row-reverse", alignItems: "center", gap: 12, paddingVertical: 10 },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: sage.chip, alignItems: "center", justifyContent: "center" }, avatarT: { color: "#fff", fontSize: 22 },
  name: { color: sage.text, fontWeight: "600", textAlign: "right" }, prev: { color: sage.textSoft, fontSize: 13, textAlign: "right" },
  badge: { backgroundColor: sage.bgDark, color: "#fff", borderRadius: 10, paddingHorizontal: 7, fontSize: 12, overflow: "hidden" },
});
