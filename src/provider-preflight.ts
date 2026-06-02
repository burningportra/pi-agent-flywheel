/**
 * Pure provider/model preflight classification.
 *
 * Launch orchestration should call this module after a bounded probe and before
 * starting worker panes. It converts provider auth errors, quota failures, and
 * missing local launch tools into stable statuses that downstream code can act on.
 */

export type ProviderPreflightStatus =
  | "available"
  | "unauthorized"
  | "unavailable"
  | "rate_limited"
  | "misconfigured"
  | "unknown_failure"
  | "not_checked";

export type ProviderLaunchSurface =
  | "subagent"
  | "ntm"
  | "claude-code"
  | "cursor-agent"
  | "codex"
  | "unknown";

export interface ProviderPreflightProbe {
  /** Safe, bounded command used only to prove the local launch surface exists. */
  command: string;
  args: string[];
}

export interface ProviderPreflightCheck {
  /** Stable identifier for this check, for example "reviewer:claude". */
  id: string;
  /** Human-readable label for launch and downgrade explanations. */
  label: string;
  provider?: string;
  model?: string;
  surface: ProviderLaunchSurface;
  /** Required checks block or downgrade launch when unavailable. */
  required: boolean;
  /** Optional safe probe. Omit when no non-destructive dry-run/help surface exists. */
  probe?: ProviderPreflightProbe;
}

export interface ProviderPreflightResult {
  status: ProviderPreflightStatus;
  check: ProviderPreflightCheck;
  launchable: boolean;
  evidence: string[];
  repairGuidance: string[];
}

export interface ProviderPreflightSummary {
  status: ProviderPreflightStatus;
  launchableCount: number;
  requiredUnavailable: boolean;
  results: ProviderPreflightResult[];
  selectedCheckIds: string[];
  downgradeReasons: string[];
  repairGuidance: string[];
}

export interface ProviderPreflightExecResult {
  code?: number | null;
  stdout?: string;
  stderr?: string;
}

export interface ProviderPreflightExec {
  (cmd: string, args: string[], opts: { cwd: string; timeout: number }): Promise<ProviderPreflightExecResult>;
}

export interface PreflightWorkerProvidersOptions {
  cwd: string;
  checks: ProviderPreflightCheck[];
  exec: ProviderPreflightExec;
  timeoutMs?: number;
}

export interface ProviderAuthEvidence {
  /** Provider/API HTTP status, when the probe exposes one. */
  statusCode?: number | null;
  /** Local process exit code, when the probe spawned a command. */
  exitCode?: number | null;
  /** Backward-compatible generic numeric code from simple callers. */
  code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: unknown;
}

const UNAUTHORIZED_MARKERS = [
  "unauthorized",
  "permission_error",
  "permission error",
  "oauth authentication is currently not allowed",
  "authentication is currently not allowed",
  "invalid api key",
  "invalid_api_key",
  "forbidden",
  "not allowed for this organization",
] as const;

const RATE_LIMIT_MARKERS = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "too many requests",
  "insufficient credits",
  "quota exceeded",
  "credit balance",
] as const;

const UNAVAILABLE_MARKERS = [
  "enoent",
  "eacces",
  "command not found",
  "unknown command",
  "no such file or directory",
  "executable file not found",
  "tool not found",
] as const;

const MISCONFIGURED_MARKERS = [
  "missing api key",
  "missing_api_key",
  "api key is required",
  "no api key",
  "model not configured",
  "provider not configured",
  "configuration error",
  "misconfigured",
  "invalid model",
  "model not found",
  "unknown model",
] as const;

const ERROR_MARKERS = ["error", "failed", "failure", "exception"] as const;

