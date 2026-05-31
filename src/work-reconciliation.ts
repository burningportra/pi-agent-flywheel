import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { SessionStage } from "./session-state.js";
import type { Bead, OrchestratorState } from "./types.js";

export interface WorkTodo {
  id: string;
  title: string;
  status: "open" | "in_progress" | "closed" | "deferred";
  updated_at?: string;
  source: string;
}

export interface WorkReconciliationInput {
  beads: Bead[];
  readyBeads?: Bead[];
  todos?: WorkTodo[];
  state?: Partial<OrchestratorState>;
  stage?: Pick<SessionStage, "phase" | "label" | "nextAction">;
  now?: Date;
  staleAfterHours?: number;
}

export interface WorkReconciliationItem {
  id: string;
  title: string;
  reason?: string;
}

export interface WorkReconciliationReport {
  stage?: Pick<SessionStage, "phase" | "label" | "nextAction">;
  activeWork: WorkReconciliationItem[];
  readyWork: WorkReconciliationItem[];
  blockedWork: WorkReconciliationItem[];
  closedButUnproven: WorkReconciliationItem[];
  staleOrSuperseded: WorkReconciliationItem[];
  assignedToOtherSession: WorkReconciliationItem[];
  nextRecommended?: WorkReconciliationItem;
  todoCount: number;
}

function item(id: string, title: string, reason?: string): WorkReconciliationItem {
  return reason ? { id, title, reason } : { id, title };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function timestampMs(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ageHours(updatedAt: string | undefined, now: Date): number | null {
  const updatedMs = timestampMs(updatedAt);
  if (!updatedMs) return null;
  return (now.getTime() - updatedMs) / (60 * 60 * 1000);
}

function hasProof(bead: Bead, state?: Partial<OrchestratorState>): boolean {
  const result = state?.beadResults?.[bead.id];
  if (result?.status === "success") return true;
  const text = `${bead.description ?? ""}`.toLowerCase();
  return /verified:|validation:|npm run build passed|npm test passed/.test(text);
}

function explicitSupersededBy(text: string): string | null {
  return text.match(/\bsuperseded\s+by\s+([a-z][a-z0-9]*-[a-z0-9]+)/i)?.[1] ?? null;
}

function findNewerDuplicate(bead: Bead, candidates: Array<Bead | WorkTodo>): Bead | WorkTodo | null {
  const title = normalizeTitle(bead.title);
  const beadTime = timestampMs(bead.updated_at ?? bead.created_at);
  if (!title || !beadTime) return null;
  return candidates.find((candidate) => {
    if (candidate.id === bead.id) return false;
    if (normalizeTitle(candidate.title) !== title) return false;
    return timestampMs(candidate.updated_at) > beadTime;
  }) ?? null;
}

export function buildWorkReconciliationReport(input: WorkReconciliationInput): WorkReconciliationReport {
  const now = input.now ?? new Date();
  const staleAfterHours = input.staleAfterHours ?? 12;
  const beads = input.beads;
  const readyIds = new Set((input.readyBeads ?? beads.filter((bead) => bead.status === "open")).map((bead) => bead.id));
  const todos = input.todos ?? [];
  const currentBeadId = input.state?.currentBeadId;

  const activeWork = beads
    .filter((bead) => bead.status === "in_progress")
    .map((bead) => item(bead.id, bead.title, bead.updated_at ? `updated ${bead.updated_at}` : undefined));

  const readyWork = beads
    .filter((bead) => readyIds.has(bead.id) && bead.status === "open")
    .map((bead) => item(bead.id, bead.title));

  const blockedWork = beads
    .filter((bead) => bead.status === "deferred" || (bead.status === "open" && !readyIds.has(bead.id)))
    .map((bead) => item(bead.id, bead.title, bead.status === "deferred" ? "deferred" : "not currently ready"));

  const closedButUnproven = beads
    .filter((bead) => bead.status === "closed" && !hasProof(bead, input.state))
    .map((bead) => item(bead.id, bead.title, "closed without matching state evidence"));

  const supersededCandidates: Array<Bead | WorkTodo> = [...beads, ...todos];
  const staleOrSuperseded: WorkReconciliationItem[] = [];
  for (const bead of beads.filter((candidate) => candidate.status === "open" || candidate.status === "in_progress")) {
    const age = ageHours(bead.updated_at ?? bead.created_at, now);
    if (bead.status === "in_progress" && age !== null && age >= staleAfterHours) {
      staleOrSuperseded.push(item(bead.id, bead.title, `in progress for ${Math.round(age)}h`));
      continue;
    }
    const explicit = explicitSupersededBy(bead.description ?? "");
    if (explicit) {
      staleOrSuperseded.push(item(bead.id, bead.title, `superseded by ${explicit}`));
      continue;
    }
    const newer = findNewerDuplicate(bead, supersededCandidates);
    if (newer) {
      staleOrSuperseded.push(item(bead.id, bead.title, `similar newer item ${newer.id}`));
    }
  }

  const assignedToOtherSession = beads
    .filter((bead) => bead.status === "in_progress" && currentBeadId && bead.id !== currentBeadId)
    .map((bead) => item(bead.id, bead.title, `current session is focused on ${currentBeadId}`));

  const next = readyWork[0] ?? activeWork[0] ?? blockedWork[0];

  return {
    ...(input.stage ? { stage: input.stage } : {}),
    activeWork,
    readyWork,
    blockedWork,
    closedButUnproven,
    staleOrSuperseded,
    assignedToOtherSession,
    ...(next ? { nextRecommended: next } : {}),
    todoCount: todos.length,
  };
}

function formatItems(items: WorkReconciliationItem[], empty: string): string {
  if (items.length === 0) return `- ${empty}`;
  return items.slice(0, 8).map((entry) => `- ${entry.id}: ${entry.title}${entry.reason ? ` (${entry.reason})` : ""}`).join("\n");
}

export function formatWorkReconciliationReport(report: WorkReconciliationReport): string {
  const next = report.nextRecommended
    ? `${report.nextRecommended.id}: ${report.nextRecommended.title}`
    : "none";
  return [
    "## Active Work Ledger",
    ...(report.stage ? [`Session stage: ${report.stage.label} (${report.stage.phase})`, `Stage next action: ${report.stage.nextAction}`] : []),
    `Next recommended: ${next}`,
    `Todo files read: ${report.todoCount}`,
    "",
    "### Active work",
    formatItems(report.activeWork, "none"),
    "",
    "### Ready work",
    formatItems(report.readyWork, "none"),
    "",
    "### Blocked work",
    formatItems(report.blockedWork, "none"),
    "",
    "### Closed but unproven",
    formatItems(report.closedButUnproven, "none"),
    "",
    "### Stale or superseded candidates",
    formatItems(report.staleOrSuperseded, "none"),
    "",
    "### Assigned to other session",
    formatItems(report.assignedToOtherSession, "none"),
  ].join("\n");
}

function parseTodoStatus(value: unknown): WorkTodo["status"] {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text === "done" || text === "closed" || text === "complete" || text === "completed") return "closed";
  if (text === "in_progress" || text === "in-progress" || text === "active") return "in_progress";
  if (text === "blocked" || text === "deferred") return "deferred";
  return "open";
}

function todoFromRecord(value: unknown, source: string, index: number): WorkTodo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : typeof record.text === "string" ? record.text : undefined;
  if (!title) return null;
  const id = typeof record.id === "string" ? record.id : `${source}#${index + 1}`;
  const updated = typeof record.updated_at === "string" ? record.updated_at : typeof record.updatedAt === "string" ? record.updatedAt : undefined;
  return {
    id,
    title,
    status: parseTodoStatus(record.status),
    source,
    ...(updated ? { updated_at: updated } : {}),
  };
}

