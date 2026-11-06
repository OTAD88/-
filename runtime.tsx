import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { PermissionsAndroid, Platform, type Permission } from "react-native";
import { JesrEngine, type ChatMessage, type Friend } from "./engine";
import { createMeshTransport, bindMeshToEngine } from "./mesh-transport";
import { createNativeCrypto, createNativeStore } from "./native-crypto";
import { addJesrDataListener, addMeshListener, isJesrNativeAvailable, sendJesrData, setJesrId, startMesh, stopMesh, type JesrSnapshot } from "@/modules/jesr-network";

export interface ConversationRow { peer: string; name: string; last?: ChatMessage; unread: number }
export interface ChatApi {
  mode: "native" | "preview";
  ready: boolean;
  error?: string;
  profile: { jesrId: string; name: string };
  conversations: ConversationRow[];
  requests: Friend[];
  meshActive: boolean;
  peers: number;
  history(peer: string): ChatMessage[];
  nameOf(peer: string): string;
  sendText(peer: string, text: string): Promise<void>;
  addFriend(id: string): Promise<string | null>;   // returns Arabic error or null
  accept(id: string): Promise<void>;
  reject(id: string): Promise<void>;
  markRead(peer: string): Promise<void>;
  setName(name: string): Promise<void>;
  toggleMesh(): Promise<string | null>;
}

const REASONS: Record<string, string> = {
  "invalid-id": "المعرّف غير صالح", self: "لا يمكنك إضافة نفسك", duplicate: "الطلب أو الصداقة موجودة مسبقًا",
};

async function askPermissions() {
  if (Platform.OS !== "android") return;
  const api = Number(Platform.Version);
  const p: Permission[] = api >= 31
    ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  p.push(api >= 33 ? PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES : PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  const r = await PermissionsAndroid.requestMultiple([...new Set(p)]);
  if ([...new Set(p)].some((x) => r[x] !== PermissionsAndroid.RESULTS.GRANTED)) throw new Error("لم تُمنح صلاحيات الأجهزة القريبة المطلوبة لتشغيل الشبكة");
  if (api >= 33) await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}

function useNativeApi(): ChatApi {
  const [engine, setEngine] = useState<JesrEngine | null>(null);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const [snap, setSnap] = useState<Pick<JesrSnapshot, "active" | "peers">>({ active: false, peers: [] });

  useEffect(() => {
    let off: Array<{ remove(): void }> = []; let timer: ReturnType<typeof setInterval> | undefined; let unsub = () => {};
    (async () => {
      try {
        const e = new JesrEngine(await createNativeCrypto(), createNativeStore(), createMeshTransport({
          sendData: sendJesrData, onData: addJesrDataListener,
        }));
        const profile = await e.init("مستخدم جسر");
        await setJesrId(profile.jesrId).catch(() => {});
        unsub = e.subscribe(() => setTick((t) => t + 1));
        off.push(bindMeshToEngine({ sendData: sendJesrData, onData: addJesrDataListener }, (env) => e.onEnvelope(env)));
        off.push(addMeshListener("onMeshState", (s) => { setSnap({ active: s.active, peers: s.peers }); if (s.peers.some((p) => p.connected)) void e.flush(); }));
        timer = setInterval(() => void e.flush(), 5000);   // backoff is enforced inside the engine
        setEngine(e);
      } catch (err: any) { setError(String(err?.message ?? err)); }
    })();
    return () => { off.forEach((o) => o.remove()); unsub(); if (timer) clearInterval(timer); };
  }, []);

  return useMemo<ChatApi>(() => {
    const e = engine;
    const nameOf = (p: string) => e?.friendOf(p)?.name ?? p;
    return {
      mode: "native", ready: !!e, error,
      profile: e ? { jesrId: e.profile.jesrId, name: e.profile.name } : { jesrId: "…", name: "…" },
      conversations: e ? e.friends().map((f) => ({ peer: f.jesrId, name: f.name, last: e.lastMessage(f.jesrId), unread: e.unread(f.jesrId) }))
        .sort((a, b) => (b.last?.ts ?? 0) - (a.last?.ts ?? 0)) : [],
      requests: e ? e.requests() : [],
      meshActive: snap.active, peers: snap.peers.filter((p) => p.connected).length,
      history: (p) => e?.history(p) ?? [], nameOf,
      sendText: async (p, t) => { await e!.sendText(p, t); },
      addFriend: async (id) => { const r = await e!.sendFriendRequest(id); return r.ok ? null : REASONS[r.reason] ?? r.reason; },
      accept: async (id) => { await e!.accept(id); }, reject: async (id) => { await e!.reject(id); },
      markRead: async (p) => { await e?.markRead(p); }, setName: async (n) => { await e!.setName(n.trim().slice(0, 30) || e!.profile.name); },
      toggleMesh: async () => {
        try { if (snap.active) await stopMesh(); else { await askPermissions(); await startMesh("balanced"); } return null; }
        catch (err: any) { return String(err?.message ?? err); }
      },
    };
    // tick forces recomputation after engine state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, error, tick, snap]);
}

/** Design preview only (web / Expo Go): fixed sample data, no crypto, no network. Clearly labelled in the UI. */
function usePreviewApi(): ChatApi {
  const [msgs, setMsgs] = useState<ChatMessage[]>([
    { id: "1", peer: "JESR-AAAA", dir: "in", text: "مرحبًا، هل وصلتك الرسالة؟", ts: Date.now() - 600000, status: "delivered" },
    { id: "2", peer: "JESR-AAAA", dir: "out", text: "نعم وصلت", ts: Date.now() - 500000, status: "delivered" },
  ]);
  return useMemo<ChatApi>(() => ({
    mode: "preview", ready: true, profile: { jesrId: "JESR-PREVIEW", name: "معاينة" },
    conversations: [{ peer: "JESR-AAAA", name: "اسم جهة الاتصال", last: msgs[msgs.length - 1], unread: 0 }],
    requests: [], meshActive: false, peers: 0,
    history: (p) => msgs.filter((m) => m.peer === p), nameOf: () => "اسم جهة الاتصال",
    sendText: async (p, t) => { setMsgs((m) => [...m, { id: String(Date.now()), peer: p, dir: "out", text: t, ts: Date.now(), status: "sent" }]); },
    addFriend: async () => "غير متاح في المعاينة", accept: async () => {}, reject: async () => {}, markRead: async () => {},
    setName: async () => {}, toggleMesh: async () => "التشغيل الحقيقي يتطلب بناء Android أصليًا",
  }), [msgs]);
}

const Ctx = createContext<ChatApi | null>(null);
function Native({ children }: { children: ReactNode }) { return <Ctx.Provider value={useNativeApi()}>{children}</Ctx.Provider>; }
function Preview({ children }: { children: ReactNode }) { return <Ctx.Provider value={usePreviewApi()}>{children}</Ctx.Provider>; }
export function JesrProvider({ children }: { children: ReactNode }) {
  return isJesrNativeAvailable ? <Native>{children}</Native> : <Preview>{children}</Preview>;
}
export function useJesr(): ChatApi { const c = useContext(Ctx); if (!c) throw new Error("JesrProvider missing"); return c; }
