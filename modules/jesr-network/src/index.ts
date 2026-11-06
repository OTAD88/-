import { NativeModule, requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

export type JesrMode = "balanced" | "battery";
export type JesrPeer = {
  id: string; transport: "ble" | "wifi-direct"; direct: boolean; quality: number;
  qualityMeasured: boolean; lossPercent: number; lossMeasured: boolean;
  latencyMs: number | null; stability: number; stabilityMeasured: boolean;
  rssiDbm?: number | null; lastSeenAt: number; connected: boolean;
};
export type JesrRoute = {
  destinationId: string; nextHopId: string; hops: number; quality: number;
  qualityMeasured: boolean; lossPercent: number; lossMeasured: boolean;
  latencyMs: number | null; stability: number; stabilityMeasured: boolean; lastUpdatedAt: number;
};
export type JesrLogEvent = {
  id: string; at: number; kind: string; message: string; packetId?: string;
  nodeId?: string; path?: string[]; rttMs?: number; success?: boolean;
};
export type JesrSnapshot = {
  available: boolean; active: boolean; localId: string; transportState: string;
  batteryMode: JesrMode; peers: JesrPeer[]; routes: JesrRoute[];
  pendingPackets: number; events: JesrLogEvent[];
};
type JesrEvents = {
  onMeshState: (snapshot: JesrSnapshot) => void;
  onMeshLog: (event: JesrLogEvent) => void;
  onPeerDiscovered: (peer: JesrPeer) => void;
  onPingResult: (event: JesrLogEvent) => void;
  onJesrData: (event: { envelope: string }) => void;
};
type JesrNativeModule = NativeModule<JesrEvents> & {
  getSnapshot(): Promise<JesrSnapshot>;
  getNativeDiagnosticReport(): Promise<string>;
  startNetwork(mode: JesrMode): Promise<JesrSnapshot>;
  stopNetwork(): Promise<JesrSnapshot>;
  discoverPeers(): Promise<unknown>;
  connectPeer(peerId: string): Promise<unknown>;
  setJesrId(jesrId: string): Promise<void>;
  sendData(targetJesrId: string, envelope: string): Promise<boolean>;
  sendPing(peerId: string): Promise<string>;
  cryptoPublicKey(): Promise<string>; cryptoSign(data: string): Promise<string>;
  cryptoVerify(pub: string, data: string, sig: string): Promise<boolean>;
  cryptoSha256(data: string): Promise<string>; cryptoRandom(n: number): Promise<string>;
  cryptoEncrypt(peerPub: string, plain: string, aad: string): Promise<string>;
  cryptoDecrypt(blob: string, aad: string): Promise<string>;
  secureGet(name: string): Promise<string | null>; secureSet(name: string, value: string): Promise<void>;
};

const native = Platform.OS === "android" ? requireOptionalNativeModule<JesrNativeModule>("JesrNetwork") : null;

export const isJesrNativeAvailable = !!native;

function requireNative(): JesrNativeModule {
  if (!native) throw new Error("وحدة Jesr الأصلية غير متاحة؛ يلزم تثبيت APK Android مبني مع الوحدة");
  return native;
}
export function nativeBridge(): JesrNativeModule { return requireNative(); }
export async function getMeshSnapshot(): Promise<JesrSnapshot> {
  if (!native) return { available: false, active: false, localId: "غير متاح", transportState: "native module unavailable", batteryMode: "balanced", peers: [], routes: [], pendingPackets: 0, events: [] };
  return native.getSnapshot();
}
export const startMesh = (mode: JesrMode = "balanced") => requireNative().startNetwork(mode);
export const stopMesh = () => requireNative().stopNetwork();
export const discoverMeshPeers = () => requireNative().discoverPeers();
export const connectMeshPeer = (peerId: string) => requireNative().connectPeer(peerId);
export const sendMeshPing = (peerId: string) => requireNative().sendPing(peerId);
export const setJesrId = (id: string) => requireNative().setJesrId(id);
export const sendJesrData = (target: string, envelope: string) => requireNative().sendData(target, envelope);
export const getNativeDiagnosticReport = () => native ? native.getNativeDiagnosticReport() : Promise.resolve("");
export function addMeshListener<T = any>(event: "onMeshState" | "onMeshLog" | "onPeerDiscovered" | "onPingResult", listener: (value: T) => void) {
  return native?.addListener(event, listener as any) ?? { remove() {} };
}
export function addJesrDataListener(listener: (envelope: string) => void) {
  return native?.addListener("onJesrData", (event) => listener(event.envelope)) ?? { remove() {} };
}
