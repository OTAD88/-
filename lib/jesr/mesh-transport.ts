import { Transport } from "./engine";
import { Envelope } from "./protocol";

/** Minimal surface of the mesh needed by the engine; implemented by the native module or a test double. */
export interface MeshPort {
  sendData(targetJesrId: string, envelope: string): Promise<boolean>;
  onData(listener: (envelope: string) => void): { remove(): void };
}

/** Never throws; `true` means "accepted by a live link", not delivered (delivery = signed app ACK). */
export function createMeshTransport(port: MeshPort): Transport {
  return {
    async send(env: Envelope) {
      try { return await port.sendData(env.to, JSON.stringify(env)); } catch { return false; }
    },
  };
}

/** Parses frames coming off the mesh and hands them to the engine; malformed frames are dropped. */
export function bindMeshToEngine(port: MeshPort, onEnvelope: (env: Envelope) => Promise<unknown>) {
  return port.onData((raw) => {
    let env: Envelope;
    try { env = JSON.parse(raw); } catch { return; }
    void onEnvelope(env).catch(() => {});
  });
}
