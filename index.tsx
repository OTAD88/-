import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type Permission,
} from "react-native";
import { Image } from "expo-image";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { exportDiagnosticReport, getDiagnosticReport, recordDiagnostic, recordDiagnosticError } from "@/lib/diagnostics";
import { ScreenContainer } from "@/components/screen-container";
import { NetworkTopology, type TopologyNode } from "@/components/mesh/topology";
import {
  addMeshListener,
  connectMeshPeer,
  discoverMeshPeers,
  getMeshSnapshot,
  isJesrNativeAvailable,
  sendMeshPing,
  startMesh,
  stopMesh,
  type JesrLogEvent,
  type JesrMode,
  type JesrPeer,
  type JesrSnapshot,
} from "@/modules/jesr-network/src";

const palette = {
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

const emptySnapshot: JesrSnapshot = {
  available: false,
  active: false,
  localId: "غير متاح",
  transportState: "يتطلب بناء Android أصلي",
  batteryMode: "balanced",
  peers: [],
  routes: [],
  pendingPackets: 0,
  events: [],
};

function shortId(id: string) {
  return id.length > 13 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function formatTime(at: number) {
  if (!at) return "—";
  return new Date(at).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function eventColor(kind: string) {
  if (kind.includes("failed") || kind.includes("error") || kind.includes("lost")) return palette.red;
  if (kind.includes("ack") || kind.includes("delivered")) return palette.teal;
  if (kind.includes("route") || kind.includes("forwarded")) return palette.amber;
  return palette.blue;
}

export default function HomeScreen() {
  const { width: viewportWidth } = useWindowDimensions();
  const [snapshot, setSnapshot] = useState<JesrSnapshot>(emptySnapshot);
  const [mode, setMode] = useState<JesrMode>("balanced");
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<JesrLogEvent[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [displayName, setDisplayName] = useState("مستخدم جسر");
  const [distanceConsent, setDistanceConsent] = useState(false);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [diagnosticReport, setDiagnosticReport] = useState("لا يوجد تقرير تشخيص محفوظ بعد.");

  const refresh = useCallback(async () => {
    try {
      const next = await getMeshSnapshot();
      setSnapshot(next);
      setMode(next.batteryMode);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "تعذر قراءة حالة الشبكة");
    }
  }, []);

  useEffect(() => {
    void AsyncStorage.getItem("jesr_display_name").then((saved) => { if (saved) setDisplayName(saved); });
    void getDiagnosticReport().then((report) => { setDiagnosticReport(report); if (/exception|failed|error/i.test(report)) setDiagnosticOpen(true); });
    const initialRefresh = setTimeout(() => { void refresh(); }, 0);
    const stateSub = addMeshListener("onMeshState", (state) => {
      setSnapshot(state);
      setMode(state.batteryMode);
    });
    const logSub = addMeshListener("onMeshLog", (event) => {
      setLiveEvents((previous) => [event, ...previous].slice(0, 24));
      recordDiagnostic("native_event", event.kind);
    });
    const peerSub = addMeshListener("onPeerDiscovered", (peer) => {
      setSnapshot((current) => ({
        ...current,
        peers: [...current.peers.filter((item) => item.id !== peer.id), peer],
      }));
    });
    const appSub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      clearTimeout(initialRefresh);
      stateSub.remove();
      logSub.remove();
      peerSub.remove();
      appSub.remove();
    };
  }, [refresh]);

  const topologyNodes = useMemo<TopologyNode[]>(() => {
    const byId = new Map<string, TopologyNode>();
    for (const peer of snapshot.peers) {
      if (!peer.connected) continue;
      byId.set(peer.id, {
        id: peer.id,
        direct: peer.connected,
        linkType: peer.transport,
        hops: peer.connected ? 1 : undefined,
      });
    }
    for (const route of snapshot.routes) {
      if (!byId.has(route.destinationId)) {
        byId.set(route.destinationId, { id: route.destinationId, direct: false, hops: route.hops });
      }
    }
    return [...byId.values()];
  }, [snapshot.peers, snapshot.routes]);

  const allEvents = useMemo(() => {
    const merged = [...liveEvents, ...snapshot.events];
    const seen = new Set<string>();
    return merged.filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    }).slice(0, 18);
  }, [liveEvents, snapshot.events]);

  async function requestAndroidPermissions() {
    if (Platform.OS !== "android") return;
    const api = Platform.Version as number;
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
    const notificationPermission = api >= 33 ? PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS : null;
    const result = await PermissionsAndroid.requestMultiple(permissions);
    const denied = permissions.filter((permission) => result[permission] !== PermissionsAndroid.RESULTS.GRANTED);
    if (denied.length) throw new Error("لم تُمنح بعض أذونات الأجهزة القريبة. لا يجمع التطبيق موقعك؛ تستخدم الإصدارات القديمة إذن الموقع لمسح BLE/Wi‑Fi فقط.");
    if (notificationPermission) {
      const notificationResult = await PermissionsAndroid.request(notificationPermission);
      if (notificationResult !== PermissionsAndroid.RESULTS.GRANTED) {
        setNotice("لم تسمح بإشعارات Android؛ قد يعرض النظام نشاط الخدمة في مدير المهام بدل لوحة الإشعارات.");
      }
    }
  }

  async function runAction(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
      await refresh();
    } catch (error) {
      recordDiagnosticError("ui_action_failed", error);
      setNotice(error instanceof Error ? error.message : "تعذر تنفيذ العملية");
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    recordDiagnostic("start_network_pressed", `mode=${mode}`);
    await runAction(async () => {
      recordDiagnostic("start_network_permissions_begin");
      await requestAndroidPermissions();
      recordDiagnostic("start_network_permissions_granted");
      recordDiagnostic("start_network_native_begin");
      await startMesh(mode);
      recordDiagnostic("start_network_native_returned");
    }, "بدأ تشغيل الشبكة المحلية.");
  }

  async function handleDiscover() {
    recordDiagnostic("discover_nearby_pressed");
    await runAction(async () => {
      recordDiagnostic("discover_nearby_native_begin");
      await discoverMeshPeers();
      recordDiagnostic("discover_nearby_native_returned");
    }, "بدأ البحث عن الأجهزة القريبة.");
  }

  async function handlePing() {
    const destination = targetId.trim() || snapshot.peers.find((peer) => peer.connected)?.id;
    if (!destination) {
      setNotice("أدخل معرّف الجهاز الهدف أو اتصل بجار مباشر أولًا.");
      return;
    }
    await runAction(async () => {
      const packetId = await sendMeshPing(destination);
      setNotice(`أُنشئت حزمة التشخيص ${shortId(packetId)}. انتظر تأكيد الوصول في سجل الأحداث.`);
    });
  }

  function connectPeer(peer: JesrPeer) {
    void runAction(() => connectMeshPeer(peer.id), "بدأ طلب الاتصال المحلي.");
  }

  const connectedPeers = snapshot.peers.filter((peer) => peer.connected);
  const knownCount = new Set([
    ...snapshot.peers.map((peer) => peer.id),
    ...snapshot.routes.map((route) => route.destinationId),
  ]).size;
  const directConnectionCount = connectedPeers.length;
  const active = snapshot.active;

  return (
    <ScreenContainer edges={["top", "left", "right"]} safeAreaClassName="bg-[#0D1722]">
      <ScrollView
        style={styles.page}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel="الإعدادات" onPress={() => setSettingsOpen(true)} style={styles.menuButton}>
            <Text style={styles.menuText}>☰</Text>
          </Pressable>
          <View style={styles.brandLine}>
            <View style={styles.markFrame}>
              <Image source={require("@/assets/images/icon.png")} style={styles.logo} contentFit="contain" />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.brandName}>جسر</Text>
              <Text style={styles.brandSub}>شبكة محلية متعددة القفزات</Text>
            </View>
          </View>
          <View style={[styles.statusBadge, { borderColor: active ? "#286A65" : palette.line }]}>
            <View style={[styles.statusDot, { backgroundColor: active ? palette.teal : palette.muted }]} />
            <Text style={[styles.statusText, { color: active ? palette.teal : palette.muted }]}>
              {active ? "الشبكة تعمل" : "الشبكة متوقفة"}
            </Text>
          </View>
        </View>

        {!isJesrNativeAvailable && (
          <View style={styles.warningBox}>
            <Text style={styles.warningTitle}>المعاينة لا تملك وصولًا إلى الراديو</Text>
            <Text style={styles.warningText}>
              يلزم تثبيت بناء Android أصلي مخصص لتشغيل BLE وWi‑Fi Direct. هذه الشاشة ليست محاكاة لاتصال حي.
            </Text>
          </View>
        )}

        {notice && (
          <Pressable style={styles.noticeBox} onPress={() => setNotice(null)}>
            <Text style={styles.noticeText}>{notice}</Text>
            <Text style={styles.dismiss}>إغلاق</Text>
          </Pressable>
        )}

        <View style={styles.identityCard}>
          <View style={styles.identityHead}>
          <View>
              <Text style={styles.eyebrow}>{displayName} · المعرّف الثابت محليًا</Text>
              <Text selectable numberOfLines={2} style={styles.identityValue}>{snapshot.localId === "غير متاح" ? "تظهر في بناء Android" : snapshot.localId}</Text>
            </View>
            <View style={styles.localOnlyPill}><Text style={styles.localOnlyText}>محلي فقط</Text></View>
          </View>
          <View style={styles.metricsRow}>
            <Metric label="جيران مباشرين" value={String(directConnectionCount)} />
            <Metric label="أجهزة معروفة" value={String(knownCount)} />
            <Metric label="طابور مؤقت" value={String(snapshot.pendingPackets)} />
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>خريطة الشبكة</Text>
          <Text style={styles.sectionNote}>مباشر ومتعدد القفزات</Text>
        </View>
        <View style={styles.topologyCard}>
          {snapshot.localId !== "غير متاح" ? (
            <NetworkTopology
              localId={snapshot.localId}
              nodes={topologyNodes}
              routes={snapshot.routes}
              width={Math.max(260, Math.min(400, viewportWidth - 72))}
              selectedId={selectedNodeId}
              onNodePress={(id) => {
                setSelectedNodeId(id);
                setTargetId(id);
                setNotice(`اختير الجهاز ${shortId(id)} كوجهة لاختبار التشخيص.`);
              }}
            />
          ) : (
            <View style={styles.emptyMap}>
              <View style={styles.emptyNodeCenter} />
              <Text style={styles.emptyMapTitle}>بانتظار تشغيل محرك Android</Text>
              <Text style={styles.emptyMapText}>ستظهر الروابط المباشرة متصلة، والمسارات عبر وسيط بخط متقطع.</Text>
            </View>
          )}
          <View style={styles.legendRow}>
            <LegendDot color={palette.teal} label="رابط مباشر" />
            <LegendDot color={palette.amber} label="عبر وسيط" dashed />
          </View>
        </View>

        <View style={styles.metricsGrid}>
          <MetricCard title="مسار مفضّل" value={snapshot.routes[0] ? `${snapshot.routes[0].hops} قفزة` : "لا يوجد"} note={snapshot.routes[0] ? `القفزة التالية ${shortId(snapshot.routes[0].nextHopId)} · حسب المتاح` : "يُكتشف عند اتصال الأجهزة"} color={palette.teal} />
          <MetricCard title="زمن الاستجابة" value={snapshot.events.find((event) => event.kind === "ping_ack" && event.rttMs != null)?.rttMs != null ? `${snapshot.events.find((event) => event.kind === "ping_ack" && event.rttMs != null)?.rttMs} ms` : "غير مقاس"} note="آخر تأكيد Ping" color={palette.blue} />
          <MetricCard title="فقد الحزم" value="غير مقاس" note="تتطلب عينات Ping متكررة" color={palette.amber} />
          <MetricCard title="حالة النقل" value={active ? "نشط" : "متوقف"} note={snapshot.transportState} color={active ? palette.teal : palette.muted} />
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>الأجهزة والمسارات</Text>
          <Text style={styles.sectionNote}>{snapshot.peers.length} ظاهر</Text>
        </View>
        <View style={styles.panel}>
          {snapshot.peers.length === 0 ? (
            <EmptyRow title="لا توجد أجهزة بعد" subtitle="ابدأ الشبكة ثم ابحث عن الجوار المحلي." />
          ) : snapshot.peers.map((peer) => <PeerRow key={peer.id} peer={peer} onConnect={() => connectPeer(peer)} />)}
          {snapshot.routes.filter((route) => !connectedPeers.some((peer) => peer.id === route.destinationId)).map((route) => (
            <View key={`route-${route.destinationId}`} style={styles.routeRow}>
              <View style={styles.relayMark}><Text style={styles.relayMarkText}>{route.hops}</Text></View>
              <View style={styles.flexOne}>
                <Text style={styles.peerId}>{shortId(route.destinationId)}</Text>
                <Text style={styles.mutedText}>عبر {shortId(route.nextHopId)} · {route.hops} قفزات · آخر تحديث {formatTime(route.lastUpdatedAt)}</Text>
              </View>
              <Text style={styles.routeLabel}>مسار معروف</Text>
            </View>
          ))}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>اختبار التشخيص</Text>
          <Text style={styles.sectionNote}>حزم صغيرة فقط</Text>
        </View>
        <View style={styles.panel}>
          <Text style={styles.label}>معرّف الجهاز المستهدف</Text>
          <TextInput
            value={targetId}
            onChangeText={setTargetId}
            placeholder="مثال: معرّف جهاز معروف"
            placeholderTextColor="#71838E"
            autoCapitalize="none"
            autoCorrect={false}
            textAlign="right"
            style={styles.input}
          />
          <View style={styles.buttonRow}>
            <ActionButton title="إرسال Test Ping" onPress={handlePing} primary disabled={busy || !active} />
            {busy && <ActivityIndicator color={palette.teal} />}
          </View>
          <Text style={styles.helperText}>النتيجة والمسار والتأكيد تظهر في سجل الأحداث، لا تُرسل بيانات مستخدم.</Text>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>الأجهزة القريبة</Text>
          <Text style={styles.sectionNote}>Bluetooth · Wi‑Fi Direct</Text>
        </View>
        <View style={styles.panel}>
          {snapshot.peers.length === 0 ? (
            <EmptyRow title="لم يُرصد جار مباشر" subtitle="استخدم زر البحث. لا تظهر مسافة بالمتر أو إشارة غير متاحة." />
          ) : snapshot.peers.map((peer) => <PeerSignal key={`signal-${peer.id}`} peer={peer} />)}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>سجل الأحداث</Text>
          <Text style={styles.sectionNote}>محلي ومحدود</Text>
        </View>
        <View style={styles.panel}>
          {allEvents.length === 0 ? (
            <EmptyRow title="لا توجد أحداث" subtitle="يبدأ التسجيل بعد اكتشاف جهاز أو إرسال اختبار." />
          ) : allEvents.map((event) => <EventRow key={event.id} event={event} />)}
        </View>

        <View style={styles.controlsPanel}>
          <Text style={styles.sectionTitle}>إدارة الشبكة</Text>
          <Text style={styles.label}>وضع تشغيل الراديو</Text>
          <View style={styles.modeRow}>
            <ModeChip title="متوازن" selected={mode === "balanced"} disabled={active || busy} onPress={() => setMode("balanced")} />
            <ModeChip title="توفير البطارية" selected={mode === "battery"} disabled={active || busy} onPress={() => setMode("battery")} />
          </View>
          <Text style={styles.helperText}>{active ? "أوقف الشبكة أولًا لتغيير وضع المسح." : "وضع التوفير يباعد بين نوافذ اكتشاف BLE؛ وقد يؤخر ظهور الجيران."}</Text>
          <View style={styles.buttonRow}>
          <ActionButton title={active ? "إيقاف الشبكة" : "بدء الشبكة"} onPress={() => active ? void runAction(() => stopMesh(), "أُوقفت الشبكة المحلية.") : void handleStart()} primary={!active} disabled={busy || !isJesrNativeAvailable} />
            <ActionButton title="البحث عن أجهزة" onPress={handleDiscover} disabled={busy || !active} />
          </View>
          <Text style={styles.privacyNote}>لا حسابات ولا موقع GPS ولا خادم. يتطلب Wi‑Fi Direct أن تكون Wi‑Fi مفعّلة، وقد يطلب النظام تفعيل إعداد الموقع على إصدارات معينة حتى دون جمعه.</Text>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>شبكة ترحيل تطبيقية للتشخيص · ليست Bluetooth Mesh الرسمية</Text>
        </View>
      </ScrollView>
      <Pressable accessibilityRole="button" accessibilityLabel="إضافة صديق" onPress={() => setAddOpen(true)} style={styles.addFab}>
        <Text style={styles.addFabText}>+</Text>
      </Pressable>
      <Modal visible={settingsOpen} animationType="slide" transparent onRequestClose={() => setSettingsOpen(false)}>
        <View style={styles.modalBackdrop}><View style={styles.modalCard}>
          <Text style={styles.modalTitle}>الإعدادات</Text>
          <Text style={styles.modalLabel}>اسم المستخدم</Text>
          <TextInput value={displayName} onChangeText={(value) => { setDisplayName(value); void AsyncStorage.setItem("jesr_display_name", value); }} style={styles.input} placeholderTextColor="#71838E" />
          <Text style={styles.modalLabel}>قياس المسافة التقريبي</Text>
          <Text style={styles.helperText}>لا تعرض الشبكة أمتارًا دون قياس موثوق. لا يُطلب هذا القياس إلا بموافقة الطرفين.</Text>
          <Pressable onPress={() => setDistanceConsent((value) => !value)} style={styles.consentRow}><Text style={styles.consentBox}>{distanceConsent ? "✓" : ""}</Text><Text style={styles.consentText}>أوافق على طلب قياس المسافة</Text></Pressable>
          <ActionButton title="عرض تقرير التشخيص السابق" onPress={() => { setSettingsOpen(false); void getDiagnosticReport().then((report) => { setDiagnosticReport(report); setDiagnosticOpen(true); }); }} />
          <ActionButton title="إغلاق" onPress={() => setSettingsOpen(false)} primary />
        </View></View>
      </Modal>
      <Modal visible={addOpen} animationType="slide" transparent onRequestClose={() => setAddOpen(false)}>
        <View style={styles.modalBackdrop}><View style={styles.modalCard}>
          <Text style={styles.modalTitle}>إضافة صديق</Text>
          <Text style={styles.helperText}>البحث محلي فقط، ولا يتطلب Google أو رقم هاتف أو حسابًا.</Text>
          <ActionButton title="البحث عن أجهزة قريبة" onPress={() => { setAddOpen(false); void handleDiscover(); }} primary disabled={busy || !active} />
          <TextInput value={targetId} onChangeText={setTargetId} placeholder="اسم المستخدم أو ID" placeholderTextColor="#71838E" autoCapitalize="none" style={styles.input} />
          <ActionButton title="إضافة بالاسم أو ID" onPress={() => { setAddOpen(false); setNotice(targetId.trim() ? `تم تجهيز طلب إضافة إلى ${shortId(targetId.trim())}.` : "أدخل اسم المستخدم أو ID أولًا."); }} />
          <ActionButton title="إغلاق" onPress={() => setAddOpen(false)} />
        </View></View>
      </Modal>
      <Modal visible={diagnosticOpen} animationType="slide" onRequestClose={() => setDiagnosticOpen(false)}>
        <View style={styles.diagnosticScreen}>
          <Text style={styles.modalTitle}>تقرير تشخيص Jesr</Text>
          <Text style={styles.helperText}>يحتوي على مراحل التشغيل والأخطاء التقنية فقط. لا يسجل الرسائل أو كلمات المرور أو المفاتيح أو بيانات الأصدقاء.</Text>
          <ScrollView style={styles.diagnosticTextBox}><Text selectable style={styles.diagnosticText}>{diagnosticReport}</Text></ScrollView>
          <View style={styles.buttonRow}>
            <ActionButton title="تصدير TXT" primary onPress={() => void exportDiagnosticReport().catch((error) => setNotice(error instanceof Error ? error.message : "تعذر تصدير التقرير"))} />
            <ActionButton title="إغلاق" onPress={() => setDiagnosticOpen(false)} />
          </View>
        </View>
      </Modal>
    </ScreenContainer>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <View style={styles.metricItem}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>;
}

