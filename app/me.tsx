import { useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useJesr } from "@/lib/jesr/runtime";
import { sage } from "@/lib/jesr/palette";

export default function Me() {
  const api = useJesr(); const [id, setId] = useState(""); const [name, setName] = useState(api.profile.name);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: sage.bg }} edges={["top"]}>
      <ScrollView contentContainerStyle={{ padding: 18, gap: 14 }}>
        <View style={s.card}>
          <Text style={s.h}>معرّف Jesr الخاص بك</Text>
          <Text selectable style={s.id}>{api.profile.jesrId}</Text>
          <Pressable style={s.btn} onPress={() => Share.share({ message: api.profile.jesrId })}><Text style={s.bt}>مشاركة المعرّف</Text></Pressable>
          <Text style={s.hint}>المعرّف مشتق من مفتاحك العام؛ لا يمكن انتحاله. تغيير المفتاح يعني هوية جديدة.</Text>
        </View>
        <View style={s.card}>
          <Text style={s.h}>اسمك</Text>
          <TextInput value={name} onChangeText={setName} style={s.input} maxLength={30} />
          <Pressable style={s.btn} onPress={() => api.setName(name)}><Text style={s.bt}>حفظ</Text></Pressable>
        </View>
        <View style={s.card}>
          <Text style={s.h}>إضافة صديق</Text>
          <TextInput value={id} onChangeText={setId} placeholder="JESR-XXXX-XXXX-…" autoCapitalize="characters" style={s.input} />
          <Pressable style={s.btn} onPress={async () => { const e = await api.addFriend(id); if (e) Alert.alert("تعذرت الإضافة", e); else { setId(""); Alert.alert("أُرسل الطلب", "سيصل عند اتصالك بالشبكة بجهازه."); } }}><Text style={s.bt}>إرسال طلب صداقة</Text></Pressable>
        </View>
        <View style={s.card}>
          <Text style={s.h}>الشبكة المحلية</Text>
          <Text style={s.hint}>{api.meshActive ? `تعمل · ${api.peers} جار متصل` : "متوقفة"} — لا تعمل بعد force-stop أو قتل النظام للتطبيق.</Text>
          <Pressable style={s.btn} onPress={async () => { const e = await api.toggleMesh(); if (e) Alert.alert("تعذر التنفيذ", e); }}><Text style={s.bt}>{api.meshActive ? "إيقاف الشبكة" : "تشغيل الشبكة"}</Text></Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  card: { backgroundColor: "#fff", borderRadius: 24, padding: 16, gap: 10 }, h: { color: sage.text, fontWeight: "700", fontSize: 16, textAlign: "right" },
  id: { color: sage.bubbleText, fontSize: 16, textAlign: "center", letterSpacing: 1 }, hint: { color: sage.textSoft, fontSize: 12, textAlign: "right" },
  input: { backgroundColor: "#F3F6F3", borderRadius: 14, padding: 10, color: sage.text, textAlign: "right" },
  btn: { backgroundColor: sage.bgDark, borderRadius: 16, padding: 12, alignItems: "center" }, bt: { color: "#fff", fontWeight: "600" },
});