const REPAIR_GUIDANCE: Record<ProviderPreflightStatus, readonly string[]> = {
  available: [],
  unauthorized: [
    "Provider authentication is blocked or unauthorized. Check OAuth policy, API keys, account, and organization permissions.",
    "Do not retry endlessly on 401/403/Unauthorized evidence; repair auth or switch to a different provider/model surface.",
    "Keep worker count low or route around this provider until the selected launch surface is authorized.",
  ],
  rate_limited: [
    "Provider quota or capacity is exhausted. Wait, add credits, reduce worker count, or switch provider.",
    "Avoid immediate repeated launch retries; quota/rate-limit failures usually need time or configuration changes.",
  ],
  unavailable: [
    "The local launch tool or provider command is unavailable. Verify installation and PATH for the selected surface.",
    "Route to an installed provider/surface or downgrade to sequential work.",
  ],
  misconfigured: [
    "Provider configuration is incomplete or inconsistent. Check environment variables, model ids, and pi model settings.",
    "Retry only after correcting configuration, or choose a configured provider.",
  ],
  unknown_failure: [
    "Provider preflight failed with an unrecognized shape. Inspect captured stdout/stderr before launching workers.",
    "Fail safe by reducing parallelism or choosing a known-good launch surface.",
  ],
  not_checked: [
    "Provider readiness was not checked because no safe bounded probe ran.",
    "Do not assume availability for multi-worker launch; prefer a known-good provider or be ready to downgrade.",
  ],
};

