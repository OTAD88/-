import { useEffect, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useJesr } from "@/lib/jesr/runtime";
import { MAX_TEXT_CHARS } from "@/lib/jesr/engine";
import { sage } from "@/lib/jesr/palette";

const ticks = (s: string) => (s === "delivered" ? "✓✓" : s === "sent" ? "✓" : s === "failed" ? "!" : "…");

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>(); const peer = String(id);
  const api = useJesr(); const router = useRouter(); const [text, setText] = useState(""); const list = useRef<FlatList>(null);
  const msgs = api.history(peer);
  useEffect(() => { void api.markRead(peer); }, [peer, msgs.length]);
  async function send() {
    const t = text.trim(); if (!t) return; setText("");
    try { await api.sendText(peer, t); } catch (e: any) { Alert.alert("تعذر الإرسال", e?.message === "message-too-long" ? `الحد الأقصى ${MAX_TEXT_CHARS} حرف` : "تعذر إرسال الرسالة"); setText(t); }
  }
  return (
    <SafeAreaView style={s.page} edges={["top", "bottom"]}>
      <View style={s.head}>
        <Pressable onPress={() => router.back()}><Text style={s.icon}>›</Text></Pressable>
        <View style={s.avatar} />
        <View style={{ flex: 1 }}><Text style={s.name}>{api.nameOf(peer)}</Text>
          <Text style={s.sub}>{api.meshActive && api.peers > 0 ? "الشبكة متصلة" : "خارج النطاق — تُحفظ الرسائل وتُرسل لاحقًا"}</Text></View>
      </View>
      <KeyboardAvoidingView style={s.body} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <FlatList ref={list} data={msgs} keyExtractor={(m) => m.id} contentContainerStyle={{ padding: 14, gap: 8 }}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
          ListHeaderComponent={<Text style={s.day}>اليوم</Text>}
          renderItem={({ item: m }) => (
            <View style={[s.bubble, m.dir === "out" ? s.out : s.in]}>
              <Text style={s.msg}>{m.text}</Text>
              <Text style={s.meta}>{new Date(m.ts).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })} {m.dir === "out" ? ticks(m.status) : ""}</Text>
            </View>)} />
        <View style={s.bar}>
          <TextInput value={text} onChangeText={setText} placeholder="اكتب رسالة…" placeholderTextColor="#E6EEE7" style={s.input} maxLength={MAX_TEXT_CHARS} multiline />
          <Pressable onPress={send} accessibilityLabel="إرسال"><Text style={s.send}>➤</Text></Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" }, head: { flexDirection: "row-reverse", alignItems: "center", gap: 10, padding: 12 },
  icon: { fontSize: 34, color: sage.textSoft }, avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: sage.chip },
  name: { color: sage.text, fontWeight: "600", textAlign: "right" }, sub: { color: sage.textSoft, fontSize: 12, textAlign: "right" },
  body: { flex: 1, backgroundColor: sage.bg, borderRadius: 32, margin: 6, overflow: "hidden" }, day: { color: "#fff", textAlign: "center", fontSize: 12, marginBottom: 6 },
  bubble: { maxWidth: "80%", padding: 10, borderRadius: 20 }, in: { alignSelf: "flex-start", backgroundColor: sage.bubbleIn }, out: { alignSelf: "flex-end", backgroundColor: sage.bubbleOut },
  msg: { color: sage.bubbleText, fontSize: 15, textAlign: "right" }, meta: { color: sage.textSoft, fontSize: 10, marginTop: 2, textAlign: "left" },
  bar: { flexDirection: "row-reverse", alignItems: "center", margin: 12, backgroundColor: "rgba(255,255,255,0.35)", borderRadius: 24, paddingHorizontal: 14 },
  input: { flex: 1, color: "#fff", paddingVertical: 10, textAlign: "right", maxHeight: 100 }, send: { color: "#fff", fontSize: 22, padding: 6 },
});