function MetricCard({ title, value, note, color }: { title: string; value: string; note: string; color: string }) {
  return <View style={styles.metricCard}><View style={[styles.metricAccent, { backgroundColor: color }]} /><Text style={styles.metricCardTitle}>{title}</Text><Text style={styles.metricCardValue}>{value}</Text><Text style={styles.metricCardNote}>{note}</Text></View>;
}

function LegendDot({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: color, opacity: dashed ? 0.65 : 1 }]} /><Text style={styles.legendText}>{label}</Text></View>;
}

function EmptyRow({ title, subtitle }: { title: string; subtitle: string }) {
  return <View style={styles.emptyRow}><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.mutedText}>{subtitle}</Text></View>;
}

function PeerRow({ peer, onConnect }: { peer: JesrPeer; onConnect: () => void }) {
  const color = peer.transport === "ble" ? palette.blue : palette.teal;
  return (
    <View style={styles.peerRow}>
      <View style={[styles.peerGlyph, { borderColor: color }]}><View style={[styles.peerGlyphDot, { backgroundColor: color }]} /></View>
      <View style={styles.flexOne}>
        <Text style={styles.peerId}>{shortId(peer.id)}</Text>
        <Text style={styles.mutedText}>{peer.direct ? "اتصال مباشر" : "جهاز مكتشف"} · {peer.transport === "ble" ? "Bluetooth LE" : "Wi‑Fi Direct"} · آخر مشاهدة {formatTime(peer.lastSeenAt)}</Text>
      </View>
      {peer.connected ? <Text style={styles.connectedLabel}>متصل</Text> : <Pressable onPress={onConnect} style={styles.smallButton}><Text style={styles.smallButtonText}>اتصال</Text></Pressable>}
    </View>
  );
}

