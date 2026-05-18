import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Bead,
  BvInsights,
  BvNextPick,
  VerificationContract,
  VerificationContractIssue,
  VerificationContractRequirement,
} from "./types.js";
import { resilientExec, brExec, brExecJson } from "./cli-exec.js";

/**
 * Check if a bead ID matches the expected br-NNN pattern.
 * The br CLI generates IDs like "br-1", "br-42", "br-123".
 * Non-conforming IDs may break Agent Mail thread_id conventions.
 */
export function isValidBeadId(id: string): boolean {
  return /^[a-z][a-z0-9]*-\d+$/.test(id);
}

/**
 * Find beads with non-standard IDs in a list.
 */
export function findNonStandardIds(beads: Bead[]): string[] {
  return beads
    .map(b => b.id)
    .filter(id => !isValidBeadId(id));
}

export interface TemplateHygieneIssue {
  beadId: string;
  issueType: "raw-template-marker" | "template-shorthand" | "unresolved-placeholder" | "template-missing-structure";
  excerpt: string;
  reason: string;
}

export interface PlanAuditMatch {
  beadId: string;
  title: string;
  score: number;
}

export interface PlanAuditSection {
  heading: string;
  summary: string;
  matches: PlanAuditMatch[];
}

export interface PlanToBeadAudit {
  sections: PlanAuditSection[];
  uncoveredSections: PlanAuditSection[];
  weakMappings: PlanAuditSection[];
}

export type BeadDependencyType = "blocks" | "parent-child" | "related";

export interface StagedBeadVerification {
  commandsChecks: string;
  successLooksLike: string;
  manualProofFallback: string;
}

export interface StagedBeadCreation {
  /** Stable local reference used by dependencies before br assigns a final ID. */
  localId: string;
  title: string;
  description: string;
  type: string;
  priority: number;
  files: string[];
  verification: StagedBeadVerification;
  labels?: string[];
  estimate?: number;
  metadata?: Record<string, unknown>;
}

export interface StagedBeadDependency {
  /** Local or existing bead reference for the bead that depends on another bead. */
  from: string;
  /** Local or existing bead reference for the bead being depended on. */
  to: string;
  type: BeadDependencyType;
  metadata?: Record<string, unknown>;
}

export interface StagedBeadMutationPlan {
  beads: StagedBeadCreation[];
  dependencies: StagedBeadDependency[];
  metadata?: Record<string, unknown>;
}

export type BeadMutationDiagnosticCode =
  | "invalid-plan"
  | "missing-field"
  | "invalid-field"
  | "invalid-dependency-type";

export interface BeadMutationDiagnostic {
  code: BeadMutationDiagnosticCode;
  path: string;
  message: string;
  beadRef?: string;
  dependencyIndex?: number;
}

export type NormalizeBeadMutationPlanResult =
  | { ok: true; plan: StagedBeadMutationPlan; diagnostics: [] }
  | { ok: false; diagnostics: BeadMutationDiagnostic[] };

