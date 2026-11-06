import AsyncStorage from "@react-native-async-storage/async-storage";
import { Share } from "react-native";
import { getNativeDiagnosticReport } from "@/modules/jesr-network/src";

type DiagnosticEntry = { at: string; stage: string; detail?: string; stack?: string };
const KEY = "jesr_diagnostics_v1";
const MAX_ENTRIES = 160;
let entries: DiagnosticEntry[] = [];
let writeChain: Promise<void> = Promise.resolve();
let previousHandler: ((error: unknown, isFatal?: boolean) => void) | undefined;

function redact(value: unknown): string {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 4_000);
}
function queueWrite() {
  const snapshot = JSON.stringify(entries);
  writeChain = writeChain.then(() => AsyncStorage.setItem(KEY, snapshot)).catch(() => {});
}

export async function initializeDiagnostics() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed.slice(-MAX_ENTRIES);
    }
  } catch { entries = []; }
  try {
    const nativeReport = await getNativeDiagnosticReport();
    if (nativeReport.trim()) recordDiagnostic("native_persisted_log", nativeReport.slice(-5_000));
  } catch { /* Native diagnostics are optional in preview builds. */ }
  installGlobalExceptionHandler();
  recordDiagnostic("app_opened", "diagnostics initialized");
}

export function recordDiagnostic(stage: string, detail?: unknown, error?: unknown) {
  entries = [...entries, {
    at: new Date().toISOString(),
    stage: redact(stage),
    detail: detail === undefined ? undefined : redact(detail),
    stack: error instanceof Error ? redact(error.stack ?? error.message) : undefined,
  }].slice(-MAX_ENTRIES);
  queueWrite();
}
export function recordDiagnosticError(stage: string, error: unknown) {
  recordDiagnostic(stage, error instanceof Error ? error.message : "unknown error", error);
}
function installGlobalExceptionHandler() {
  const runtime = globalThis as typeof globalThis & {
    ErrorUtils?: {
      getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
    };
  };
  const errorUtils = runtime.ErrorUtils;
  if (!errorUtils?.setGlobalHandler || !errorUtils.getGlobalHandler) return;
  previousHandler = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    recordDiagnosticError(isFatal ? "javascript_fatal_exception" : "javascript_uncaught_exception", error);
    try { previousHandler?.(error, isFatal); } catch { /* preserve crash behavior */ }
  });
}
export async function getDiagnosticReport() {
  await writeChain;
  return entries.map((entry) => [
    entry.at,
    entry.stage,
    entry.detail ?? "",
    entry.stack ?? "",
  ].filter(Boolean).join(" | ")).join("\n") || "لا يوجد تقرير تشخيص محفوظ بعد.";
}
export async function exportDiagnosticReport() {
  await writeChain;
  const report = await getDiagnosticReport();
  await Share.share({ title: "تقرير تشخيص جسر", message: report });
}
export function getDiagnosticFileName() { return "jesr-diagnostic.txt"; }
