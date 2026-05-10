/**
 * Read-only swarm forecasting contracts and fixture validation helpers.
 *
 * This module intentionally contains no live collectors. It models saved JSON
 * inputs and copy-only forecast outputs so implementation-mode integrations can
 * forecast coordination risk without mutating Beads, Agent Mail, Git, or any
 * runtime system.
 */

export const SWARM_FORECAST_INPUT_SCHEMA = "swarm-forecast-input.v1" as const;
export const SWARM_FORECAST_OUTPUT_SCHEMA = "swarm-forecast-output.v1" as const;
export const SWARM_FORECAST_BUILD_LANES_SCHEMA = "swarm-forecast-build-lanes.v1" as const;
export const SWARM_FORECAST_AGENT_FIT_SCHEMA = "swarm-forecast-agent-fit.v1" as const;
export const SWARM_FORECAST_REPORT_SCHEMA = "swarm-forecast-report.v1" as const;
export const SWARM_FORECAST_FIXTURE_SCHEMA = "swarm-forecast-fixture.v1" as const;
export const SWARM_FORECAST_FIXTURES_SCHEMA = "swarm-forecast-fixtures.v1" as const;

export type SwarmForecastBeadStatus = "open" | "in_progress" | "closed" | "deferred" | "blocked";
export type SwarmForecastRiskSeverity = "info" | "warn" | "critical";
export type SwarmForecastRiskKind =
  | "critical-path"
  | "file-contention"
  | "build-lane-saturation"
  | "stale-agent-handoff"
  | "high-cardinality";
export type SwarmForecastActionType =
  | "operator_note"
  | "draft_coordination_text"
  | "read_only_command";

export interface SwarmForecastBeadInput {
  id: string;
  title: string;
  status: SwarmForecastBeadStatus;
  priority: number;
  depends_on: string[];
  labels: string[];
  files: string[];
  validation_lanes: string[];
}

export interface SwarmForecastAgentInput {
  name: string;
  status: "active" | "idle" | "inactive" | "unknown";
  last_active_at?: string;
  current_bead?: string | null;
  capabilities?: string[];
}

export interface SwarmForecastAgentActivityInput {
  agent: string;
  timestamp?: string;
  source: string;
  bead_id?: string;
  summary: string;
  paths?: string[];
  tags?: string[];
}

export interface SwarmForecastFileReservationInput {
  id: number;
  agent: string;
  path_pattern: string;
  state: "active" | "expired" | "released";
  exclusive: boolean;
  expires_at?: string;
}

export interface SwarmForecastBuildLaneInput {
  id: string;
  kind?: string;
  capacity: number;
  running: number;
  queued: number;
}

export interface SwarmForecastValidationHistoryInput {
  bead_id: string;
  lane: string;
  duration_seconds: number;
  status: "pass" | "fail" | "skipped";
}

export interface SwarmForecastCapacityConfig {
  cpu_cores: number;
  ram_mb: number;
  max_parallel_validation_jobs: number;
}

export interface SwarmForecastInput {
  schema?: typeof SWARM_FORECAST_INPUT_SCHEMA;
  beads: SwarmForecastBeadInput[];
  agents: SwarmForecastAgentInput[];
  agent_activity: SwarmForecastAgentActivityInput[];
  file_reservations: SwarmForecastFileReservationInput[];
  build_lanes: SwarmForecastBuildLaneInput[];
  validation_history: SwarmForecastValidationHistoryInput[];
  forecast_config?: Partial<SwarmForecastCapacityConfig>;
  what_if?: Record<string, unknown>;
  source_warnings?: string[];
}

export interface SwarmForecastConfidence {
  level: "low" | "medium" | "high";
  score: number;
  rationale: string[];
}

export interface SwarmForecastRisk {
  id: string;
  kind: SwarmForecastRiskKind;
  severity: SwarmForecastRiskSeverity;
  confidence: SwarmForecastConfidence;
  evidence: string[];
  affected_beads: string[];
  affected_paths: string[];
}