function PeerSignal({ peer }: { peer: JesrPeer }) {
  const hasRssi = typeof peer.rssiDbm === "number";
  return (
    <View style={styles.signalRow}>
      <Text style={styles.signalValue}>{hasRssi ? `${peer.rssiDbm} dBm` : "غير متاح"}</Text>
      <View style={styles.flexOne}>
        <Text style={styles.peerId}>{shortId(peer.id)}</Text>
        <Text style={styles.mutedText}>{peer.connected ? "قناة مباشرة" : "قريب، غير متصل"} · جودة {peer.qualityMeasured ? `${peer.quality}%` : "غير مقاسة"} · استقرار {peer.stabilityMeasured ? `${Math.round(peer.stability * 100)}%` : "غير مقاس"}</Text>
      </View>
      <View style={[styles.signalDot, { backgroundColor: peer.connected ? palette.teal : palette.muted }]} />
    </View>
  );
}

function EventRow({ event }: { event: JesrLogEvent }) {
  return (
    <View style={styles.eventRow}>
      <View style={[styles.eventDot, { backgroundColor: eventColor(event.kind) }]} />
      <View style={styles.flexOne}>
        <Text style={styles.eventText}>{event.message}</Text>
        {event.path && event.path.length > 1 && <Text style={styles.eventPath}>{event.path.map(shortId).join(" → ")}</Text>}
      </View>
      <Text style={styles.eventTime}>{formatTime(event.at)}</Text>
    </View>
  );
}

