import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { getNativeDiagnosticReport } from "@/modules/jesr-network/src";

type DiagnosticEntry = {
  at: string;
  stage: string;
  detail?: string;
  stack?: string;
};

const REPORT_FILE = "jesr-diagnostic-report.txt";
const MAX_ENTRIES = 180;
let entries: DiagnosticEntry[] = [];
let initialized = false;
let writeChain: Promise<void> = Promise.resolve();
let previousHandler: ((error: unknown, isFatal?: boolean) => void) | undefined;

function reportUri() {
  return `${FileSystem.documentDirectory ?? ""}${REPORT_FILE}`;
}

function redact(value: unknown) {
  return String(value ?? "")
    .replace(/[A-Fa-f0-9]{8}-[A-Fa-f0-9-]{27,}/g, "[local-id]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(password|secret|private.?key|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 800);
}

function queueWrite() {
  const text = [
    "Jesr diagnostic report",
    "This report contains execution stages and errors only. Message content, contacts, and private keys are excluded.",
    "Native crashes that kill the process may not produce a final JavaScript stack; the last flushed entries are retained.",
    "",
    ...entries.map((entry) => `${entry.at} | ${entry.stage}${entry.detail ? ` | ${entry.detail}` : ""}${entry.stack ? `\nSTACK: ${entry.stack}` : ""}`),
    "",
  ].join("\n");
  writeChain = writeChain.then(async () => {
    const uri = reportUri();
    if (!uri) return;
    await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 });
  }).catch(() => undefined);
}

export async function initializeDiagnostics() {
  if (initialized) return;
  initialized = true;
  try {
    const uri = reportUri();
    if (uri && await FileSystem.getInfoAsync(uri).then((info) => info.exists)) {
      const text = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
      const lines = text.split("\n").filter((line) => line.includes(" | "));
      entries = lines.slice(-MAX_ENTRIES).map((line) => {
        const [at, stage, ...detail] = line.split(" | ");
        return { at: at ?? "", stage: stage ?? "unknown", detail: detail.join(" | ") };
      });
    }
  } catch {
    entries = [];
  }
  try {
    const nativeReport = await getNativeDiagnosticReport();
    if (nativeReport.trim()) recordDiagnostic("native_persisted_log", nativeReport.slice(-5_000));
  } catch {
    // Native diagnostics are optional in preview builds.
  }
  installGlobalExceptionHandler();
  recordDiagnostic("app_opened", "diagnostics initialized");
}

export function recordDiagnostic(stage: string, detail?: unknown, error?: unknown) {
  const entry: DiagnosticEntry = {
    at: new Date().toISOString(),
    stage: redact(stage),
    detail: detail === undefined ? undefined : redact(detail),
    stack: error instanceof Error ? redact(error.stack ?? error.message) : undefined,
  };
  entries = [...entries, entry].slice(-MAX_ENTRIES);
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
  try {
    const uri = reportUri();
    if (uri && await FileSystem.getInfoAsync(uri).then((info) => info.exists)) return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
  } catch (error) {
    recordDiagnosticError("diagnostic_read_failed", error);
  }
  return "لا يوجد تقرير تشخيص محفوظ بعد.";
}

export async function exportDiagnosticReport() {
  const uri = reportUri();
  if (!uri) throw new Error("مساحة ملفات التطبيق غير متاحة");
  await queueWrite;
  if (!(await FileSystem.getInfoAsync(uri)).exists) await FileSystem.writeAsStringAsync(uri, "لا يوجد تقرير تشخيص محفوظ بعد.\n", { encoding: FileSystem.EncodingType.UTF8 });
  if (!(await Sharing.isAvailableAsync())) throw new Error("المشاركة غير متاحة على هذا الجهاز");
  await Sharing.shareAsync(uri, { mimeType: "text/plain", dialogTitle: "تصدير تقرير تشخيص Jesr" });
}

export function getDiagnosticFileName() {
  return REPORT_FILE;
}