function parseTodoJson(path: string, source: string): WorkTodo[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const rawItems: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.todos)
      ? parsed.todos
      : Array.isArray(parsed.items)
      ? parsed.items
      : [];
    return rawItems.flatMap((entry, index) => {
      const todo = todoFromRecord(entry, source, index);
      return todo ? [todo] : [];
    });
  } catch {
    return [];
  }
}

function parseTodoMarkdown(path: string, source: string): WorkTodo[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .flatMap((line, index) => {
        const match = line.match(/^\s*[-*]\s+\[( |x|-)\]\s+(.+?)\s*$/i);
        if (!match) return [];
        return [{
          id: `${source}#${index + 1}`,
          title: match[2].trim(),
          status: match[1].toLowerCase() === "x" ? "closed" : match[1] === "-" ? "deferred" : "open",
          source,
        } satisfies WorkTodo];
      });
  } catch {
    return [];
  }
}

export function readPiTodoFiles(cwd: string): WorkTodo[] {
  const candidates: string[] = [];
  const piDir = join(cwd, ".pi");
  for (const file of ["todos.json", "todo.json", "todos.md", "todo.md"]) {
    candidates.push(join(piDir, file));
  }
  const todosDir = join(piDir, "todos");
  if (existsSync(todosDir) && statSync(todosDir).isDirectory()) {
    for (const file of readdirSync(todosDir)) {
      if (file.endsWith(".json") || file.endsWith(".md")) candidates.push(join(todosDir, file));
    }
  }

  return candidates.flatMap((path) => {
    if (!existsSync(path) || !statSync(path).isFile()) return [];
    const source = path.slice(cwd.length + 1);
    return path.endsWith(".json") ? parseTodoJson(path, source) : parseTodoMarkdown(path, source);
  });
}