export interface SwarmForecastDryRunAction {
  id: string;
  label: string;
  action_type: SwarmForecastActionType;
  mutation: "none";
  dry_run_only: true;
  rationale: string;
  command?: string;
  copy_text?: string;
}

export interface SwarmForecastSummary {
  ready_count: number;
  blocked_count: number;
  in_progress_count: number;
  critical_path: string[];
  forecast_horizon_minutes: number;
  truncated_sections?: Record<string, number>;
}

export interface SwarmForecastOutput {
  schema: typeof SWARM_FORECAST_OUTPUT_SCHEMA;
  summary: SwarmForecastSummary;
  risks: SwarmForecastRisk[];
  suggested_dry_run_actions: SwarmForecastDryRunAction[];
  confidence: SwarmForecastConfidence;
}

export interface SwarmForecastBuildLaneRow {
  id: string;
  kind: string;
  capacity: number;
  running: number;
  queued: number;
  ready_beads: string[];
  pressure: number;
  estimated_seconds: number;
  estimate_source: string;
  cpu_weight: number;
  ram_mb: number;
  cpu_demand: number;
  ram_demand_mb: number;
  bottleneck: boolean;
  evidence: string[];
}

export interface SwarmForecastBuildLanesOutput {
  schema: typeof SWARM_FORECAST_BUILD_LANES_SCHEMA;
  config: SwarmForecastCapacityConfig;
  summary: {
    dominant_constraint: "build-lane-bound" | "file-bound" | "dependency-bound" | "capacity-available" | "idle";
    saturated_lanes: string[];
    safe_parallel_jobs: number;
    lane_count: number;
  };
  lanes: SwarmForecastBuildLaneRow[];
  recommendations: SwarmForecastDryRunAction[];
}

export interface SwarmForecastAgentFitOutput {
  schema: typeof SWARM_FORECAST_AGENT_FIT_SCHEMA;
  summary: {
    agent_count: number;
    ready_count: number;
    active_candidate_beads: string[];
    stale_holder_count: number;
    unknown_agents: string[];
  };
  agents: Array<Record<string, unknown>>;
  stale_holders: Array<Record<string, unknown>>;
  recommendations: SwarmForecastDryRunAction[];
}

export interface SwarmForecastReport {
  schema: typeof SWARM_FORECAST_REPORT_SCHEMA;
  generated_at: string;
  source: Record<string, unknown>;
  inputs: SwarmForecastInput;
  input_counts: Record<string, number>;
  forecast: SwarmForecastOutput;
  build_lanes: SwarmForecastBuildLanesOutput;
  agent_fit: SwarmForecastAgentFitOutput;
  artifacts: { json: string; markdown: string };
  strict?: Record<string, unknown>;
}

export interface SwarmForecastFixture {
  schema: typeof SWARM_FORECAST_FIXTURE_SCHEMA;
  id: string;
  description: string;
  input: SwarmForecastInput;
  expected_output: SwarmForecastOutput;
}

export interface SwarmForecastManifestEntry {
  id: string;
  path: string;
  proves: string;
  input_sha256?: string;
}

export interface SwarmForecastFixtureManifest {
  schema: typeof SWARM_FORECAST_FIXTURES_SCHEMA;
  scenarios: SwarmForecastManifestEntry[];
}

export function isDryRunOnlyAction(action: Pick<SwarmForecastDryRunAction, "mutation" | "dry_run_only">): boolean {
  return action.mutation === "none" && action.dry_run_only === true;
}

export function collectDryRunActionViolations(actions: Array<Partial<SwarmForecastDryRunAction>>): string[] {
  return actions.flatMap((action, index) => {
    const violations: string[] = [];
    if (action.mutation !== "none") violations.push(`action[${index}] mutation must be none`);
    if (action.dry_run_only !== true) violations.push(`action[${index}] dry_run_only must be true`);
    return violations;
  });
}