function textFromError(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return `${error.name}\n${error.message}\n${error.stack ?? ""}`;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function lowerEvidence(input: ProviderAuthEvidence): string {
  return [input.stdout ?? "", input.stderr ?? "", textFromError(input.error)].join("\n").toLowerCase();
}

function hasAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function numericSignals(input: ProviderAuthEvidence): number[] {
  return [input.statusCode, input.exitCode, input.code].filter((value): value is number => typeof value === "number");
}

function hasNumericStatus(input: ProviderAuthEvidence, statuses: readonly number[]): boolean {
  const observed = numericSignals(input);
  return statuses.some((status) => observed.includes(status));
}

function hasStatusText(text: string, statuses: readonly number[]): boolean {
  return statuses.some((status) => {
    const statusPattern = new RegExp(
      `(?:\\bhttp\\s+${status}\\b|\\bstatus(?:_code|\\s+code)?\\D{0,8}${status}\\b|\\b${status}\\s+(?:unauthorized|forbidden|too many requests)\\b)`,
    );
    return statusPattern.test(text);
  });
}

function hasSuccessfulExit(input: ProviderAuthEvidence): boolean {
  return input.exitCode === 0 || input.code === 0 || input.statusCode === 200;
}

/**
 * Classify provider/tool launch evidence into a stable preflight status.
 *
 * The classifier is intentionally pure and conservative: empty evidence is
 * `not_checked`, clean success is `available`, and any unrecognized failure is
 * `unknown_failure` rather than a guessed provider state.
 */
export function classifyProviderAuthEvidence(input: ProviderAuthEvidence): ProviderPreflightStatus {
  const text = lowerEvidence(input);
  const hasText = text.trim().length > 0;
  const hasNumber = numericSignals(input).length > 0;

  if (!hasNumber && !hasText) return "not_checked";

  if (hasNumericStatus(input, [401, 403]) || hasStatusText(text, [401, 403]) || hasAny(text, UNAUTHORIZED_MARKERS)) {
    return "unauthorized";
  }

  if (hasNumericStatus(input, [429]) || hasStatusText(text, [429]) || hasAny(text, RATE_LIMIT_MARKERS)) {
    return "rate_limited";
  }

  if (input.exitCode === 126 || input.exitCode === 127 || input.code === 126 || input.code === 127 || hasAny(text, UNAVAILABLE_MARKERS)) {
    return "unavailable";
  }

  if (hasAny(text, MISCONFIGURED_MARKERS)) {
    return "misconfigured";
  }

  if (hasSuccessfulExit(input) && !hasAny(text, ERROR_MARKERS)) {
    return "available";
  }

  return "unknown_failure";
}

export function providerPreflightRepairGuidance(status: ProviderPreflightStatus): string[] {
  return [...REPAIR_GUIDANCE[status]];
}

export function isProviderLaunchable(status: ProviderPreflightStatus): boolean {
  return status === "available";
}

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 2500;
const MAX_PREFLIGHT_TIMEOUT_MS = 5000;
const MAX_EVIDENCE_CHARS = 500;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function summarizeStatus(results: ProviderPreflightResult[], requiredUnavailable: boolean): ProviderPreflightStatus {
  if (requiredUnavailable) {
    return results.find((result) => result.check.required && !result.launchable)?.status ?? "unknown_failure";
  }
  if (results.some((result) => result.status === "available")) return "available";
  if (results.length > 0 && results.every((result) => result.status === "not_checked")) return "not_checked";
  return results[0]?.status ?? "not_checked";
}

function resultForCheck(check: ProviderPreflightCheck, status: ProviderPreflightStatus, evidence: string[]): ProviderPreflightResult {
  return {
    status,
    check,
    launchable: isProviderLaunchable(status),
    evidence,
    repairGuidance: providerPreflightRepairGuidance(status),
  };
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_PREFLIGHT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_PREFLIGHT_TIMEOUT_MS;
  return Math.min(Math.floor(timeoutMs), MAX_PREFLIGHT_TIMEOUT_MS);
}

function probeCommandLine(probe: ProviderPreflightProbe): string {
  return `${probe.command} ${probe.args.join(" ")}`.trim();
}

function boundedEvidence(label: string, value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  const bounded = trimmed.length > MAX_EVIDENCE_CHARS ? `${trimmed.slice(0, MAX_EVIDENCE_CHARS)}…` : trimmed;
  return [`${label}: ${bounded}`];
}

function evidenceForExecResult(probe: ProviderPreflightProbe, result: ProviderPreflightExecResult): string[] {
  return [
    probeCommandLine(probe),
    `exit=${result.code ?? "unknown"}`,
    ...boundedEvidence("stdout", result.stdout),
    ...boundedEvidence("stderr", result.stderr),
  ];
}

function evidenceForExecError(probe: ProviderPreflightProbe, error: unknown): string[] {
  return [probeCommandLine(probe), ...boundedEvidence("error", textFromError(error))];
}

/**
 * Run safe, bounded worker-provider preflight probes and aggregate launchability.
 *
 * This runner only executes checks that explicitly provide a non-destructive
 * probe (typically `--help`, `--version`, or an existing dry-run surface). A
 * provider without such a probe is reported as `not_checked`; the runner never
 * starts real workers and never retries failed/unauthorized probes.
 */
export async function preflightWorkerProviders(options: PreflightWorkerProvidersOptions): Promise<ProviderPreflightSummary> {
  const timeout = normalizeTimeoutMs(options.timeoutMs);
  const results: ProviderPreflightResult[] = [];

  for (const check of options.checks) {
    if (!check.probe) {
      results.push(resultForCheck(check, "not_checked", [`${check.label}: no safe bounded probe configured`]));
      continue;
    }

    try {
      const probe = await options.exec(check.probe.command, check.probe.args, { cwd: options.cwd, timeout });
      const status = classifyProviderAuthEvidence({
        code: probe.code,
        exitCode: probe.code,
        stdout: probe.stdout ?? "",
        stderr: probe.stderr ?? "",
      });
      results.push(resultForCheck(check, status, evidenceForExecResult(check.probe, probe)));
    } catch (error) {
      const status = classifyProviderAuthEvidence({ error });
      results.push(resultForCheck(check, status, evidenceForExecError(check.probe, error)));
    }
  }

  const launchableResults = results.filter((result) => result.launchable);
  const requiredUnavailable = results.some((result) => result.check.required && !result.launchable);
  const downgradeReasons = results
    .filter((result) => !result.launchable)
    .map((result) => `${result.check.required ? "Required" : "Optional"} ${result.check.label} is ${result.status}`);

  return {
    status: summarizeStatus(results, requiredUnavailable),
    launchableCount: launchableResults.length,
    requiredUnavailable,
    results,
    selectedCheckIds: launchableResults.map((result) => result.check.id),
    downgradeReasons,
    repairGuidance: uniqueStrings(results.flatMap((result) => result.repairGuidance)),
  };
}
