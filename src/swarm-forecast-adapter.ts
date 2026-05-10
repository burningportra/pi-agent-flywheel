import { extractArtifacts, extractVerificationContract } from "./beads.js";
import type { Bead } from "./types.js";
import {
  SWARM_FORECAST_INPUT_SCHEMA,
  classifyValidationCommand,
  sanitizeForecastEvidence,
  type SwarmForecastAgentActivityInput,
  type SwarmForecastAgentInput,
  type SwarmForecastBuildLaneInput,
  type SwarmForecastFileReservationInput,
  type SwarmForecastInput,
} from "./swarm-forecast.js";

export interface ForecastAdapterReservation {
  id?: number | string;
  agent?: string;
  agent_name?: string;
  path_pattern?: string;
  path?: string;
  state?: string;
  exclusive?: boolean;
  expires_at?: string;
  active?: boolean;
}

export interface ForecastAdapterAgent {
  name?: string;
  agent_name?: string;
  status?: string;
  last_active_at?: string;
  current_bead?: string | null;
  capabilities?: string[];
}

export interface ForecastAdapterActivity {
  agent?: string;
  agent_name?: string;
  timestamp?: string;
  source?: string;
  bead_id?: string;
  summary?: string;
  paths?: string[];
  tags?: string[];
}

export interface BuildSwarmForecastInputOptions {
  beads: Bead[];
  dependencyMap?: Map<string, string[]> | Record<string, string[]>;
  agents?: ForecastAdapterAgent[];
  agentActivity?: ForecastAdapterActivity[];
  fileReservations?: ForecastAdapterReservation[];
  sourceWarnings?: string[];
  buildLaneCapacity?: number;
}

function dependencyIds(bead: Bead, dependencyMap?: Map<string, string[]> | Record<string, string[]>): string[] {
  if (dependencyMap instanceof Map) return [...(dependencyMap.get(bead.id) ?? [])].sort();
  if (dependencyMap && bead.id in dependencyMap) return [...(dependencyMap[bead.id] ?? [])].sort();
  const rawDeps = (bead as unknown as { dependencies?: Array<{ id?: string; depends_on_id?: string }> }).dependencies ?? [];
  return rawDeps.map((dep) => dep.id ?? dep.depends_on_id).filter((id): id is string => typeof id === "string" && id.length > 0).sort();
}

export function inferValidationLanes(description: string): string[] {
  const contract = extractVerificationContract(description);
  const text = contract?.body ?? description;
  const lanes = new Set<string>();
  const commandLike = text.match(/(?:npm|pnpm|yarn|bun|cargo|python3?|pytest|vitest|tsc|br|bv)\s+[^`\n.;]+/gi) ?? [];
  for (const command of commandLike) {
    const lane = classifyValidationCommand(command);
    if (lane !== "unknown") lanes.add(lane);
    if (/\bbr\b|\bbv\b/.test(command)) lanes.add("cli-check");
  }
  if (/npm\s+run\s+build|tsc\b|typecheck/i.test(text)) lanes.add("npm-build");
  if (/npm\s+test|vitest|test\s+--/i.test(text)) lanes.add("npm-test");
  if (/pytest|python3?\s+-m\s+unittest/i.test(text)) lanes.add("python-unittest");
  return [...lanes].sort();
}

function normalizeAgentStatus(status: string | undefined): SwarmForecastAgentInput["status"] {
  if (status === "active" || status === "idle" || status === "inactive" || status === "unknown") return status;
  if (status === "stuck" || status === "offline") return "inactive";
  return "unknown";
}

function normalizeReservationState(reservation: ForecastAdapterReservation): SwarmForecastFileReservationInput["state"] {
  if (reservation.state === "expired" || reservation.state === "released" || reservation.state === "active") return reservation.state;
  if (reservation.active === false) return "released";
  return "active";
}

export function normalizeForecastReservations(reservations: ForecastAdapterReservation[] = []): SwarmForecastFileReservationInput[] {
  return reservations.flatMap((reservation, index) => {
    const path = reservation.path_pattern ?? reservation.path;
    const agent = reservation.agent ?? reservation.agent_name;
    if (!path || !agent) return [];
    return [{
      id: Number(reservation.id ?? index + 1),
      agent: sanitizeForecastEvidence(agent),
      path_pattern: sanitizeForecastEvidence(path),
      state: normalizeReservationState(reservation),
      exclusive: reservation.exclusive !== false,
      expires_at: reservation.expires_at,
    }];
  }).sort((left, right) => left.id - right.id);
}

export function normalizeForecastAgents(agents: ForecastAdapterAgent[] = []): SwarmForecastAgentInput[] {
  return agents.flatMap((agent) => {
    const name = agent.name ?? agent.agent_name;
    if (!name) return [];
    return [{
      name: sanitizeForecastEvidence(name),
      status: normalizeAgentStatus(agent.status),
      last_active_at: agent.last_active_at,
      current_bead: agent.current_bead ? sanitizeForecastEvidence(agent.current_bead) : agent.current_bead,
      capabilities: (agent.capabilities ?? []).map(sanitizeForecastEvidence).sort(),
    }];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeForecastActivity(activity: ForecastAdapterActivity[] = []): SwarmForecastAgentActivityInput[] {
  return activity.flatMap((item) => {
    const agent = item.agent ?? item.agent_name;
    if (!agent) return [];
    return [{
      agent: sanitizeForecastEvidence(agent),
      timestamp: item.timestamp,
      source: sanitizeForecastEvidence(item.source ?? "activity"),
      bead_id: item.bead_id ? sanitizeForecastEvidence(item.bead_id) : undefined,
      summary: sanitizeForecastEvidence(item.summary ?? ""),
      paths: (item.paths ?? []).map(sanitizeForecastEvidence).sort(),
      tags: (item.tags ?? []).map(sanitizeForecastEvidence).sort(),
    }];
  }).sort((left, right) => `${left.agent}:${left.timestamp ?? ""}`.localeCompare(`${right.agent}:${right.timestamp ?? ""}`));
}

function buildLaneInputs(lanes: string[], capacity: number): SwarmForecastBuildLaneInput[] {
  return [...new Set(lanes)].sort().map((lane) => ({ id: lane, kind: lane.startsWith("npm") ? "node" : lane.startsWith("python") ? "python" : "cli", capacity, running: 0, queued: 0 }));
}

export function buildSwarmForecastInput(options: BuildSwarmForecastInputOptions): SwarmForecastInput {
  const laneIds = new Set<string>();
  const beads = [...options.beads]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((bead) => {
      const validation_lanes = inferValidationLanes(bead.description ?? "");
      for (const lane of validation_lanes) laneIds.add(lane);
      return {
        id: bead.id,
        title: bead.title,
        status: bead.status,
        priority: bead.priority,
        depends_on: dependencyIds(bead, options.dependencyMap),
        labels: [...(bead.labels ?? [])].sort(),
        files: extractArtifacts(bead).sort(),
        validation_lanes,
      };
    });

  return {
    schema: SWARM_FORECAST_INPUT_SCHEMA,
    beads,
    agents: normalizeForecastAgents(options.agents),
    agent_activity: normalizeForecastActivity(options.agentActivity),
    file_reservations: normalizeForecastReservations(options.fileReservations),
    build_lanes: buildLaneInputs([...laneIds], options.buildLaneCapacity ?? 4),
    validation_history: [],
    source_warnings: [...(options.sourceWarnings ?? [])].sort(),
  };
}