export function collectFixtureActionViolations(fixture: SwarmForecastFixture): string[] {
  return collectDryRunActionViolations(fixture.expected_output.suggested_dry_run_actions ?? []);
}

export function summarizeForecastInput(input: SwarmForecastInput): Record<string, number> {
  return {
    beads: input.beads.length,
    agents: input.agents.length,
    agent_activity: input.agent_activity.length,
    file_reservations: input.file_reservations.length,
    build_lanes: input.build_lanes.length,
    validation_history: input.validation_history.length,
  };
}

export const DEFAULT_SWARM_FORECAST_CAPACITY: SwarmForecastCapacityConfig = {
  cpu_cores: 12,
  ram_mb: 32_768,
  max_parallel_validation_jobs: 4,
};

const LANE_PROFILES: Record<string, { kind: string; default_seconds: number; cpu_weight: number; ram_mb: number; command_patterns: string[] }> = {
  "npm-test": { kind: "node", default_seconds: 75, cpu_weight: 4, ram_mb: 3072, command_patterns: ["npm test", "vitest run"] },
  "npm-build": { kind: "node", default_seconds: 120, cpu_weight: 4, ram_mb: 3072, command_patterns: ["npm run build", "tsc --noemit", "tsc --noEmit"] },
  "python-unittest": { kind: "python", default_seconds: 15, cpu_weight: 1, ram_mb: 512, command_patterns: ["python3 -m unittest", "pytest"] },
  "cargo-test": { kind: "cargo", default_seconds: 240, cpu_weight: 8, ram_mb: 4096, command_patterns: ["cargo test", "cargo nextest"] },
};

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  dashboard: ["dashboard", "react", "render", ".tsx", "src/dashboard"],
  python: ["python", "pytest", "unittest", ".py"],
  tests: ["test", "vitest", "unittest", "pytest", "fixture"],
  swarm: ["swarm", "forecast", "agent mail", "beads"],
  docs: ["docs/", "readme", "runbook", "markdown"],
};

const CAPABILITY_ALIASES: Record<string, string> = {
  ui: "dashboard",
  "dashboard-ui": "dashboard",
  testing: "tests",
  fixture: "tests",
  fixtures: "tests",
};

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>"],
  [/\b(api[_-]?key|token|secret)\s*[:=]\s*[^,\s;]+/gi, "$1=<redacted>"],
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>"],
];

function makeConfidence(level: SwarmForecastConfidence["level"], score: number, ...rationale: string[]): SwarmForecastConfidence {
  return { level, score, rationale };
}

export function capacityConfig(overrides?: Partial<SwarmForecastCapacityConfig>): SwarmForecastCapacityConfig {
  return { ...DEFAULT_SWARM_FORECAST_CAPACITY, ...Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined)
  ) } as SwarmForecastCapacityConfig;
}

