/** Minimal persistent key/value boundary for the Jesr engine. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