const BEAD_DEPENDENCY_TYPES = new Set<BeadDependencyType>(["blocks", "parent-child", "related"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayField(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.map((item) => stringField(item));
  if (strings.some((item) => item === null)) return null;
  return strings as string[];
}

function addMissingFieldDiagnostic(
  diagnostics: BeadMutationDiagnostic[],
  path: string,
  message: string,
  beadRef?: string,
  dependencyIndex?: number
): void {
  diagnostics.push({ code: "missing-field", path, message, beadRef, dependencyIndex });
}

function addInvalidFieldDiagnostic(
  diagnostics: BeadMutationDiagnostic[],
  path: string,
  message: string,
  beadRef?: string,
  dependencyIndex?: number
): void {
  diagnostics.push({ code: "invalid-field", path, message, beadRef, dependencyIndex });
}

function normalizeStagedBead(
  value: unknown,
  index: number,
  diagnostics: BeadMutationDiagnostic[]
): StagedBeadCreation | null {
  const path = `beads[${index}]`;
  if (!isRecord(value)) {
    addInvalidFieldDiagnostic(diagnostics, path, "bead creation entry must be an object");
    return null;
  }

  const localId = stringField(value.localId ?? value.ref ?? value.id);
  const beadRef = localId ?? `${path}`;
  const title = stringField(value.title);
  const description = stringField(value.description);
  const type = stringField(value.type) ?? "task";
  const priority = numberField(value.priority);
  const files = stringArrayField(value.files);
  const labels = value.labels === undefined ? undefined : stringArrayField(value.labels);
  const estimate = value.estimate === undefined ? undefined : numberField(value.estimate);
  const verification = isRecord(value.verification) ? value.verification : null;
  const commandsChecks = verification ? stringField(verification.commandsChecks ?? verification.commands ?? verification.checks) : null;
  const successLooksLike = verification ? stringField(verification.successLooksLike ?? verification.success) : null;
  const manualProofFallback = verification ? stringField(verification.manualProofFallback ?? verification.manualProof ?? verification.fallback) : null;

  if (!localId) addMissingFieldDiagnostic(diagnostics, `${path}.localId`, "bead creation is missing a localId/ref used by dependencies", beadRef);
  if (!title) addMissingFieldDiagnostic(diagnostics, `${path}.title`, "bead creation is missing a title", beadRef);
  if (!description) addMissingFieldDiagnostic(diagnostics, `${path}.description`, "bead creation is missing a description", beadRef);
  if (priority === null) addMissingFieldDiagnostic(diagnostics, `${path}.priority`, "bead creation is missing a numeric priority", beadRef);
  if (!files || files.length === 0) addMissingFieldDiagnostic(diagnostics, `${path}.files`, "bead creation is missing a non-empty files list", beadRef);
  if (!verification) addMissingFieldDiagnostic(diagnostics, `${path}.verification`, "bead creation is missing verification guidance", beadRef);
  if (verification && !commandsChecks) addMissingFieldDiagnostic(diagnostics, `${path}.verification.commandsChecks`, "verification is missing commands/checks guidance", beadRef);
  if (verification && !successLooksLike) addMissingFieldDiagnostic(diagnostics, `${path}.verification.successLooksLike`, "verification is missing success expectations", beadRef);
  if (verification && !manualProofFallback) addMissingFieldDiagnostic(diagnostics, `${path}.verification.manualProofFallback`, "verification is missing manual proof fallback guidance", beadRef);
  if (value.labels !== undefined && labels === null) addInvalidFieldDiagnostic(diagnostics, `${path}.labels`, "labels must be an array of strings", beadRef);
  if (value.estimate !== undefined && estimate === null) addInvalidFieldDiagnostic(diagnostics, `${path}.estimate`, "estimate must be numeric when provided", beadRef);

  if (!localId || !title || !description || priority === null || !files || files.length === 0 || !verification || !commandsChecks || !successLooksLike || !manualProofFallback || labels === null || estimate === null) {
    return null;
  }

  return {
    localId,
    title,
    description,
    type,
    priority,
    files,
    verification: { commandsChecks, successLooksLike, manualProofFallback },
    ...(labels ? { labels } : {}),
    ...(typeof estimate === "number" ? { estimate } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

function normalizeStagedDependency(
  value: unknown,
  index: number,
  diagnostics: BeadMutationDiagnostic[]
): StagedBeadDependency | null {
  const path = `dependencies[${index}]`;
  if (!isRecord(value)) {
    addInvalidFieldDiagnostic(diagnostics, path, "dependency entry must be an object", undefined, index);
    return null;
  }

  const from = stringField(value.from ?? value.issue ?? value.child);
  const to = stringField(value.to ?? value.dependsOn ?? value.depends_on ?? value.parent);
  const typeValue = stringField(value.type) ?? "blocks";

  if (!from) addMissingFieldDiagnostic(diagnostics, `${path}.from`, "dependency is missing the dependent bead reference", undefined, index);
  if (!to) addMissingFieldDiagnostic(diagnostics, `${path}.to`, "dependency is missing the depended-on bead reference", undefined, index);
  if (!BEAD_DEPENDENCY_TYPES.has(typeValue as BeadDependencyType)) {
    diagnostics.push({
      code: "invalid-dependency-type",
      path: `${path}.type`,
      message: `dependency type must be one of: ${Array.from(BEAD_DEPENDENCY_TYPES).join(", ")}`,
      dependencyIndex: index,
    });
  }

  if (!from || !to || !BEAD_DEPENDENCY_TYPES.has(typeValue as BeadDependencyType)) return null;

  return {
    from,
    to,
    type: typeValue as BeadDependencyType,
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

/**
 * Normalizes a structured bead mutation request into a staged plan.
 *
 * This is the boundary between planner/approval code and br mutations: callers
 * pass data, not shell commands. The result is either a typed plan that can be
 * validated/applied later, or field-level diagnostics that point at the exact
 * bead/dependency entry that needs repair.
 */
export function normalizeBeadMutationPlan(input: unknown): NormalizeBeadMutationPlanResult {
  const diagnostics: BeadMutationDiagnostic[] = [];
  if (!isRecord(input)) {
    return { ok: false, diagnostics: [{ code: "invalid-plan", path: "$", message: "bead mutation plan must be an object" }] };
  }

  const rawBeads = input.beads ?? input.creations;
  const rawDependencies = input.dependencies ?? input.edges ?? [];
  if (!Array.isArray(rawBeads)) {
    diagnostics.push({ code: "missing-field", path: "beads", message: "bead mutation plan is missing a beads array" });
  }
  if (!Array.isArray(rawDependencies)) {
    diagnostics.push({ code: "invalid-field", path: "dependencies", message: "dependencies must be an array when provided" });
  }

  const beads = Array.isArray(rawBeads)
    ? rawBeads.flatMap((entry, index) => {
        const bead = normalizeStagedBead(entry, index, diagnostics);
        return bead ? [bead] : [];
      })
    : [];
  const dependencies = Array.isArray(rawDependencies)
    ? rawDependencies.flatMap((entry, index) => {
        const dependency = normalizeStagedDependency(entry, index, diagnostics);
        return dependency ? [dependency] : [];
      })
    : [];

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    diagnostics: [],
    plan: {
      beads,
      dependencies,
      ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
    },
  };
}

export interface ValidateBeadMutationPlanOptions {
  existingBeads?: Pick<Bead, "id">[];
  existingDependencies?: StagedBeadDependency[];
}

export type ValidateBeadMutationPlanResult =
  | { ok: true; plan: StagedBeadMutationPlan; diagnostics: [] }
  | { ok: false; diagnostics: BeadMutationDiagnostic[]; plan?: StagedBeadMutationPlan };

/**
 * Validates a staged bead mutation plan without invoking br or mutating .beads/.
 */
export function validateBeadMutationPlan(input: unknown, options: ValidateBeadMutationPlanOptions = {}): ValidateBeadMutationPlanResult {
  const normalized = normalizeBeadMutationPlan(input);
  if (!normalized.ok) return normalized;

  const diagnostics: BeadMutationDiagnostic[] = [];
  const plan = normalized.plan;
  const existingIds = new Set((options.existingBeads ?? []).map((bead) => bead.id));
  const knownIds = new Set(existingIds);
  const seenLocalIds = new Map<string, number>();

  for (const [index, bead] of plan.beads.entries()) {
    const priorIndex = seenLocalIds.get(bead.localId);
    if (priorIndex !== undefined) {
      diagnostics.push({
        code: "invalid-field",
        path: `beads[${index}].localId`,
        beadRef: bead.localId,
        message: `duplicate staged bead localId also appears at beads[${priorIndex}]`,
      });
    }
    if (existingIds.has(bead.localId)) {
      diagnostics.push({
        code: "invalid-field",
        path: `beads[${index}].localId`,
        beadRef: bead.localId,
        message: `staged bead localId collides with existing bead ${bead.localId}`,
      });
    }
    seenLocalIds.set(bead.localId, index);
    knownIds.add(bead.localId);

    if (!/^###\s+Files\s*:/im.test(bead.description)) {
      diagnostics.push({ code: "missing-field", path: `beads[${index}].description`, beadRef: bead.localId, message: "bead description is missing required ### Files: section" });
    }

    for (const issue of validateVerificationContract({ id: bead.localId, title: bead.title, description: bead.description, status: "open", priority: bead.priority, type: bead.type, labels: [] })) {
      diagnostics.push({
        code: issue.issueType === "missing-section" ? "missing-field" : "invalid-field",
        path: `beads[${index}].description`,
        beadRef: bead.localId,
        message: issue.reason,
      });
    }

    for (const issue of validateTemplateHygiene({ id: bead.localId, description: bead.description, status: "open" })) {
      diagnostics.push({
        code: "invalid-field",
        path: `beads[${index}].description`,
        beadRef: bead.localId,
        message: issue.reason,
      });
    }
  }

  const seenEdges = new Map<string, string>();
  for (const dependency of options.existingDependencies ?? []) {
    seenEdges.set(dependencyEdgeKey(dependency), "existing dependency");
  }

  for (const [index, dependency] of plan.dependencies.entries()) {
    if (dependency.from === dependency.to) {
      diagnostics.push({ code: "invalid-field", path: `dependencies[${index}]`, dependencyIndex: index, message: "dependency cannot point to itself" });
    }
    if (!knownIds.has(dependency.from)) {
      diagnostics.push({ code: "missing-field", path: `dependencies[${index}].from`, dependencyIndex: index, message: `dependency references unknown bead ${dependency.from}` });
    }
    if (!knownIds.has(dependency.to)) {
      diagnostics.push({ code: "missing-field", path: `dependencies[${index}].to`, dependencyIndex: index, message: `dependency references unknown bead ${dependency.to}` });
    }

    const edgeKey = dependencyEdgeKey(dependency);
    const duplicateOf = seenEdges.get(edgeKey);
    if (duplicateOf) {
      diagnostics.push({
        code: "invalid-field",
        path: `dependencies[${index}]`,
        dependencyIndex: index,
        message: duplicateOf === "existing dependency"
          ? "duplicate dependency edge already exists"
          : `duplicate dependency edge in staged plan (first seen at ${duplicateOf})`,
      });
    } else {
      seenEdges.set(edgeKey, `dependencies[${index}]`);
    }
  }

  const cycle = findDependencyCycle([...plan.dependencies, ...(options.existingDependencies ?? [])], knownIds);
  if (cycle.length > 0) {
    diagnostics.push({ code: "invalid-field", path: "dependencies", message: `dependency cycle detected: ${cycle.join(" -> ")}` });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics, plan };
  return { ok: true, diagnostics: [], plan };
}

function dependencyEdgeKey(dependency: StagedBeadDependency): string {
  return `${dependency.from}\u0000${dependency.to}`;
}

export interface BeadMutationCommandResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
}

export interface BeadMutationCommandRunner {
  run(args: string[]): Promise<BeadMutationCommandResult>;
}

export interface BeadMutationAppliedCommand {
  args: string[];
  ok: boolean;
  stdout: string;
  stderr?: string;
}

export interface AppliedBeadMutation {
  localId: string;
  beadId: string;
  title: string;
}

export interface AppliedDependencyMutation {
  from: string;
  to: string;
  type: BeadDependencyType;
}

export type ExecuteBeadMutationPlanResult =
  | {
      ok: true;
      status: "applied";
      createdBeads: AppliedBeadMutation[];
      dependencyEdges: AppliedDependencyMutation[];
      commands: BeadMutationAppliedCommand[];
    }
  | {
      ok: false;
      status: "validation-failed" | "partial-failure";
      diagnostics: BeadMutationDiagnostic[];
      createdBeads: AppliedBeadMutation[];
      dependencyEdges: AppliedDependencyMutation[];
      commands: BeadMutationAppliedCommand[];
    };

export interface ExecuteBeadMutationPlanOptions extends ValidateBeadMutationPlanOptions {
  runner: BeadMutationCommandRunner;
}

/**
 * Applies a staged bead mutation plan through one controlled command boundary.
 * Validation always runs before the first command is invoked.
 */
export async function executeBeadMutationPlan(input: unknown, options: ExecuteBeadMutationPlanOptions): Promise<ExecuteBeadMutationPlanResult> {
  const validation = validateBeadMutationPlan(input, options);
  if (!validation.ok) {
    return { ok: false, status: "validation-failed", diagnostics: validation.diagnostics, createdBeads: [], dependencyEdges: [], commands: [] };
  }

  const localToCreated = new Map<string, string>();
  const createdBeads: AppliedBeadMutation[] = [];
  const dependencyEdges: AppliedDependencyMutation[] = [];
  const commands: BeadMutationAppliedCommand[] = [];

  const run = async (args: string[]): Promise<BeadMutationCommandResult> => {
    const result = await options.runner.run(args);
    commands.push({ args, ok: result.ok, stdout: result.stdout, ...(result.stderr ? { stderr: result.stderr } : {}) });
    return result;
  };

  for (const bead of validation.plan.beads) {
    const result = await run(["create", bead.title, "-t", bead.type, "-p", String(bead.priority), "-d", bead.description]);
    if (!result.ok) {
      return {
        ok: false,
        status: "partial-failure",
        diagnostics: [{ code: "invalid-field", path: `beads.${bead.localId}`, beadRef: bead.localId, message: result.stderr || result.stdout || "bead creation command failed" }],
        createdBeads,
        dependencyEdges,
        commands,
      };
    }
    const beadId = extractCreatedBeadId(result.stdout) ?? bead.localId;
    localToCreated.set(bead.localId, beadId);
    createdBeads.push({ localId: bead.localId, beadId, title: bead.title });
  }

  for (const dependency of validation.plan.dependencies) {
    const from = localToCreated.get(dependency.from) ?? dependency.from;
    const to = localToCreated.get(dependency.to) ?? dependency.to;
    const result = await run(["dep", "add", from, to, "--type", dependency.type]);
    if (!result.ok) {
      return {
        ok: false,
        status: "partial-failure",
        diagnostics: [{ code: "invalid-field", path: `dependencies.${dependency.from}->${dependency.to}`, message: result.stderr || result.stdout || "dependency command failed" }],
        createdBeads,
        dependencyEdges,
        commands,
      };
    }
    dependencyEdges.push({ from, to, type: dependency.type });
  }

  return { ok: true, status: "applied", createdBeads, dependencyEdges, commands };
}

function extractCreatedBeadId(stdout: string): string | null {
  return stdout.match(/Created(?:\s+bead)?\s+([a-z][a-z0-9]*-[A-Za-z0-9]+)/i)?.[1] ?? null;
}

function findDependencyCycle(dependencies: StagedBeadDependency[], knownIds: Set<string>): string[] {
  const graph = new Map<string, string[]>();
  for (const id of knownIds) graph.set(id, []);
  for (const dep of dependencies) {
    if (!knownIds.has(dep.from) || !knownIds.has(dep.to)) continue;
    graph.get(dep.from)!.push(dep.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): string[] => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(Math.max(start, 0)), id];
    }
    if (visited.has(id)) return [];
    visiting.add(id);
    stack.push(id);
    for (const next of graph.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle.length > 0) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return [];
  };

  for (const id of graph.keys()) {
    const cycle = visit(id);
    if (cycle.length > 0) return cycle;
  }
  return [];
}

function tokenizePlanAudit(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[`*_#>-]/g, " ")
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 4)
    )
  );
}

function scorePlanAuditSection(sectionText: string, bead: Bead): number {
  const sectionTokens = tokenizePlanAudit(sectionText);
  if (sectionTokens.length === 0) return 0;

  const beadText = `${bead.title}\n${bead.description}`.toLowerCase();
  let hits = 0;
  for (const token of sectionTokens) {
    if (beadText.includes(token)) hits++;
  }
  return hits / sectionTokens.length;
}

function summarizePlanAuditSection(body: string): string {
  return body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^#+\s/.test(line))
    ?.slice(0, 160) ?? "";
}

export function auditPlanToBeads(plan: string, beads: Bead[]): PlanToBeadAudit {
  const normalized = plan.trim();
  if (!normalized) return { sections: [], uncoveredSections: [], weakMappings: [] };

  const headingPattern = /^#{1,3}\s+(.+)$/gm;
  const headingMatches = Array.from(normalized.matchAll(headingPattern));
  const rawSections = headingMatches.length > 0
    ? headingMatches.map((match, index) => {
        const heading = match[1].trim();
        const start = match.index! + match[0].length;
        const end = index + 1 < headingMatches.length ? headingMatches[index + 1].index! : normalized.length;
        const body = normalized.slice(start, end).trim();
        return { heading, body };
      })
    : [{ heading: "Plan", body: normalized }];

  const sections = rawSections
    .map(({ heading, body }) => {
      const sectionText = `${heading}\n${body}`;
      const matches = beads
        .map((bead) => ({ beadId: bead.id, title: bead.title, score: scorePlanAuditSection(sectionText, bead) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      return {
        heading,
        summary: summarizePlanAuditSection(body),
        matches,
      } satisfies PlanAuditSection;
    })
    .filter((section) => section.summary.length > 0 || section.matches.length > 0);

  const uncoveredSections = sections.filter((section) => section.matches.length === 0);
  const weakMappings = sections.filter((section) => section.matches.length > 0 && section.matches[0].score < 0.35);
  return { sections, uncoveredSections, weakMappings };
}

// ─── bv (beads-viewer) Integration ────────────────────────────

let _bvAvailable: boolean | null = null;

/**
 * Detects whether the `bv` CLI is available. Result is cached.
 */
export async function detectBv(pi: ExtensionAPI): Promise<boolean> {
  if (_bvAvailable !== null) return _bvAvailable;
  const result = await resilientExec(pi, "which", ["bv"], { timeout: 5000, maxRetries: 0, logWarnings: false });
  _bvAvailable = result.ok && result.value.stdout.trim().length > 0;
  return _bvAvailable;
}

/** Reset bv detection cache (for testing). */
export function resetBvCache(): void {
  _bvAvailable = null;
}

/**
 * Runs `bv --robot-insights` and returns typed graph health data.
 * Returns null if bv is unavailable or output can't be parsed.
 */
export async function bvInsights(
  pi: ExtensionAPI,
  cwd: string
): Promise<BvInsights | null> {
  if (!(await detectBv(pi))) return null;
  const result = await resilientExec(pi, "bv", ["--robot-insights"], { timeout: 15000, cwd, maxRetries: 1, retryDelayMs: 300 });
  if (!result.ok) return null;
  try {
    return JSON.parse(result.value.stdout) as BvInsights;
  } catch {
    console.warn(`[beads] bv --robot-insights returned unparseable JSON`);
    return null;
  }
}

/**
 * Runs `bv --robot-triage` and returns a prioritised list of beads for
 * multiple parallel agents, each routed to a graph-safe non-contending bead.
 * Distinct from --robot-next (which picks one bead for one agent):
 * --robot-triage accounts for which beads can be worked on in parallel
 * without contending on the same bottleneck node.
 * Returns null if bv is unavailable or output can't be parsed.
 */
export async function bvTriage(
  pi: ExtensionAPI,
  cwd: string
): Promise<BvNextPick[] | null> {
  if (!(await detectBv(pi))) return null;
  const result = await resilientExec(pi, "bv", ["--robot-triage", "--json"], { timeout: 15000, cwd, maxRetries: 1, retryDelayMs: 300 });
  if (!result.ok) return null;
  const stdout = result.value.stdout.trim();
  if (!stdout) return null;
  try {
    const data = JSON.parse(stdout);
    // --robot-triage may return an array or a single object
    if (Array.isArray(data)) return data as BvNextPick[];
    if (data && data.id) return [data as BvNextPick];
    return null;
  } catch {
    console.warn(`[beads] bv --robot-triage returned unparseable JSON`);
    return null;
  }
}

/**
 * Runs `bv --robot-next` and returns the highest-priority next bead.
 * Returns null if bv is unavailable, no actionable items, or parse error.
 */
export async function bvNext(
  pi: ExtensionAPI,
  cwd: string
): Promise<BvNextPick | null> {
  if (!(await detectBv(pi))) return null;
  const result = await resilientExec(pi, "bv", ["--robot-next"], { timeout: 15000, cwd, maxRetries: 1, retryDelayMs: 300 });
  if (!result.ok) return null;
  const stdout = result.value.stdout.trim();
  if (!stdout) return null;
  try {
    const data = JSON.parse(stdout);
    if (!data || !data.id) return null;
    return data as BvNextPick;
  } catch {
    console.warn(`[beads] bv --robot-next returned unparseable JSON`);
    return null;
  }
}

/**
 * Runs `bv --robot-plan` and returns the raw output string.
 * Returns null if bv is unavailable, empty output, or error.
 */
export async function bvPlan(
  pi: ExtensionAPI,
  cwd: string
): Promise<string | null> {
  if (!(await detectBv(pi))) return null;
  const result = await resilientExec(pi, "bv", ["--robot-plan"], { timeout: 15000, cwd, maxRetries: 1, retryDelayMs: 300 });
  if (!result.ok) return null;
  const stdout = result.value.stdout.trim();
  if (!stdout) return null;
  return stdout;
}

// ─── Beads Integration ────────────────────────────────────────

/**
 * Reads all beads via `br list --json`.
 */
export async function readBeads(
  pi: ExtensionAPI,
  cwd: string
): Promise<Bead[]> {
  const result = await brExecJson<Bead[] | { issues: Bead[] }>(pi, [
    "list",
    "--json",
    "--fields", "id,title,description,status,priority,issue_type,labels,estimate,parent,created_at,updated_at,closed_at",
    "--deferred", // include deferred beads
  ], { timeout: 10000, cwd });
  if (!result.ok) return [];
  const data = result.value;
  return (Array.isArray(data) ? data : (data as any)?.issues ?? []) as Bead[];
}

/**
 * Reads ready beads (unblocked) via `br ready --json`.
 */
export async function readyBeads(
  pi: ExtensionAPI,
  cwd: string
): Promise<Bead[]> {
  const result = await brExecJson<Bead[] | { issues: Bead[] }>(pi, ["ready", "--json"], { timeout: 10000, cwd });
  if (!result.ok) return [];
  const data = result.value;
  // br ready --json returns a bare array, br list --json returns {issues: [...]}
  return (Array.isArray(data) ? data : (data as any)?.issues ?? []) as Bead[];
}

/**
 * Gets a single bead by ID via `br show <id> --json`.
 */
export async function getBeadById(
  pi: ExtensionAPI,
  cwd: string,
  id: string
): Promise<Bead | null> {
  // `br show <id> --json` currently emits a one-element array, while older
  // beads versions emitted a bare object. Normalize both shapes here; callers
  // treat the result as a Bead and will otherwise crash later on fields like
  // `title`/`description` being undefined.
  const result = await brExecJson<Bead | Bead[]>(pi, ["show", id, "--json"], { timeout: 10000, cwd });
  if (!result.ok) return null;
  const value = result.value;
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Lists dependency IDs for a bead via `br dep list <id>`.
 */
export async function beadDeps(
  pi: ExtensionAPI,
  cwd: string,
  id: string
): Promise<string[]> {
  const result = await brExec(pi, ["dep", "list", id], { timeout: 10000, cwd });
  if (!result.ok) return [];
  const lines = result.value.stdout.trim().split("\n").filter(Boolean);
  // Each line typically contains a bead ID; extract first token
  return lines.map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
}

/**
 * Extracts artifact file paths from a bead's description.
 * Looks for a '### Files:' section or bullet lines starting with known prefixes
 * (src/, lib/, test/, tests/, dist/, docs/). Files outside these directories
 * won't be detected unless they appear in a '### Files:' section.
 */
export function extractArtifacts(bead: Bead): string[] {
  const desc = bead.description ?? "";
  const paths: string[] = [];

  // Match lines like "- src/foo.ts" or "- lib/bar.js"
  const linePattern = /^[-*]\s+((?:src|lib|test|tests|dist|docs)\/\S+)/gm;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(desc)) !== null) {
    paths.push(match[1]);
  }

  // Also check for a ### Files: section with indented paths
  const filesSection = desc.match(/###\s*Files:\s*\n([\s\S]*?)(?:\n###|\n\n|$)/);
  if (filesSection) {
    const sectionLines = filesSection[1].split("\n");
    for (const line of sectionLines) {
      const trimmed = line.replace(/^[-*\s]+/, "").trim();
      if (trimmed && /^[\w./]/.test(trimmed) && trimmed.includes("/")) {
        if (!paths.includes(trimmed)) paths.push(trimmed);
      }
    }
  }

  return paths;
}

/**
 * Extracts the required `### Verification:` section from a bead description.
 * The section ends at the next markdown heading, so adjacent `### Files:` or
 * other sections are not mixed into the verification contract body.
 */
export function extractVerificationContract(description: string): VerificationContract | null {
  const lines = (description ?? "").split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^###\s+Verification\s*:?\s*$/i.test(line.trim()));
  if (headingIndex === -1) return null;

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index++) {
    if (/^#{1,6}\s+\S/.test(lines[index].trim())) {
      endIndex = index;
      break;
    }
  }

  return {
    body: lines.slice(headingIndex + 1, endIndex).join("\n").trim(),
    startLine: headingIndex + 1,
    endLine: endIndex,
  };
}

const VERIFICATION_REQUIREMENT_LABELS: Record<VerificationContractRequirement, string> = {
  "commands-checks": "commands/checks",
  "success-expectations": "success expectations",
  "manual-proof": "manual proof guidance",
};

function verificationContractHasRequirement(body: string, requirement: VerificationContractRequirement): boolean {
  switch (requirement) {
    case "commands-checks":
      return /commands?\s*\/\s*checks?|commands?|checks?|run\s+[`'\"]?[\w./:-]+|(?:npm|pnpm|yarn|bun|cargo|go|pytest|vitest|tsc)\s+/i.test(body);
    case "success-expectations":
      return /success\s+looks\s+like|successful\s+(?:output|status)|passes?|exit\s+code\s+0|compiles?|green|expected\s+(?:output|status)|status\s+means/i.test(body);
    case "manual-proof":
      return /manual\s+(?:proof|evidence|verification|fallback|check)|(?:proof|evidence)\s+fallback|when\s+automation\s+(?:cannot|can't|can not|does\s+not)\s+cover|if\s+(?:automation|commands?|checks?).{0,80}(?:cannot|can't|can not|unable|insufficient|not\s+cover)/i.test(body);
  }
}

export function validateVerificationContract(bead: Bead): VerificationContractIssue[] {
  const contract = extractVerificationContract(bead.description ?? "");
  if (!contract) {
    return [{
      beadId: bead.id,
      issueType: "missing-section",
      reason: `bead ${bead.id} is missing required ### Verification: section`,
    }];
  }

  const requirements: VerificationContractRequirement[] = ["commands-checks", "success-expectations", "manual-proof"];
  return requirements
    .filter((requirement) => !verificationContractHasRequirement(contract.body, requirement))
    .map((requirement) => ({
      beadId: bead.id,
      issueType: "missing-requirement" as const,
      requirement,
      excerpt: contract.body.slice(0, 160),
      reason: `bead ${bead.id} verification section is missing ${VERIFICATION_REQUIREMENT_LABELS[requirement]}`,
    }));
}

export function validateTemplateHygiene(bead: Pick<Bead, "id" | "description" | "status">): TemplateHygieneIssue[] {
  if (bead.status !== "open") return [];
  const desc = bead.description ?? "";
  const lines = desc.split("\n");
  const hasFilesSection = desc.includes("### Files:") || /^[-*]\s+(?:src|lib|test|tests|dist|docs)\/\S+/m.test(desc);
  const acceptanceCriteriaCount = lines.filter((line) => line.trim().startsWith("- [ ]") || line.trim().startsWith("- [x]")).length;
  const templateSignals = new Set<TemplateHygieneIssue["issueType"]>();
  const issues: TemplateHygieneIssue[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/(?:^|\[|\b)use template:/i.test(line)) {
      templateSignals.add("raw-template-marker");
      issues.push({
        beadId: bead.id,
        issueType: "raw-template-marker",
        excerpt: line,
        reason: `bead ${bead.id} has a raw template marker instead of expanded instructions`,
      });
      continue;
    }

    if (/\bsee\s+(?:the\s+)?template\b/i.test(line) || /\buse\s+the\s+template\b/i.test(line)) {
      templateSignals.add("template-shorthand");
      issues.push({
        beadId: bead.id,
        issueType: "template-shorthand",
        excerpt: line,
        reason: `bead ${bead.id} uses template shorthand without expanded implementation details`,
      });
    }
  }

  for (const match of desc.matchAll(/{{\s*\w+\s*}}|<[A-Z][A-Z0-9_]{2,}>/g)) {
    const excerpt = match[0];
    templateSignals.add("unresolved-placeholder");
    issues.push({
      beadId: bead.id,
      issueType: "unresolved-placeholder",
      excerpt,
      reason: `bead ${bead.id} still contains an unresolved template placeholder`,
    });
  }

  if (templateSignals.size > 0 && (!hasFilesSection || acceptanceCriteriaCount < 2)) {
    issues.push({
      beadId: bead.id,
      issueType: "template-missing-structure",
      excerpt: !hasFilesSection ? "missing ### Files:" : `acceptance criteria count: ${acceptanceCriteriaCount}`,
      reason: `bead ${bead.id} has template artifacts but is missing concrete file scope or enough acceptance criteria`,
    });
  }

  return issues;
}

/**
 * Updates the status of a bead.
 */
export async function updateBeadStatus(
  pi: ExtensionAPI,
  cwd: string,
  beadId: string,
  status: "in_progress" | "closed" | "deferred"
): Promise<void> {
  await brExec(pi, ["update", beadId, "--status", status], {
    timeout: 10000,
    cwd,
  });
  // Non-fatal: brExec logs warning on failure, caller continues regardless
}

/**
 * Updates a bead description.
 */
export async function updateBeadDescription(
  pi: ExtensionAPI,
  cwd: string,
  beadId: string,
  description: string
): Promise<boolean> {
  const result = await brExec(pi, ["update", beadId, "--description", description], {
    timeout: 10000,
    cwd,
  });
  return result.ok;
}

/**
 * Syncs beads to disk.
 */
export async function syncBeads(
  pi: ExtensionAPI,
  cwd: string
): Promise<void> {
  await brExec(pi, ["sync", "--flush-only"], { timeout: 10000, cwd });
  // Non-fatal: brExec logs warning on failure, caller continues regardless
}

/**
 * Closes orphaned beads by setting their status to "closed".
 * Returns the list of IDs that were successfully closed.
 */
export async function remediateOrphans(
  pi: ExtensionAPI,
  cwd: string,
  orphanIds: string[]
): Promise<{ closed: string[]; failed: string[] }> {
  const closed: string[] = [];
  const failed: string[] = [];
  for (const id of orphanIds) {
    const result = await brExec(pi, ["update", id, "--status", "closed"], { timeout: 10000, cwd });
    if (result.ok) {
      closed.push(id);
    } else {
      failed.push(id);
    }
  }
  return { closed, failed };
}

/**
 * Validates beads — checks for dependency cycles, orphaned open beads, and graph health.
 * When bv is available, uses graph-theoretic analysis for richer validation.
 */
export async function validateBeads(
  pi: ExtensionAPI,
  cwd: string
): Promise<{ ok: boolean; orphaned: string[]; cycles: boolean; warnings: string[]; shallowBeads: { id: string; reason: string }[]; templateIssues: TemplateHygieneIssue[]; verificationIssues: VerificationContractIssue[] }> {
  let cycles = false;
  let orphaned: string[] = [];
  const warnings: string[] = [];
  const shallowBeads: { id: string; reason: string }[] = [];
  const templateIssues: TemplateHygieneIssue[] = [];
  const verificationIssues: VerificationContractIssue[] = [];

  // Read all beads once — reuse for every check below to avoid 3× shell execs
  const allBeadsForFilter = await readBeads(pi, cwd);

  // Try bv insights first for richer analysis
  const insights = await bvInsights(pi, cwd);
  const openBeadIds = new Set(allBeadsForFilter.filter((b) => b.status === "open" || b.status === "in_progress").map((b) => b.id));

  if (insights) {
    // Use bv data for cycles and orphans — but filter to open beads only
    // bv --robot-insights includes closed beads in its graph, which causes
    // stale orphans/articulation points/bottlenecks to pollute validation.
    // Only count cycles that involve at least one open bead
    cycles = insights.Cycles !== null && insights.Cycles.some((cycle) => cycle.some((id) => openBeadIds.has(id)));
    orphaned = (insights.Orphans ?? []).filter((id) => openBeadIds.has(id));

    // Add warnings for bottlenecks (open beads only)
    for (const b of insights.Bottlenecks ?? []) {
      if (b.Value > 5 && openBeadIds.has(b.ID)) {
        warnings.push(`bead ${b.ID} is a bottleneck (betweenness=${b.Value.toFixed(1)}) — consider splitting`);
      }
    }

    // Add warnings for articulation points (open beads only)
    for (const id of insights.Articulation ?? []) {
      if (openBeadIds.has(id)) {
        warnings.push(`bead ${id} is a single point of failure in the dep graph`);
      }
    }
  } else {
    // Fallback: manual cycle/orphan detection
    // Note: br dep cycles uses exit code 1 to signal "cycles found" (not an error),
    // so we use resilientExec with no retry and read stdout regardless of exit code.
    const cycleResult = await resilientExec(pi, "br", ["dep", "cycles"], {
      timeout: 10000, cwd, maxRetries: 0, isTransient: () => false, logWarnings: false,
    });
    const cycleOutput = (cycleResult.ok
      ? cycleResult.value.stdout
      : cycleResult.error.stdout
    ).toLowerCase();
    if (cycleOutput) {
      const confirmsNoCycles =
        cycleOutput.includes("no dependency cycles detected") ||
        cycleOutput.includes("all dependency checks passed");
      const indicatesCycles =
        /detected\s+cycle|cycle\s+detected|dependency\s+cycles\s+detected/.test(cycleOutput);
      cycles = !confirmsNoCycles && indicatesCycles;
    }

    try {
      const openBeads = allBeadsForFilter.filter((b) => b.status === "open" || b.status === "in_progress");
      if (openBeads.length > 1) {
        const hasDeps = new Set<string>();
        const isDependedOn = new Set<string>();
        for (const bead of openBeads) {
          const deps = await beadDeps(pi, cwd, bead.id);
          if (deps.length > 0) {
            hasDeps.add(bead.id);
            for (const dep of deps) isDependedOn.add(dep);
          }
        }
        for (const bead of openBeads) {
          if (!hasDeps.has(bead.id) && !isDependedOn.has(bead.id)) {
            orphaned.push(bead.id);
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // Warn about non-standard bead IDs (may break Agent Mail thread_id conventions)
  const nonStandardIds = findNonStandardIds(allBeadsForFilter); // reuse already-loaded beads
  if (nonStandardIds.length > 0) {
    warnings.push(`Non-standard bead IDs (may break Agent Mail thread conventions): ${nonStandardIds.join(", ")}`);
  }

  // Detect shallow beads and template hygiene problems
  try {
    for (const bead of allBeadsForFilter) {
      const desc = bead.description ?? "";
      if (bead.status === "open" || bead.status === "in_progress") {
        if (desc.length === 0) {
          shallowBeads.push({ id: bead.id, reason: "Empty description" });
        } else if (desc.length < 50) {
          shallowBeads.push({ id: bead.id, reason: `Description too short (${desc.length} chars)` });
        } else if (!desc.includes("### Files:") && !/^[-*]\s+(?:src|lib|test|tests|dist|docs)\/\S+/m.test(desc)) {
          shallowBeads.push({ id: bead.id, reason: "Missing ### Files: section" });
        }
      }

      if (bead.status === "open" || bead.status === "in_progress") {
        verificationIssues.push(...validateVerificationContract(bead));
      }

      templateIssues.push(...validateTemplateHygiene(bead));
    }
  } catch {
    // Non-fatal
  }

  return { ok: !cycles && orphaned.length === 0 && templateIssues.length === 0 && verificationIssues.length === 0, orphaned, cycles, warnings, shallowBeads, templateIssues, verificationIssues };
}

/**
 * Quality check result for a single bead.
 */
export interface QualityFailure {
  beadId: string;
  check: string;
  reason: string;
}

export interface QualityCheckSummary {
  beadCount: number;
  readyBeadCount: number;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  /** 0-100 structural quality score that moves as individual checks are fixed. */
  score: number;
  failingBeadCount: number;
  /** Counts unique failing check units by check name. */
  failuresByCheck: Record<string, number>;
}

/**
 * Validates each open bead against automated quality checks:
 * 1. Has substance (description >= 100 chars)
 * 2. Has file scope (### Files: with paths)
 * 3. Has acceptance criteria (- [ ] checkboxes)
 * 4. Not oversimplified (word count >= 50)
 * 5. No cycles (via validateBeads)
 * 6. Dependencies connected (has deps, is depended on, or is sole bead)
 */
export async function qualityCheckBeads(
  pi: ExtensionAPI,
  cwd: string
): Promise<{ passed: boolean; failures: QualityFailure[]; summary: QualityCheckSummary }> {
  const failures: QualityFailure[] = [];
  const allBeads = await readBeads(pi, cwd);
  const openBeads = allBeads.filter((b) => b.status === "open" || b.status === "in_progress");

  if (openBeads.length === 0) {
    return {
      passed: true,
      failures,
      summary: {
        beadCount: 0,
        readyBeadCount: 0,
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: 0,
        score: 100,
        failingBeadCount: 0,
        failuresByCheck: {},
      },
    };
  }

  // Check cycles and template hygiene
  const validation = await validateBeads(pi, cwd);
  if (validation.cycles) {
    failures.push({ beadId: "*", check: "no-cycles", reason: "Dependency cycles detected in bead graph" });
  }
  for (const issue of validation.templateIssues) {
    failures.push({
      beadId: issue.beadId,
      check: "template-hygiene",
      reason: `${issue.issueType}: ${issue.excerpt}`,
    });
  }

  // Build dep graph for connectivity check
  const hasDeps = new Set<string>();
  const isDependedOn = new Set<string>();
  for (const bead of openBeads) {
    const deps = await beadDeps(pi, cwd, bead.id);
    if (deps.length > 0) {
      hasDeps.add(bead.id);
      for (const dep of deps) isDependedOn.add(dep);
    }
  }

  for (const bead of openBeads) {
    const desc = bead.description ?? "";

    // 1. Has substance
    if (desc.length < 100) {
      failures.push({ beadId: bead.id, check: "has-substance", reason: `Description too short (${desc.length} chars, need >= 100)` });
    }

    // 2. Has file scope
    if (!desc.includes("### Files:") && !/^[-*]\s+(?:src|lib|test|tests|dist|docs)\/\S+/m.test(desc)) {
      failures.push({ beadId: bead.id, check: "has-file-scope", reason: "No file scope found (missing ### Files: section or file paths)" });
    }

    // 3. Has acceptance criteria
    if (!desc.includes("- [ ]")) {
      failures.push({ beadId: bead.id, check: "has-acceptance-criteria", reason: "No acceptance criteria (missing - [ ] checkboxes)" });
    }

    // 4. Not oversimplified
    const wordCount = desc.split(/\s+/).filter(Boolean).length;
    if (wordCount < 50) {
      failures.push({ beadId: bead.id, check: "not-oversimplified", reason: `Description too brief (${wordCount} words, need >= 50)` });
    }

    // 6. Dependencies connected (skip for single-bead plans)
    if (openBeads.length > 1 && !hasDeps.has(bead.id) && !isDependedOn.has(bead.id)) {
      failures.push({ beadId: bead.id, check: "deps-connected", reason: "Bead is disconnected — no dependencies and not depended on by any bead" });
    }
  }

  // 7. File overlap among ready beads (parallel execution conflict)
  const ready = await readyBeads(pi, cwd);
  if (ready.length >= 2) {
    const artifactMap = new Map<string, string[]>(); // file -> bead IDs
    for (const bead of ready) {
      const files = extractArtifacts(bead);
      for (const file of files) {
        if (!artifactMap.has(file)) artifactMap.set(file, []);
        artifactMap.get(file)!.push(bead.id);
      }
    }
    for (const [file, ids] of artifactMap) {
      if (ids.length > 1) {
        failures.push({
          beadId: ids.join(","),
          check: "file-overlap",
          reason: `Beads ${ids.join(", ")} both modify ${file} — parallel execution may cause conflicts`,
        });
      }
    }
  }

  const failureKeys = new Set<string>();
  const failuresByCheck: Record<string, number> = {};
  const failingBeadIds = new Set<string>();
  for (const failure of failures) {
    if (failure.check === "no-cycles") {
      for (const bead of openBeads) failingBeadIds.add(bead.id);
    } else if (failure.check === "file-overlap") {
      for (const beadId of failure.beadId.split(",").map((id) => id.trim()).filter(Boolean)) {
        failingBeadIds.add(beadId);
      }
    }

    const keys = failure.check === "no-cycles" || failure.check === "file-overlap"
      ? [`*:${failure.check}`]
      : failure.beadId
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
          .map((id) => `${id}:${failure.check}`);

    for (const key of keys) {
      if (failureKeys.has(key)) continue;
      failureKeys.add(key);
      failuresByCheck[failure.check] = (failuresByCheck[failure.check] ?? 0) + 1;
      const beadId = key.split(":", 1)[0];
      if (beadId !== "*") failingBeadIds.add(beadId);
    }
  }

  const perBeadChecks = 5 + (openBeads.length > 1 ? 1 : 0); // template hygiene + 4 content checks + optional dep connectivity
  const totalChecks = 1 + (ready.length >= 2 ? 1 : 0) + (openBeads.length * perBeadChecks); // global no-cycles + optional file-overlap + per-bead checks
  const failedChecks = failureKeys.size;
  const passedChecks = Math.max(0, totalChecks - failedChecks);
  const summary: QualityCheckSummary = {
    beadCount: openBeads.length,
    readyBeadCount: ready.length,
    totalChecks,
    passedChecks,
    failedChecks,
    score: totalChecks === 0 ? 100 : Math.round((passedChecks / totalChecks) * 100),
    failingBeadCount: failingBeadIds.size,
    failuresByCheck,
  };

  return { passed: failures.length === 0, failures, summary };
}

/**
 * Returns a human-readable summary of bead states.
 */
export function getBeadsSummary(beads: Bead[]): string {
  if (beads.length === 0) return "no beads tracked";

  let closed = 0;
  let inProgress = 0;
  let open = 0;
  let deferred = 0;

  for (const bead of beads) {
    const status = bead.status ?? "open";
    if (status === "closed") closed++;
    else if (status === "in_progress") inProgress++;
    else if (status === "deferred") deferred++;
    else open++;
  }

  const parts: string[] = [];
  if (closed > 0) parts.push(`${closed} closed ✅`);
  if (inProgress > 0) parts.push(`${inProgress} in-progress 🔄`);
  if (open > 0) parts.push(`${open} open ⏳`);
  if (deferred > 0) parts.push(`${deferred} deferred ⏸️`);
  return parts.join(", ") || "unknown";
}