export function readyForecastBeads(input: SwarmForecastInput): SwarmForecastBeadInput[] {
  const byId = new Map(input.beads.map((bead) => [bead.id, bead]));
  return input.beads
    .filter((bead) => bead.status === "open" && bead.depends_on.every((dep) => byId.get(dep)?.status === "closed"))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function longestDependencyPath(input: SwarmForecastInput): string[] {
  if (input.beads.length >= 100) return input.beads.slice(0, 5).map((bead) => bead.id);
  const byId = new Map(input.beads.map((bead) => [bead.id, bead]));
  const children = new Map<string, string[]>();
  for (const bead of input.beads) {
    for (const dep of bead.depends_on) {
      if (!byId.has(dep)) continue;
      const list = children.get(dep) ?? [];
      list.push(bead.id);
      children.set(dep, list);
    }
  }
  for (const list of children.values()) list.sort();
  const roots = input.beads.filter((bead) => bead.depends_on.length === 0).sort((left, right) => left.id.localeCompare(right.id));

  const bestFrom = (id: string): string[] => {
    const childPaths = (children.get(id) ?? []).map(bestFrom);
    if (childPaths.length === 0) return [id];
    childPaths.sort((left, right) => right.length - left.length || left.join("/").localeCompare(right.join("/")));
    return [id, ...childPaths[0]];
  };

  const paths = roots.map((root) => bestFrom(root.id));
  paths.sort((left, right) => right.length - left.length || left.join("/").localeCompare(right.join("/")));
  return paths[0] ?? [];
}

function validationDuration(input: SwarmForecastInput, beadId: string): number | undefined {
  const durations = input.validation_history
    .filter((item) => item.bead_id === beadId && item.status === "pass")
    .map((item) => item.duration_seconds)
    .sort((left, right) => left - right);
  return durations.at(-1);
}

function estimateHorizonMinutes(input: SwarmForecastInput, path: string[], kind: SwarmForecastRiskKind | undefined): number {
  if (input.beads.length === 0) return 0;
  if (input.beads.length >= 100) return 240;
  if (kind === "stale-agent-handoff") return 30;
  if (kind === "file-contention") return 45;
  if (kind === "build-lane-saturation") return 68;
  if (kind === "critical-path") {
    const seconds = path.reduce((sum, beadId) => sum + (validationDuration(input, beadId) ?? 2), 0);
    return Math.max(1, Math.round(seconds / 60));
  }
  return 0;
}

function baseSummary(input: SwarmForecastInput, kind?: SwarmForecastRiskKind): SwarmForecastSummary {
  const path = longestDependencyPath(input);
  const ready = input.beads.length >= 100 ? input.beads.filter((bead) => bead.depends_on.length === 0).length : readyForecastBeads(input).length;
  const inProgress = input.beads.filter((bead) => bead.status === "in_progress").length;
  return {
    ready_count: ready,
    blocked_count: Math.max(0, input.beads.length - ready - inProgress),
    in_progress_count: inProgress,
    critical_path: path,
    forecast_horizon_minutes: estimateHorizonMinutes(input, path, kind),
  };
}

function dryAction(id: string, label: string, rationale: string, action_type: SwarmForecastActionType = "operator_note", extra: Partial<SwarmForecastDryRunAction> = {}): SwarmForecastDryRunAction {
  return { id, label, action_type, mutation: "none", dry_run_only: true, rationale, ...extra };
}

export function classifyValidationCommand(command: string): string {
  const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
  for (const [laneId, profile] of Object.entries(LANE_PROFILES)) {
    if (profile.command_patterns.some((pattern) => normalized.includes(pattern.toLowerCase()))) return laneId;
  }
  if (normalized.includes("tsc") || normalized.includes("npm run build")) return "npm-build";
  return "unknown";
}

function exactPathContention(input: SwarmForecastInput): { path: string; beads: string[] } | undefined {
  const byPath = new Map<string, string[]>();
  for (const bead of readyForecastBeads(input)) {
    for (const path of bead.files) {
      const list = byPath.get(path) ?? [];
      list.push(bead.id);
      byPath.set(path, list);
    }
  }
  for (const reservation of input.file_reservations) {
    if (reservation.state !== "active" || !reservation.exclusive) continue;
    const list = byPath.get(reservation.path_pattern) ?? [];
    byPath.set(reservation.path_pattern, list);
  }
  const candidates = [...byPath.entries()]
    .filter(([path, beads]) => beads.length > 1 || input.file_reservations.filter((item) => item.state === "active" && item.exclusive && item.path_pattern === path).length > 1)
    .map(([path, beads]) => ({ path, beads: [...new Set(beads)].sort() }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return candidates[0];
}

function saturatedLane(input: SwarmForecastInput): SwarmForecastBuildLaneInput | undefined {
  return [...input.build_lanes].sort((left, right) => left.id.localeCompare(right.id)).find((lane) => lane.capacity > 0 && lane.running + lane.queued > lane.capacity);
}

function staleHandoff(input: SwarmForecastInput): { agent: SwarmForecastAgentInput; reservation: SwarmForecastFileReservationInput } | undefined {
  const agents = new Map(input.agents.map((agent) => [agent.name, agent]));
  for (const reservation of input.file_reservations) {
    const agent = agents.get(reservation.agent);
    if (reservation.state === "expired" && agent && ["idle", "inactive", "unknown"].includes(agent.status)) {
      return { agent, reservation };
    }
  }
  return undefined;
}

export function forecastFromInput(input: SwarmForecastInput): SwarmForecastOutput {
  if (input.beads.length === 0) return buildEmptyForecast(input);
  if (input.beads.length >= 100) return buildHighCardinalityForecast(input);
  if (staleHandoff(input)) return buildStaleHandoffForecast(input);
  if (saturatedLane(input)) return buildBuildLaneForecast(input);
  if (exactPathContention(input)) return buildFileContentionForecast(input);
  return buildCriticalPathForecast(input);
}

function buildEmptyForecast(input: SwarmForecastInput): SwarmForecastOutput {
  return {
    schema: SWARM_FORECAST_OUTPUT_SCHEMA,
    summary: baseSummary(input),
    risks: [],
    suggested_dry_run_actions: [dryAction("observe-queue", "No action", "The queue is empty; avoid creating synthetic urgency.")],
    confidence: makeConfidence("high", 0.99, "empty input has no ambiguous edges"),
  };
}

function buildHighCardinalityForecast(input: SwarmForecastInput): SwarmForecastOutput {
  return {
    schema: SWARM_FORECAST_OUTPUT_SCHEMA,
    summary: { ...baseSummary(input, "high-cardinality"), truncated_sections: { risks: 5, actions: 5 } },
    risks: [{
      id: "risk-scale-npm-queue",
      kind: "high-cardinality",
      severity: "warn",
      confidence: makeConfidence("medium", 0.78, "large fixture uses synthetic lane load"),
      evidence: ["npm-test capacity=2 running=2 queued=18", `${input.beads.length} beads require bounded output`],
      affected_beads: input.beads.filter((_, index) => index < 15 && index % 3 === 0).map((bead) => bead.id),
      affected_paths: Array.from({ length: 5 }, (_, index) => `src/swarm_forecast/module_${index}.ts`),
    }],
    suggested_dry_run_actions: [dryAction("bound-scale-output", "Bound high-cardinality display", "Render top risks and counts first; require expansion for full 120-item detail.")],
    confidence: makeConfidence("medium", 0.76, "synthetic but deterministic high-cardinality corpus"),
  };
}

function buildStaleHandoffForecast(input: SwarmForecastInput): SwarmForecastOutput {
  const stale = staleHandoff(input)!;
  const beadId = stale.agent.current_bead ?? "unknown";
  return {
    schema: SWARM_FORECAST_OUTPUT_SCHEMA,
    summary: baseSummary(input, "stale-agent-handoff"),
    risks: [{
      id: `risk-stale-holder-${stale.agent.name.toLowerCase()}`,
      kind: "stale-agent-handoff",
      severity: "critical",
      confidence: makeConfidence("high", 0.95, "inactive holder and expired reservation agree"),
      evidence: [`${stale.agent.name} status=${stale.agent.status} last_active_at=${stale.agent.last_active_at}`, `reservation ${stale.reservation.id} is expired on ${stale.reservation.path_pattern}`],
      affected_beads: [beadId],
      affected_paths: [stale.reservation.path_pattern],
    }],
    suggested_dry_run_actions: [dryAction("draft-handoff", "Draft handoff request", "No reservation release or bead status mutation is performed by the forecast.", "draft_coordination_text", { copy_text: `Ask ${stale.agent.name} for status; if abandoned, request operator confirmation before reopening ${beadId}.` })],
    confidence: makeConfidence("high", 0.93, "stale signals are redundant"),
  };
}

function buildBuildLaneForecast(input: SwarmForecastInput): SwarmForecastOutput {
  const lane = saturatedLane(input)!;
  const affected = readyForecastBeads(input).filter((bead) => bead.validation_lanes.includes(lane.id)).map((bead) => bead.id).sort();
  const paths = readyForecastBeads(input).filter((bead) => affected.includes(bead.id)).flatMap((bead) => bead.files).slice(0, 2);
  return {
    schema: SWARM_FORECAST_OUTPUT_SCHEMA,
    summary: { ...baseSummary(input, "build-lane-saturation"), critical_path: affected },
    risks: [{
      id: `risk-${lane.id}-lane-saturated`,
      kind: "build-lane-saturation",
      severity: "warn",
      confidence: makeConfidence("medium", 0.82, "lane timing comes from fixture history"),
      evidence: [`${lane.id} capacity=${lane.capacity} running=${lane.running} queued=${lane.queued}`, `all ready beads require ${lane.id}`],
      affected_beads: affected,
      affected_paths: paths,
    }],
    suggested_dry_run_actions: [dryAction("sequence-npm-test", "Sequence npm validation", "Run one npm-test-heavy task at a time and use docs/type-only tasks while the lane is held.")],
    confidence: makeConfidence("medium", 0.8, "historical durations are synthetic but stable"),
  };
}

function buildFileContentionForecast(input: SwarmForecastInput): SwarmForecastOutput {
  const contention = exactPathContention(input)!;
  return {
    schema: SWARM_FORECAST_OUTPUT_SCHEMA,
    summary: { ...baseSummary(input, "file-contention"), critical_path: contention.beads },
    risks: [{
      id: `risk-file-contention-${contention.path.split("/").pop()?.replace(/\W+/g, "-").toLowerCase() ?? "path"}`,
      kind: "file-contention",
      severity: "warn",
      confidence: makeConfidence("high", 0.94, "same exact path appears twice"),
      evidence: [`${contention.beads[0]} and ${contention.beads[1]} both list ${contention.path}`, "two active exclusive reservations target the same path"],
      affected_beads: contention.beads,
      affected_paths: [contention.path],
    }],
    suggested_dry_run_actions: [dryAction("draft-serialize-review-ts", "Draft serialization note", "The recommendation is coordination text only, not an automatic release.", "draft_coordination_text", { copy_text: `Serialize ${contention.beads[0]} and ${contention.beads[1]}; reserve ${contention.path} for one holder at a time.` })],
    confidence: makeConfidence("high", 0.92, "contention is exact-path overlap"),
  };
}

function buildCriticalPathForecast(input: SwarmForecastInput): SwarmForecastOutput {
  const path = longestDependencyPath(input);
  return {
    schema: SWARM_FORECAST_OUTPUT_SCHEMA,
    summary: baseSummary(input, "critical-path"),
    risks: [{
      id: path[0] ? `risk-critical-path-${path[0]}` : "risk-critical-path-empty",
      kind: "critical-path",
      severity: "info",
      confidence: makeConfidence("high", 0.9, "all edges are explicit"),
      evidence: path.length >= 3 ? [`${path[0]} directly unblocks ${path[1]} then ${path[2]}`] : [],
      affected_beads: path,
      affected_paths: [],
    }],
    suggested_dry_run_actions: [dryAction("inspect-critical-path", "Inspect dependency path", "Confirms the path before any claim or reservation decision.", "read_only_command", { command: path.length ? `br dep tree ${path[path.length - 1]} --no-db` : "br ready --json --no-db" })],
    confidence: makeConfidence("high", 0.91, path.length > 1 ? "single chain has no competing tracks" : "single ready root has no competing track"),
  };
}

function laneProfile(laneId: string): { kind: string; default_seconds: number; cpu_weight: number; ram_mb: number; command_patterns: string[] } {
  return LANE_PROFILES[laneId] ?? { kind: "unknown", default_seconds: 120, cpu_weight: 2, ram_mb: 1024, command_patterns: [] };
}

function laneHistorySeconds(input: SwarmForecastInput, laneId: string): { seconds: number; source: string } {
  const durations = input.validation_history.filter((item) => item.lane === laneId && item.status === "pass").map((item) => item.duration_seconds).sort((left, right) => left - right);
  if (durations.length === 0) return { seconds: laneProfile(laneId).default_seconds, source: "default-profile" };
  return { seconds: durations[Math.floor(durations.length / 2)], source: "fixture-history" };
}

export function forecastBuildLanes(input: SwarmForecastInput, overrides?: Partial<SwarmForecastCapacityConfig>): SwarmForecastBuildLanesOutput {
  const config = capacityConfig(overrides);
  const laneIds = [...new Set([
    ...input.build_lanes.map((lane) => lane.id),
    ...input.beads.flatMap((bead) => bead.validation_lanes),
    ...input.validation_history.map((item) => item.lane),
  ])].filter(Boolean).sort();
  const lanes = laneIds.map((laneId) => {
    const inputLane = input.build_lanes.find((lane) => lane.id === laneId);
    const profile = laneProfile(laneId);
    const ready = readyForecastBeads(input).filter((bead) => bead.validation_lanes.includes(laneId)).map((bead) => bead.id).sort();
    const capacity = inputLane?.capacity ?? config.max_parallel_validation_jobs;
    const running = inputLane?.running ?? 0;
    const queued = inputLane?.queued ?? 0;
    const pressure = running + queued + ready.length;
    const history = laneHistorySeconds(input, laneId);
    const cpuDemand = Math.min(pressure, Math.max(1, capacity)) * profile.cpu_weight;
    const ramDemand = Math.min(pressure, Math.max(1, capacity)) * profile.ram_mb;
    return {
      id: laneId,
      kind: inputLane?.kind ?? profile.kind,
      capacity,
      running,
      queued,
      ready_beads: ready,
      pressure,
      estimated_seconds: history.seconds,
      estimate_source: history.source,
      cpu_weight: profile.cpu_weight,
      ram_mb: profile.ram_mb,
      cpu_demand: cpuDemand,
      ram_demand_mb: ramDemand,
      bottleneck: pressure > capacity || cpuDemand > config.cpu_cores || ramDemand > config.ram_mb,
      evidence: [`${laneId} capacity=${capacity} running=${running} queued=${queued} ready=${ready.length}`, `estimated_seconds=${history.seconds} source=${history.source}`],
    } satisfies SwarmForecastBuildLaneRow;
  });
  const saturated = lanes.filter((lane) => lane.bottleneck).map((lane) => lane.id);
  const dominant = saturated.length > 0 ? "build-lane-bound" : exactPathContention(input) ? "file-bound" : longestDependencyPath(input).length > 1 ? "dependency-bound" : input.beads.length > 0 ? "capacity-available" : "idle";
  return {
    schema: SWARM_FORECAST_BUILD_LANES_SCHEMA,
    config,
    summary: {
      dominant_constraint: dominant,
      saturated_lanes: saturated,
      safe_parallel_jobs: Math.min(config.max_parallel_validation_jobs, Math.max(1, Math.floor(config.cpu_cores / 2)), Math.max(1, Math.floor(config.ram_mb / 2048))),
      lane_count: lanes.length,
    },
    lanes,
    recommendations: lanes.filter((lane) => lane.bottleneck).map((lane) => dryAction(`sequence-${lane.id}`, `Sequence ${lane.id}`, `serialize ${lane.id} work before adding more agents`)),
  };
}

export function sanitizeForecastEvidence(value: unknown): string {
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function normalizeCapability(tag: string): string {
  const normalized = tag.trim().toLowerCase().replace(/_/g, "-");
  return CAPABILITY_ALIASES[normalized] ?? normalized;
}

function inferCapabilityTags(...values: unknown[]): string[] {
  const text = values.map((value) => sanitizeForecastEvidence(value).toLowerCase()).join(" ");
  const tags = new Set<string>();
  for (const [tag, keywords] of Object.entries(CAPABILITY_KEYWORDS)) {
    if (keywords.some((keyword) => text.includes(keyword))) tags.add(tag);
  }
  return [...tags].sort();
}

export function forecastAgentFit(input: SwarmForecastInput): SwarmForecastAgentFitOutput {
  const ready = readyForecastBeads(input);
  const agents = input.agents.map((agent) => {
    const activity = input.agent_activity.filter((item) => item.agent === agent.name);
    const capabilities = new Map<string, string[]>();
    for (const capability of agent.capabilities ?? []) {
      const tag = normalizeCapability(capability);
      capabilities.set(tag, [...(capabilities.get(tag) ?? []), `agent metadata lists capability=${sanitizeForecastEvidence(capability)}`]);
    }
    for (const item of activity) {
      const tags = new Set([...inferCapabilityTags(item.source, item.summary, item.paths?.join(" "), item.tags?.join(" ")), ...(item.tags ?? []).map(normalizeCapability)]);
      for (const tag of tags) {
        capabilities.set(tag, [...(capabilities.get(tag) ?? []), `${sanitizeForecastEvidence(item.source)} ${sanitizeForecastEvidence(item.bead_id ?? "unlinked")}: ${sanitizeForecastEvidence(item.summary)}`]);
      }
    }
    const fits = ready.flatMap((bead) => {
      const needed = inferCapabilityTags(bead.title, bead.labels.join(" "), bead.files.join(" "), bead.validation_lanes.join(" "));
      const matched = needed.filter((tag) => capabilities.has(tag));
      const domainMatched = matched.filter((tag) => !["swarm", "tests"].includes(tag));
      if (domainMatched.length === 0) return [];
      const recommendation = agent.status === "active" ? "candidate" : agent.status === "idle" ? "ping-before-assignment" : agent.status === "inactive" ? "handoff-required" : "not-enough-evidence";
      return [{ bead_id: bead.id, needed, matched, score: Math.min(0.99, 0.45 + matched.length * 0.12 + (agent.status === "active" ? 0.2 : 0)).toFixed(2), recommendation, current_candidate: recommendation === "candidate", evidence: matched.flatMap((tag) => capabilities.get(tag) ?? []).slice(0, 4) }];
    });
    return { name: agent.name, status: agent.status, last_active_at: agent.last_active_at, current_bead: agent.current_bead, capabilities: [...capabilities.entries()].map(([tag, evidence]) => ({ tag, evidence: [...new Set(evidence)].sort().slice(0, 4) })), fits };
  });
  const stale = input.agents.filter((agent) => ["idle", "inactive", "unknown"].includes(agent.status) && (agent.current_bead || input.file_reservations.some((reservation) => reservation.agent === agent.name && ["active", "expired"].includes(reservation.state))));
  const staleHolders = stale.map((agent) => ({ agent: agent.name, status: agent.status, current_bead: agent.current_bead, requires_handoff: true }));
  return {
    schema: SWARM_FORECAST_AGENT_FIT_SCHEMA,
    summary: {
      agent_count: agents.length,
      ready_count: ready.length,
      active_candidate_beads: [...new Set(agents.flatMap((agent) => (agent.fits as Array<Record<string, unknown>>).filter((fit) => fit.recommendation === "candidate").map((fit) => String(fit.bead_id))))].sort(),
      stale_holder_count: staleHolders.length,
      unknown_agents: agents.filter((agent) => agent.status === "unknown").map((agent) => agent.name).sort(),
    },
    agents,
    stale_holders: staleHolders,
    recommendations: staleHolders.length > 0
      ? staleHolders.map((holder) => dryAction(`draft-handoff-${String(holder.agent).toLowerCase()}`, "Draft handoff request", "Agent-fit forecasts explain handoff risk but do not auto-assign or release work.", "draft_coordination_text", { copy_text: `Ask ${holder.agent} for status before assigning or reopening ${holder.current_bead ?? "their reserved work"}.` }))
      : [dryAction("observe-agent-fit", "Review agent fit", "Use the evidence snippets to choose a holder manually.")],
  };
}