function ActionButton({ title, onPress, primary = false, disabled = false }: { title: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.actionButton, primary && styles.primaryButton, disabled && styles.disabledButton, pressed && !disabled && styles.pressedButton]}
    >
      <Text style={[styles.actionText, primary && styles.primaryText]}>{title}</Text>
    </Pressable>
  );
}

function ModeChip({ title, selected, disabled = false, onPress }: { title: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.modeChip, selected && styles.modeChipSelected, disabled && styles.disabledButton]}><Text style={[styles.modeText, selected && styles.modeTextSelected]}>{title}</Text></Pressable>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 36, gap: 16 },
  header: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 4 },
  menuButton: { width: 38, height: 38, borderRadius: 12, borderWidth: 1, borderColor: palette.line, alignItems: "center", justifyContent: "center", backgroundColor: palette.panel },
  menuText: { color: palette.text, fontSize: 22, lineHeight: 24 },
  brandLine: { flexDirection: "row-reverse", alignItems: "center", gap: 10 },
  markFrame: { width: 46, height: 46, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: palette.line },
  logo: { width: 46, height: 46 },
  headerText: { alignItems: "flex-end" },
  brandName: { color: palette.text, fontSize: 25, fontWeight: "800", writingDirection: "rtl" },
  brandSub: { color: palette.muted, fontSize: 11, writingDirection: "rtl" },
  statusBadge: { flexDirection: "row-reverse", gap: 7, alignItems: "center", borderWidth: 1, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 30 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 11, fontWeight: "700", writingDirection: "rtl" },
  warningBox: { padding: 14, backgroundColor: "#332B20", borderRadius: 15, borderWidth: 1, borderColor: "#604B2B", gap: 4 },
  warningTitle: { color: palette.amber, fontSize: 13, fontWeight: "800", textAlign: "right", writingDirection: "rtl" },
  warningText: { color: "#E5D5B9", fontSize: 12, lineHeight: 19, textAlign: "right", writingDirection: "rtl" },
  noticeBox: { backgroundColor: "#203746", borderColor: "#376077", borderWidth: 1, borderRadius: 14, padding: 12, flexDirection: "row-reverse", gap: 10, alignItems: "center" },
  noticeText: { flex: 1, color: palette.text, fontSize: 12, lineHeight: 18, textAlign: "right", writingDirection: "rtl" },
  dismiss: { color: palette.blue, fontSize: 11, fontWeight: "700" },
  identityCard: { borderRadius: 20, padding: 17, backgroundColor: palette.panel, borderWidth: 1, borderColor: palette.line, gap: 16 },
  identityHead: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center" },
  eyebrow: { color: palette.muted, fontSize: 11, textAlign: "right", writingDirection: "rtl" },
  identityValue: { color: palette.text, fontSize: 13, lineHeight: 17, fontWeight: "700", textAlign: "right", writingDirection: "ltr", marginTop: 4, fontVariant: ["tabular-nums"] },
  localOnlyPill: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#173D3C" },
  localOnlyText: { color: palette.teal, fontSize: 11, fontWeight: "700", writingDirection: "rtl" },
  metricsRow: { flexDirection: "row-reverse", borderTopWidth: 1, borderColor: palette.line, paddingTop: 13 },
  metricItem: { flex: 1, alignItems: "center", gap: 4 },
  metricValue: { color: palette.text, fontWeight: "800", fontSize: 18, fontVariant: ["tabular-nums"] },
  metricLabel: { color: palette.muted, fontSize: 10, textAlign: "center", writingDirection: "rtl" },
  sectionHeader: { flexDirection: "row-reverse", alignItems: "baseline", justifyContent: "space-between", marginTop: 4 },
  sectionTitle: { color: palette.text, fontSize: 16, fontWeight: "800", textAlign: "right", writingDirection: "rtl" },
  sectionNote: { color: palette.muted, fontSize: 10, writingDirection: "rtl" },
  topologyCard: { backgroundColor: palette.panel, borderRadius: 20, borderColor: palette.line, borderWidth: 1, padding: 9, alignItems: "center" },
  emptyMap: { height: 176, width: "100%", justifyContent: "center", alignItems: "center", gap: 8 },
  emptyNodeCenter: { width: 28, height: 28, borderRadius: 14, backgroundColor: palette.teal, borderWidth: 7, borderColor: "#275A5C" },
  emptyMapTitle: { color: palette.text, fontSize: 13, fontWeight: "700", textAlign: "center", writingDirection: "rtl" },
  emptyMapText: { color: palette.muted, fontSize: 11, textAlign: "center", lineHeight: 17, writingDirection: "rtl" },
  legendRow: { flexDirection: "row-reverse", gap: 18, paddingTop: 4, paddingBottom: 3 },
  legendItem: { flexDirection: "row-reverse", alignItems: "center", gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: palette.muted, fontSize: 10, writingDirection: "rtl" },
  metricsGrid: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 10 },
  metricCard: { width: "48%", flexGrow: 1, minHeight: 106, backgroundColor: palette.panel, borderRadius: 16, borderWidth: 1, borderColor: palette.line, padding: 13, gap: 5, overflow: "hidden" },
  metricAccent: { position: "absolute", right: 0, top: 0, bottom: 0, width: 3 },
  metricCardTitle: { color: palette.muted, fontSize: 11, textAlign: "right", writingDirection: "rtl" },
  metricCardValue: { color: palette.text, fontSize: 17, fontWeight: "800", textAlign: "right", marginTop: 3, writingDirection: "rtl" },
  metricCardNote: { color: palette.muted, fontSize: 10, textAlign: "right", writingDirection: "rtl" },
  panel: { backgroundColor: palette.panel, borderRadius: 18, borderWidth: 1, borderColor: palette.line, paddingHorizontal: 14, paddingVertical: 4 },
  emptyRow: { paddingVertical: 16, gap: 5, alignItems: "flex-end" },
  emptyTitle: { color: palette.text, fontSize: 12, fontWeight: "700", textAlign: "right", writingDirection: "rtl" },
  mutedText: { color: palette.muted, fontSize: 10, lineHeight: 15, textAlign: "right", writingDirection: "rtl" },
  peerRow: { flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  peerGlyph: { width: 31, height: 31, borderRadius: 16, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  peerGlyphDot: { width: 8, height: 8, borderRadius: 4 },
  flexOne: { flex: 1 },
  peerId: { color: palette.text, fontSize: 12, fontWeight: "700", textAlign: "right", writingDirection: "ltr", fontVariant: ["tabular-nums"] },
  connectedLabel: { color: palette.teal, fontSize: 10, fontWeight: "700", writingDirection: "rtl" },
  smallButton: { borderWidth: 1, borderColor: palette.line, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 6 },
  smallButtonText: { color: palette.text, fontSize: 10, fontWeight: "700", writingDirection: "rtl" },
  routeRow: { flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  relayMark: { width: 29, height: 29, borderRadius: 15, backgroundColor: "#473721", alignItems: "center", justifyContent: "center" },
  relayMarkText: { color: palette.amber, fontSize: 11, fontWeight: "800" },
  routeLabel: { color: palette.amber, fontSize: 9, writingDirection: "rtl" },
  label: { color: palette.muted, fontSize: 11, textAlign: "right", writingDirection: "rtl", marginTop: 12, marginBottom: 7 },
  input: { height: 45, borderRadius: 11, backgroundColor: palette.background, borderWidth: 1, borderColor: palette.line, color: palette.text, paddingHorizontal: 12, fontSize: 12, writingDirection: "ltr" },
  buttonRow: { flexDirection: "row-reverse", alignItems: "center", gap: 9, marginTop: 12 },
  actionButton: { minHeight: 42, paddingHorizontal: 14, borderRadius: 11, borderWidth: 1, borderColor: palette.line, justifyContent: "center", alignItems: "center", backgroundColor: palette.panelRaised },
  primaryButton: { backgroundColor: palette.teal, borderColor: palette.teal },
  disabledButton: { opacity: 0.42 },
  pressedButton: { opacity: 0.78 },
  actionText: { color: palette.text, fontSize: 11, fontWeight: "700", writingDirection: "rtl" },
  primaryText: { color: "#071C20" },
  helperText: { color: palette.muted, fontSize: 10, lineHeight: 16, textAlign: "right", writingDirection: "rtl", marginTop: 8 },
  signalRow: { flexDirection: "row-reverse", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  signalValue: { color: palette.blue, fontSize: 11, minWidth: 68, textAlign: "left", fontVariant: ["tabular-nums"] },
  signalDot: { width: 7, height: 7, borderRadius: 4 },
  eventRow: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 9, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  eventDot: { width: 7, height: 7, borderRadius: 4, marginTop: 5 },
  eventText: { color: palette.text, fontSize: 11, lineHeight: 17, textAlign: "right", writingDirection: "rtl" },
  eventPath: { color: palette.amber, fontSize: 9, textAlign: "right", writingDirection: "ltr", marginTop: 3 },
  eventTime: { color: palette.muted, fontSize: 9, minWidth: 44, textAlign: "left", fontVariant: ["tabular-nums"] },
  controlsPanel: { backgroundColor: palette.panel, borderRadius: 18, padding: 15, borderWidth: 1, borderColor: palette.line },
  modeRow: { flexDirection: "row-reverse", gap: 9 },
  modeChip: { borderWidth: 1, borderColor: palette.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  modeChipSelected: { borderColor: palette.teal, backgroundColor: "#173D3C" },
  modeText: { color: palette.muted, fontSize: 10, fontWeight: "700", writingDirection: "rtl" },
  modeTextSelected: { color: palette.teal },
  privacyNote: { color: palette.muted, fontSize: 10, lineHeight: 16, textAlign: "right", writingDirection: "rtl", marginTop: 12 },
  footer: { paddingTop: 1, alignItems: "center" },
  footerText: { color: "#72838D", fontSize: 9, textAlign: "center", writingDirection: "rtl" },
  addFab: { position: "absolute", left: 18, bottom: 22, width: 58, height: 58, borderRadius: 29, backgroundColor: palette.teal, alignItems: "center", justifyContent: "center", elevation: 5 },
  addFabText: { color: "#071C20", fontSize: 34, lineHeight: 38, fontWeight: "300" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.58)" },
  modalCard: { backgroundColor: palette.panel, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderColor: palette.line, borderWidth: 1, padding: 18, gap: 10 },
  modalTitle: { color: palette.text, fontSize: 19, fontWeight: "800", textAlign: "right", writingDirection: "rtl" },
  modalLabel: { color: palette.muted, fontSize: 11, textAlign: "right", writingDirection: "rtl", marginTop: 5 },
  consentRow: { flexDirection: "row-reverse", alignItems: "center", gap: 9, paddingVertical: 8 },
  consentBox: { width: 23, height: 23, borderRadius: 6, borderWidth: 1, borderColor: palette.teal, color: palette.teal, textAlign: "center", lineHeight: 21 },
  consentText: { color: palette.text, fontSize: 11, writingDirection: "rtl" },
  diagnosticScreen: { flex: 1, backgroundColor: palette.background, padding: 18, paddingTop: 56, gap: 12 },
  diagnosticTextBox: { flex: 1, backgroundColor: palette.panel, borderColor: palette.line, borderWidth: 1, borderRadius: 12, padding: 12 },
  diagnosticText: { color: palette.text, fontSize: 11, lineHeight: 17, writingDirection: "ltr" },
});
