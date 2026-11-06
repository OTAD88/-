import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { MeshSimulation, type SimulationSnapshot, type SimulationTopology } from "@/lib/mesh/simulation";

const colors = {
  background: "#0D1722",
  panel: "#142330",
  panelRaised: "#192B38",
  line: "#2A3D49",
  text: "#EAF1F4",
  muted: "#9AAAB3",
  teal: "#20C7B4",
  amber: "#E6AA5A",
  red: "#E57676",
  blue: "#76B7D8",
};

const sizes = [2, 3, 10, 25, 50, 100];
const initialSimulation = new MeshSimulation(3, "chain");

function Stat({ label, value, color = colors.text }: { label: string; value: string | number; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function ActionButton({ label, onPress, tone = "normal", disabled = false }: { label: string; onPress: () => void; tone?: "normal" | "primary" | "danger"; disabled?: boolean }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, tone === "primary" && styles.primaryAction, tone === "danger" && styles.dangerAction, pressed && styles.pressed, disabled && styles.disabled]}>
      <Text style={[styles.actionText, tone === "primary" && styles.primaryText]}>{label}</Text>
    </Pressable>
  );
}

export default function SimulationLabScreen() {
  const simulator = useRef(initialSimulation);
  const [snapshot, setSnapshot] = useState<SimulationSnapshot>(() => initialSimulation.snapshot());
  const [count, setCount] = useState(3);
  const [topology, setTopology] = useState<SimulationTopology>("chain");
  const [sourceId, setSourceId] = useState(snapshot.sourceId);
  const [targetId, setTargetId] = useState(snapshot.targetId);
  const [faultNode, setFaultNode] = useState("SIM-002");
  const [notice, setNotice] = useState("المختبر يستخدم MeshRouter نفسه المستخدم في منطق الشبكة.");

  function refresh(message?: string) {
    const next = simulator.current.snapshot();
    setSnapshot(next);
    if (message) setNotice(message);
  }

  function createNetwork(nextCount = count, nextTopology = topology) {
    simulator.current = new MeshSimulation(nextCount, nextTopology);
    const next = simulator.current.snapshot();
    setSnapshot(next);
    setSourceId(next.sourceId);
    setTargetId(next.targetId);
    setFaultNode(next.nodes[Math.min(1, next.nodes.length - 1)]?.id ?? next.sourceId);
    setNotice(`أُنشئت شبكة محاكاة من ${nextCount} أجهزة بنمط ${nextTopology === "chain" ? "سلسلة متعددة القفزات" : "عشوائي"}.`);
  }

  function sendPacket() {
    simulator.current.send(sourceId.trim(), targetId.trim());
    refresh(`تم تشغيل حزمة اختبار من ${sourceId} إلى ${targetId}. راقب سجل القفزات أدناه.`);
  }

  function toggleFault(online: boolean) {
    simulator.current.setNodeOnline(faultNode.trim(), online);
    refresh(`${online ? "أُعيد توصيل" : "قُطع"} الجهاز ${faultNode}.`);
  }

  const onlineCount = snapshot.nodes.filter((node) => node.online).length;
  const activeLinks = snapshot.links.filter((link) => link.enabled && snapshot.nodes.find((node) => node.id === link.a)?.online && snapshot.nodes.find((node) => node.id === link.b)?.online);

  return (
    <ScreenContainer edges={["top", "left", "right"]} safeAreaClassName="bg-[#0D1722]">
      <ScrollView style={styles.page} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>JESR NETWORK</Text>
            <Text style={styles.title}>Network Simulation Lab</Text>
            <Text style={styles.subtitle}>مختبر محاكاة الشبكة</Text>
          </View>
          <View style={styles.labBadge}><Text style={styles.labBadgeText}>SIMULATION</Text></View>
        </View>

        <View style={styles.notice}><Text style={styles.noticeText}>{notice}</Text></View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>إنشاء شبكة افتراضية</Text>
          <Text style={styles.sectionNote}>{onlineCount}/{snapshot.nodes.length} متصل</Text>
        </View>
        <View style={styles.panel}>
          <Text style={styles.label}>عدد الأجهزة</Text>
          <View style={styles.wrapRow}>
            {sizes.map((size) => <Pressable key={size} onPress={() => { setCount(size); createNetwork(size, topology); }} style={[styles.choice, count === size && styles.choiceSelected]}><Text style={[styles.choiceText, count === size && styles.choiceTextSelected]}>{size}</Text></Pressable>)}
          </View>
          <Text style={styles.label}>شكل الشبكة</Text>
          <View style={styles.row}>
            <Pressable onPress={() => { setTopology("chain"); createNetwork(count, "chain"); }} style={[styles.topologyChoice, topology === "chain" && styles.choiceSelected]}><Text style={styles.choiceText}>سلسلة متعددة القفزات</Text></Pressable>
            <Pressable onPress={() => { setTopology("random"); createNetwork(count, "random"); }} style={[styles.topologyChoice, topology === "random" && styles.choiceSelected]}><Text style={styles.choiceText}>عشوائية مترابطة</Text></Pressable>
          </View>
          <View style={styles.row}><ActionButton label="إعادة ضبط المختبر" onPress={() => createNetwork(count, topology)} /><ActionButton label="إنشاء الشبكة" tone="primary" onPress={() => createNetwork(count, topology)} /></View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>إرسال حزمة متعددة القفزات</Text>
          <Text style={styles.sectionNote}>يستخدم MeshRouter الحقيقي</Text>
        </View>
        <View style={styles.panel}>
          <Text style={styles.label}>المرسل</Text>
          <TextInput value={sourceId} onChangeText={setSourceId} autoCapitalize="characters" style={styles.input} placeholder="SIM-001" placeholderTextColor={colors.muted} />
          <Text style={styles.label}>المستقبل</Text>
          <TextInput value={targetId} onChangeText={setTargetId} autoCapitalize="characters" style={styles.input} placeholder="SIM-003" placeholderTextColor={colors.muted} />
          <ActionButton label="إرسال حزمة Ping عبر الشبكة" tone="primary" onPress={sendPacket} />
          {snapshot.lastPath.length > 0 && <Text style={styles.pathText}>آخر مسار: {snapshot.lastPath.join("  →  ")}</Text>}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>اختبار الأعطال</Text>
          <Text style={styles.sectionNote}>انقطاع وعودة الأجهزة</Text>
        </View>
        <View style={styles.panel}>
          <Text style={styles.label}>الجهاز الوسيط</Text>
          <TextInput value={faultNode} onChangeText={setFaultNode} autoCapitalize="characters" style={styles.input} placeholder="SIM-002" placeholderTextColor={colors.muted} />
          <View style={styles.row}><ActionButton label="قطع الجهاز" tone="danger" onPress={() => toggleFault(false)} /><ActionButton label="إعادة التوصيل" onPress={() => toggleFault(true)} /></View>
          <Text style={styles.helper}>بعد القطع، أرسل حزمة جديدة لمراقبة الفشل أو استخدام مسار بديل.</Text>
        </View>

        <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>الإحصاءات الفعلية</Text><Text style={styles.sectionNote}>نتائج المحاكاة الحالية</Text></View>
        <View style={styles.statsGrid}>
          <Stat label="الأجهزة" value={snapshot.stats.devices} />
          <Stat label="الاتصالات" value={snapshot.stats.connections} color={colors.blue} />
          <Stat label="مرسلة" value={snapshot.stats.packetsSent} />
          <Stat label="مستلمة" value={snapshot.stats.packetsDelivered} color={colors.teal} />
          <Stat label="مفقودة" value={snapshot.stats.packetsLost} color={colors.red} />
          <Stat label="مكررة مسقطة" value={snapshot.stats.duplicatesDropped} color={colors.amber} />
          <Stat label="متوسط القفزات" value={snapshot.stats.averageHops} color={colors.amber} />
          <Stat label="نسبة النجاح" value={`${snapshot.stats.deliveryRate}%`} color={colors.teal} />
          <Stat label="تغيير المسار" value={snapshot.stats.routeChanges} color={colors.blue} />
          <Stat label="أطول مسار" value={`${snapshot.stats.longestPath} قفزة`} color={colors.amber} />
        </View>

        <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>الأجهزة الافتراضية</Text><Text style={styles.sectionNote}>لا تختلط بالشبكة الحقيقية</Text></View>
        <View style={styles.panel}>
          <View style={styles.nodeWrap}>{snapshot.nodes.map((node) => <Pressable key={node.id} onPress={() => { setSourceId(node.id); setNotice(`اختير ${node.id} كمرسل.`); }} style={[styles.nodeChip, !node.online && styles.nodeOffline]}><View style={[styles.dot, { backgroundColor: node.online ? colors.teal : colors.red }]} /><Text style={styles.nodeText}>{node.id}</Text></Pressable>)}</View>
        </View>

        <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>الاتصالات</Text><Text style={styles.sectionNote}>{activeLinks.length} فعالة</Text></View>
        <View style={styles.panel}>
          {snapshot.links.map((link) => <Pressable key={link.id} onPress={() => { simulator.current.toggleLink(link.id, !link.enabled); refresh(`${link.enabled ? "قُطع" : "أُعيد"} الاتصال ${link.a} ↔ ${link.b}.`); }} style={styles.linkRow}><View style={[styles.dot, { backgroundColor: link.enabled ? colors.teal : colors.red }]} /><Text style={styles.linkText}>{link.a} ↔ {link.b}</Text><Text style={styles.linkType}>{link.type === "ble" ? "Bluetooth" : "Wi-Fi Direct"}</Text><Text style={styles.linkState}>{link.enabled ? "فعال" : "مقطوع"}</Text></Pressable>)}
        </View>

        <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>سجل حركة الحزم</Text><Text style={styles.sectionNote}>{snapshot.events.length} حدث</Text></View>
        <View style={styles.panel}>
          {snapshot.events.length === 0 ? <Text style={styles.helper}>لم تبدأ المحاكاة بعد.</Text> : snapshot.events.slice(0, 30).map((event) => <View key={event.id} style={styles.eventRow}><View style={[styles.eventDot, { backgroundColor: event.kind === "delivered" ? colors.teal : event.kind === "dropped" ? colors.red : event.kind === "duplicate" ? colors.amber : colors.blue }]} /><View style={styles.flex}><Text style={styles.eventText}>{event.message}</Text>{event.path && <Text style={styles.eventPath}>{event.path.join(" → ")}</Text>}</View></View>)}
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 18, paddingBottom: 40, gap: 12 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingTop: 8, paddingBottom: 8 },
  eyebrow: { color: colors.teal, fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: colors.text, fontSize: 24, fontWeight: "800", marginTop: 5 },
  subtitle: { color: colors.muted, fontSize: 14, marginTop: 3 },
  labBadge: { borderColor: colors.teal, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6 },
  labBadgeText: { color: colors.teal, fontSize: 10, fontWeight: "800" },
  notice: { backgroundColor: "#12363A", borderColor: "#1E6865", borderWidth: 1, borderRadius: 12, padding: 12 },
  noticeText: { color: "#B7E9E2", lineHeight: 20, fontSize: 13 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: 8 },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: "800" },
  sectionNote: { color: colors.muted, fontSize: 11 },
  panel: { backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 13, gap: 10 },
  label: { color: colors.muted, fontSize: 12, fontWeight: "700", marginTop: 2 },
  wrapRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  choice: { minWidth: 42, alignItems: "center", borderColor: colors.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 9 },
  topologyChoice: { flex: 1, alignItems: "center", borderColor: colors.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 9 },
  choiceSelected: { borderColor: colors.teal, backgroundColor: "#16454A" },
  choiceText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  choiceTextSelected: { color: colors.teal },
  action: { flex: 1, borderColor: colors.line, borderWidth: 1, borderRadius: 9, paddingVertical: 11, alignItems: "center", backgroundColor: colors.panelRaised },
  primaryAction: { backgroundColor: colors.teal, borderColor: colors.teal },
  dangerAction: { borderColor: "#8C454B", backgroundColor: "#42272F" },
  actionText: { color: colors.text, fontSize: 12, fontWeight: "800" },
  primaryText: { color: "#06221F" },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
  input: { color: colors.text, backgroundColor: "#0E1B26", borderColor: colors.line, borderWidth: 1, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 10, fontSize: 13 },
  pathText: { color: colors.teal, fontSize: 12, lineHeight: 19 },
  helper: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  stat: { width: "31.8%", minHeight: 68, backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1, borderRadius: 12, padding: 9, justifyContent: "center" },
  statValue: { fontSize: 19, fontWeight: "800" },
  statLabel: { color: colors.muted, fontSize: 10, marginTop: 3 },
  nodeWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  nodeChip: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#193540", borderRadius: 7, paddingHorizontal: 8, paddingVertical: 7 },
  nodeOffline: { backgroundColor: "#3B2932" },
  dot: { width: 7, height: 7, borderRadius: 4 },
  nodeText: { color: colors.text, fontSize: 10, fontWeight: "700" },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, borderBottomColor: colors.line, borderBottomWidth: 1 },
  linkText: { color: colors.text, fontSize: 12, fontWeight: "700", flex: 1 },
  linkType: { color: colors.muted, fontSize: 10 },
  linkState: { color: colors.teal, fontSize: 10, width: 34, textAlign: "right" },
  eventRow: { flexDirection: "row", gap: 9, paddingVertical: 7, borderBottomColor: colors.line, borderBottomWidth: 1 },
  eventDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  flex: { flex: 1 },
  eventText: { color: colors.text, fontSize: 12, lineHeight: 18 },
  eventPath: { color: colors.muted, fontSize: 10, marginTop: 2 },
});
