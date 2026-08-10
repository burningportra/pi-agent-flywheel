import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import type { OrchestratorPhase } from "./types.js";

// ─── Types ───────────────────────────────────────────────────

export interface InstalledSkill {
  /** Skill name from frontmatter (e.g. "ui-craft") */
  name: string;
  /** Full description from frontmatter */
  description: string;
  /** Filesystem path to the SKILL.md */
  path: string;
  /** Directory containing the skill */
  directory: string;
  /** Source location category */
  source: "global-pi" | "global-agents" | "project-local" | "global-claude" | "global-codex";
}

export interface SkillPhaseMapping {
  skill: InstalledSkill;
  /** Which flywheel phases this skill is relevant to */
  phases: OrchestratorPhase[];
  /** Relevance score 0-1 for each phase */
  phaseScores: Partial<Record<OrchestratorPhase, number>>;
}

export interface BeadSkillRecommendation {
  beadLocalId: string;
  recommendedSkills: Array<{
    skill: InstalledSkill;
    relevance: number; // 0-1
    reason: string;
  }>;
}

// ─── Phase Keyword Maps ──────────────────────────────────────

/**
 * Keywords that indicate a skill is relevant to each flywheel phase.
 * Higher weight = stronger signal.
 */
const PHASE_KEYWORDS: Record<OrchestratorPhase, Array<{ keyword: string; weight: number }>> = {
  profiling: [
    { keyword: "codebase", weight: 0.9 },
    { keyword: "audit", weight: 0.8 },
    { keyword: "architecture", weight: 0.8 },
    { keyword: "scan", weight: 0.7 },
    { keyword: "profile", weight: 0.7 },
    { keyword: "unfamiliar", weight: 0.7 },
    { keyword: "structure", weight: 0.6 },
    { keyword: "knowledge graph", weight: 0.8 },
    { keyword: "file relationships", weight: 0.7 },
    { keyword: "onboarding", weight: 0.6 },
    { keyword: "context", weight: 0.4 },
    { keyword: "discover", weight: 0.5 },
    { keyword: "explore", weight: 0.5 },
    { keyword: "accessibility", weight: 0.5 },
    { keyword: "performance", weight: 0.5 },
    { keyword: "quality", weight: 0.4 },
    { keyword: "anti-pattern", weight: 0.5 },
    { keyword: "a11y", weight: 0.5 },
  ],
  discovering: [
    { keyword: "idea", weight: 0.9 },
    { keyword: "brainstorm", weight: 0.9 },
    { keyword: "improvement", weight: 0.8 },
    { keyword: "critique", weight: 0.7 },
    { keyword: "evaluate", weight: 0.7 },
    { keyword: "design lens", weight: 0.6 },
    { keyword: "assess", weight: 0.6 },
    { keyword: "reality check", weight: 0.8 },
    { keyword: "competing", weight: 0.7 },
    { keyword: "adversarial", weight: 0.6 },
    { keyword: "discover", weight: 0.5 },
    { keyword: "innovation", weight: 0.5 },
    { keyword: "gap analysis", weight: 0.5 },
    { keyword: "project status", weight: 0.7 },
  ],
  awaiting_selection: [
    // Selection is human-driven; skills rarely apply
  ],
  planning: [
    { keyword: "plan", weight: 0.9 },
    { keyword: "planning", weight: 0.9 },
    { keyword: "architecture", weight: 0.7 },
    { keyword: "design", weight: 0.5 },
    { keyword: "structure", weight: 0.6 },
    { keyword: "break down", weight: 0.8 },
    { keyword: "implementation plan", weight: 0.8 },
    { keyword: "grill", weight: 0.7 },
    { keyword: "stress-test", weight: 0.7 },
  ],
  researching: [
    { keyword: "research", weight: 0.9 },
    { keyword: "investigate", weight: 0.8 },
    { keyword: "analyze", weight: 0.7 },
    { keyword: "codebase", weight: 0.6 },
    { keyword: "source", weight: 0.6 },
    { keyword: "external", weight: 0.5 },
  ],
  awaiting_plan_approval: [
    // Approval is human-driven; skills rarely apply
  ],
  creating_beads: [
    { keyword: "plan", weight: 0.9 },
    { keyword: "planning", weight: 0.9 },
    { keyword: "break down", weight: 0.8 },
    { keyword: "task", weight: 0.6 },
    { keyword: "dependency", weight: 0.7 },
    { keyword: "bead", weight: 0.8 },
    { keyword: "implementation plan", weight: 0.8 },
    { keyword: "grill", weight: 0.7 },
    { keyword: "stress-test", weight: 0.7 },
    { keyword: "decision", weight: 0.6 },
    { keyword: "domain model", weight: 0.7 },
    { keyword: "terminology", weight: 0.6 },
    { keyword: "glossary", weight: 0.7 },
    { keyword: "specification", weight: 0.6 },
    { keyword: "interview", weight: 0.5 },
    { keyword: "test-driven", weight: 0.6 },
    { keyword: "TDD", weight: 0.6 },
    { keyword: "PRD", weight: 0.5 },
  ],
  implementing: [
    { keyword: "implement", weight: 0.5 },
    { keyword: "UI design", weight: 0.8 },
    { keyword: "frontend", weight: 0.8 },
    { keyword: "interface", weight: 0.7 },
    { keyword: "component", weight: 0.7 },
    { keyword: "refactor", weight: 0.8 },
    { keyword: "simplify", weight: 0.7 },
    { keyword: "test-driven", weight: 0.8 },
    { keyword: "TDD", weight: 0.8 },
    { keyword: "write tests", weight: 0.7 },
    { keyword: "error handling", weight: 0.7 },
    { keyword: "edge case", weight: 0.7 },
    { keyword: "production-ready", weight: 0.7 },
    { keyword: "harden", weight: 0.6 },
    { keyword: "design system", weight: 0.7 },
    { keyword: "reusable", weight: 0.6 },
    { keyword: "tokens", weight: 0.6 },
    { keyword: "layout", weight: 0.6 },
    { keyword: "typography", weight: 0.6 },
    { keyword: "animation", weight: 0.6 },
    { keyword: "color", weight: 0.5 },
    { keyword: "readme", weight: 0.5 },
    { keyword: "changelog", weight: 0.5 },
    { keyword: "documentation", weight: 0.5 },
    { keyword: "logging", weight: 0.7 },
    { keyword: "pre-commit", weight: 0.5 },
    { keyword: "CI/CD", weight: 0.5 },
    { keyword: "dependencies", weight: 0.5 },
    { keyword: "responsive", weight: 0.6 },
    { keyword: "polish", weight: 0.5 },
  ],
  reviewing: [
    { keyword: "review", weight: 0.7 },
    { keyword: "audit", weight: 0.8 },
    { keyword: "critique", weight: 0.8 },
    { keyword: "quality", weight: 0.7 },
    { keyword: "polish", weight: 0.8 },
    { keyword: "verify", weight: 0.7 },
    { keyword: "compliance", weight: 0.7 },
    { keyword: "check", weight: 0.5 },
    { keyword: "inspect", weight: 0.5 },
    { keyword: "bug", weight: 0.7 },
    { keyword: "debug", weight: 0.6 },
    { keyword: "diagnose", weight: 0.7 },
    { keyword: "performance", weight: 0.7 },
    { keyword: "optimize", weight: 0.7 },
    { keyword: "profile", weight: 0.6 },
    { keyword: "hotspot", weight: 0.5 },
    { keyword: "consistency", weight: 0.6 },
    { keyword: "design system", weight: 0.5 },
    { keyword: "alignment", weight: 0.5 },
    { keyword: "simplify", weight: 0.5 },
    { keyword: "distill", weight: 0.5 },
    { keyword: "fuzz", weight: 0.7 },
    { keyword: "testing", weight: 0.6 },
    { keyword: "test", weight: 0.4 },
    { keyword: "slop", weight: 0.5 },
    { keyword: "unsafe", weight: 0.6 },
    { keyword: "concurrency", weight: 0.5 },
    { keyword: "deadlock", weight: 0.5 },
    { keyword: "race", weight: 0.5 },
    { keyword: "accessibility", weight: 0.6 },
    { keyword: "a11y", weight: 0.6 },
  ],
  refining_beads: [
    { keyword: "refine", weight: 0.8 },
    { keyword: "improve", weight: 0.7 },
    { keyword: "polish", weight: 0.7 },
    { keyword: "plan", weight: 0.5 },
    { keyword: "bead", weight: 0.6 },
  ],
  awaiting_bead_approval: [
    // Approval is human-driven; skills rarely apply
  ],
  iterating: [
    { keyword: "fix", weight: 0.7 },
    { keyword: "debug", weight: 0.7 },
    { keyword: "diagnose", weight: 0.7 },
    { keyword: "refine", weight: 0.5 },
    { keyword: "iterate", weight: 0.5 },
    { keyword: "revision", weight: 0.5 },
    { keyword: "polish", weight: 0.4 },
  ],
  complete: [
    // Terminal state; no skills needed
  ],
  idle: [
    // Initial state; no skills needed
  ],
};

// ─── Skill Discovery ─────────────────────────────────────────

function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !descMatch) return null;

  const name = nameMatch[1].trim();
  // Description may span multiple lines (YAML folded style with >)
  let description = descMatch[1].trim();
  // Handle multi-line descriptions (indented continuation)
  const descLines = fm.split("\n");
  const descStartIdx = descLines.findIndex((l) => /^description:/.test(l));
  if (descStartIdx >= 0) {
    const parts: string[] = [descLines[descStartIdx].replace(/^description:\s*/, "").trim()];
    for (let i = descStartIdx + 1; i < descLines.length; i++) {
      const line = descLines[i];
      if (/^\w+:/.test(line)) break; // Next frontmatter key
      const trimmed = line.trim();
      if (trimmed) parts.push(trimmed);
    }
    description = parts.join(" ").replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
  }

  return { name, description };
}

function discoverSkillsInDir(
  dir: string,
  source: InstalledSkill["source"]
): InstalledSkill[] {
  const skills: InstalledSkill[] = [];
  if (!existsSync(dir)) return skills;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Handle symlinks
      let resolvedPath: string;
      try {
        resolvedPath = entry.isSymbolicLink()
          ? resolve(dir, entry.name)
          : join(dir, entry.name);
      } catch {
        continue;
      }

      if (entry.isDirectory() || (entry.isSymbolicLink() && existsSync(resolvedPath))) {
        // Check for SKILL.md in directory
        const skillMdPath = join(resolvedPath, "SKILL.md");
        if (existsSync(skillMdPath)) {
          try {
            const content = readFileSync(skillMdPath, "utf-8");
            const parsed = parseSkillFrontmatter(content);
            if (parsed) {
              skills.push({
                name: parsed.name,
                description: parsed.description,
                path: skillMdPath,
                directory: resolvedPath,
                source,
              });
            }
          } catch {
            // Skip unreadable skills
          }
        }
      } else if (entry.isFile() && entry.name.endsWith(".md") && source === "global-pi") {
        // Direct .md files in ~/.pi/agent/skills/ are treated as skills
        try {
          const content = readFileSync(join(dir, entry.name), "utf-8");
          const parsed = parseSkillFrontmatter(content);
          if (parsed) {
            skills.push({
              name: parsed.name,
              description: parsed.description,
              path: join(dir, entry.name),
              directory: dir,
              source,
            });
          }
        } catch {
          // Skip unreadable skills
        }
      }
    }
  } catch {
    // Skip inaccessible directories
  }

  return skills;
}

function discoverAllSkills(cwd?: string): InstalledSkill[] {
  const home = homedir();
  const allSkills: InstalledSkill[] = [];

  // Global Pi skills
  allSkills.push(...discoverSkillsInDir(join(home, ".pi", "agent", "skills"), "global-pi"));

  // Global Agents skills (~/.agents/skills)
  allSkills.push(...discoverSkillsInDir(join(home, ".agents", "skills"), "global-agents"));

  // Global Claude skills (~/.claude/skills)
  allSkills.push(...discoverSkillsInDir(join(home, ".claude", "skills"), "global-claude"));

  // Global Codex skills (~/.codex/skills)
  allSkills.push(...discoverSkillsInDir(join(home, ".codex", "skills"), "global-codex"));

  // Project-local skills
  if (cwd) {
    allSkills.push(...discoverSkillsInDir(join(cwd, ".pi", "skills"), "project-local"));
    allSkills.push(...discoverSkillsInDir(join(cwd, ".agents", "skills"), "project-local"));
  }

  // Deduplicate by name (first found wins, global-pi > global-agents > global-claude > global-codex > project-local)
  const seen = new Set<string>();
  const deduped: InstalledSkill[] = [];
  for (const skill of allSkills) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      deduped.push(skill);
    }
  }

  return deduped;
}

// ─── Phase Categorization ────────────────────────────────────

function scoreSkillForPhase(skill: InstalledSkill, phase: OrchestratorPhase): number {
  const keywords = PHASE_KEYWORDS[phase];
  if (!keywords || keywords.length === 0) return 0;

  const descLower = skill.description.toLowerCase();
  const nameLower = skill.name.toLowerCase();

  let totalWeight = 0;
  let matchedWeight = 0;

  for (const { keyword, weight } of keywords) {
    totalWeight += weight;
    const kwLower = keyword.toLowerCase();
    // Check description
    if (descLower.includes(kwLower)) {
      matchedWeight += weight;
    }
    // Also check skill name for stronger signal
    if (nameLower.includes(kwLower)) {
      matchedWeight += weight * 0.5; // Bonus for name match
    }
  }

  if (totalWeight === 0) return 0;
  return Math.min(matchedWeight / totalWeight, 1.0);
}

function categorizeSkills(skills: InstalledSkill[]): SkillPhaseMapping[] {
  const allPhases: OrchestratorPhase[] = [
    "profiling",
    "discovering",
    "planning",
    "researching",
    "creating_beads",
    "refining_beads",
    "implementing",
    "reviewing",
    "iterating",
  ];

  return skills.map((skill) => {
    const phaseScores: Partial<Record<OrchestratorPhase, number>> = {};
    const phases: OrchestratorPhase[] = [];

    for (const phase of allPhases) {
      const score = scoreSkillForPhase(skill, phase);
      if (score > 0.15) {
        // Minimum relevance threshold
        phaseScores[phase] = score;
        phases.push(phase);
      }
    }

    // Sort phases by score descending
    phases.sort((a, b) => (phaseScores[b] ?? 0) - (phaseScores[a] ?? 0));

    return { skill, phases, phaseScores };
  });
}

// ─── Bead Recommendation ─────────────────────────────────────

function scoreSkillForBead(
  skill: InstalledSkill,
  beadDescription: string,
  beadFiles: string[]
): { score: number; reasons: string[] } {
  const descLower = beadDescription.toLowerCase();
  const filesLower = beadFiles.join(" ").toLowerCase();
  const skillDescLower = skill.description.toLowerCase();
  const reasons: string[] = [];

  // Split skill description into key phrases
  const skillPhrases = skillDescLower
    .split(/[.,;]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 10);

  let totalScore = 0;

  for (const phrase of skillPhrases) {
    // Extract meaningful words (3+ chars)
    const words = phrase.split(/\s+/).filter((w) => w.length > 3);
    if (words.length === 0) continue;

    // Check if multiple words appear in bead description
    let matchCount = 0;
    for (const word of words) {
      if (descLower.includes(word)) matchCount++;
    }
    const descScore = words.length > 0 ? matchCount / words.length : 0;

    // Check file relevance
    let fileScore = 0;
    for (const word of words) {
      if (filesLower.includes(word)) fileScore += 0.5;
    }
    fileScore = Math.min(fileScore / words.length, 0.5);

    const phraseScore = descScore * 0.7 + fileScore * 0.3;
    if (phraseScore > 0.3) {
      totalScore += phraseScore;
      if (phraseScore > 0.6) {
        reasons.push(`Skill "${skill.name}" matches bead context: "${phrase.slice(0, 60)}"`);
      }
    }
  }

  // Boost for specific known patterns
  const patterns: Array<{ regex: RegExp; skillNames: string[]; reason: string }> = [
    { regex: /ui|component|frontend|interface|design|layout|style|css|tailwind/i, skillNames: ["ui-craft", "frontend-design"], reason: "UI/design work detected" },
    { regex: /test|spec|coverage|assert/i, skillNames: ["tdd"], reason: "Testing work detected" },
    { regex: /refactor|simplify|clean|extract|consolidate/i, skillNames: ["simplify-and-refactor-code-isomorphically", "extract"], reason: "Refactoring work detected" },
    { regex: /api|endpoint|route|handler|controller/i, skillNames: ["harden", "logging-best-practices"], reason: "API work detected" },
    { regex: /error|edge.case|validation|fallback|empty.state|loading/i, skillNames: ["harden"], reason: "Error handling / edge case work detected" },
    { regex: /performance|optimize|slow|fast|latency/i, skillNames: ["optimize", "profiling-software-performance"], reason: "Performance work detected" },
    { regex: /docs|documentation|readme|changelog/i, skillNames: ["readme-writing", "changelog-md-workmanship", "de-slopify"], reason: "Documentation work detected" },
    { regex: /type|interface|generic|typesafe/i, skillNames: ["tdd"], reason: "TypeScript type work detected" },
    { regex: /debug|fix|bug|broken|issue/i, skillNames: ["diagnose"], reason: "Bug fixing / debugging detected" },
    { regex: /log|logging|telemetry|observ/i, skillNames: ["logging-best-practices"], reason: "Logging/observability work detected" },
    { regex: /audit|review|quality|compliance/i, skillNames: ["audit", "beads-compliance-and-completion-verification"], reason: "Audit/review work detected" },
  ];

  for (const { regex, skillNames, reason } of patterns) {
    if (regex.test(descLower) && skillNames.includes(skill.name)) {
      totalScore += 0.4;
      reasons.push(reason);
    }
  }

  return { score: Math.min(totalScore / 3, 1.0), reasons };
}

// ─── Cache ───────────────────────────────────────────────────

let _cachedSkills: InstalledSkill[] | null = null;
let _cachedMappings: SkillPhaseMapping[] | null = null;
let _cachedCwd: string | undefined;

function getCachedSkills(cwd?: string): InstalledSkill[] {
  if (!_cachedSkills || _cachedCwd !== cwd) {
    _cachedSkills = discoverAllSkills(cwd);
    _cachedMappings = categorizeSkills(_cachedSkills);
    _cachedCwd = cwd;
  }
  return _cachedSkills;
}

function getCachedMappings(cwd?: string): SkillPhaseMapping[] {
  getCachedSkills(cwd); // Ensures cache is populated
  return _cachedMappings!;
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Get all installed skills categorized by flywheel phase.
 * Results are cached for the session.
 */
export function getSkillsByPhase(cwd?: string): SkillPhaseMapping[] {
  return getCachedMappings(cwd);
}

/**
 * Get skills relevant to a specific flywheel phase, sorted by relevance.
 */
export function getSkillsForPhase(
  phase: OrchestratorPhase,
  cwd?: string,
  limit = 10
): SkillPhaseMapping[] {
  const mappings = getCachedMappings(cwd);
  return mappings
    .filter((m) => m.phases.includes(phase))
    .sort((a, b) => (b.phaseScores[phase] ?? 0) - (a.phaseScores[phase] ?? 0))
    .slice(0, limit);
}

/**
 * Recommend skills for a specific bead based on its description and files.
 */
export function recommendSkillsForBead(
  beadDescription: string,
  beadFiles: string[],
  cwd?: string,
  limit = 5
): Array<{ skill: InstalledSkill; relevance: number; reason: string }> {
  const skills = getCachedSkills(cwd);
  const scored = skills
    .map((skill) => {
      const { score, reasons } = scoreSkillForBead(skill, beadDescription, beadFiles);
      return { skill, relevance: score, reason: reasons.join("; ") || "General relevance" };
    })
    .filter((s) => s.relevance > 0.2)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);

  return scored;
}

/**
 * Format skills for inclusion in a prompt, with phase context.
 */
export function formatSkillsForPrompt(
  phase: OrchestratorPhase,
  cwd?: string,
  limit = 10
): string {
  const skills = getSkillsForPhase(phase, cwd, limit);
  if (skills.length === 0) return "";

  const lines = skills.map((m) => {
    const score = m.phaseScores[phase] ?? 0;
    const stars = score > 0.6 ? "★★★" : score > 0.4 ? "★★" : "★";
    // Truncate description to keep prompt compact
    const shortDesc =
      m.skill.description.length > 120
        ? m.skill.description.slice(0, 117) + "..."
        : m.skill.description;
    return `- \`${m.skill.name}\` ${stars} — ${shortDesc}`;
  });

  return `### Available Skills for This Phase
The following skills are installed and available. Use \`read\` to load a skill's full instructions before applying it.

${lines.join("\n")}

**Usage:** When a skill matches the work, read its SKILL.md with \`read\` and follow its methodology. Skills provide specialized workflows, scripts, and reference docs.`;
}

/**
 * Format bead-specific skill recommendations for inclusion in implementation prompt.
 */
export function formatBeadSkillRecommendations(
  beadDescription: string,
  beadFiles: string[],
  cwd?: string,
  limit = 5
): string {
  const recs = recommendSkillsForBead(beadDescription, beadFiles, cwd, limit);
  if (recs.length === 0) return "";

  const lines = recs.map((r) => {
    const pct = Math.round(r.relevance * 100);
    return `- \`${r.skill.name}\` (${pct}% match) — ${r.reason}`;
  });

  return `### Recommended Skills for This Bead
Based on the bead description, these installed skills may be helpful:

${lines.join("\n")}

Load a skill with \`read\` to get its full workflow before starting. Skills provide battle-tested methodologies that improve quality and consistency.`;
}

/**
 * Format a compact skill reference block for the orchestrator system prompt.
 * This is a lightweight list of skill names + one-line descriptions.
 */
export function formatSkillInventory(cwd?: string, maxSkills = 20): string {
  const skills = getCachedSkills(cwd);
  if (skills.length === 0) return "";

  // Prioritize the most relevant/well-known skills
  const prioritized = skills
    .sort((a, b) => {
      // Prioritize craft/design skills and testing skills
      const aPriority = getSkillPriority(a.name);
      const bPriority = getSkillPriority(b.name);
      return bPriority - aPriority;
    })
    .slice(0, maxSkills);

  const lines = prioritized.map((s) => {
    const shortDesc =
      s.description.length > 100
        ? s.description.slice(0, 97) + "..."
        : s.description;
    return `- \`${s.name}\` — ${shortDesc}`;
  });

  return `### Installed Skills Inventory
${lines.join("\n")}

Skills provide specialized workflows. Use \`read\` to load a skill before applying it. Skills are progressive disclosure — only descriptions are in context until loaded.`;
}

/**
 * Priority score for sorting skills in the inventory.
 * Known high-value skills get boosted.
 */
function getSkillPriority(name: string): number {
  const HIGH_PRIORITY = new Set([
    "tdd",
    "ui-craft",
    "frontend-design",
    "simplify-and-refactor-code-isomorphically",
    "harden",
    "diagnose",
    "audit",
    "polish",
    "codebase-audit",
    "codebase-archaeology",
    "planning-workflow",
    "beads-workflow",
    "beads-compliance-and-completion-verification",
    "optimize",
    "logging-best-practices",
    "extract",
    "critique",
  ]);

  const MEDIUM_PRIORITY = new Set([
    "animate",
    "arrange",
    "typeset",
    "colorize",
    "delight",
    "distill",
    "normalize",
    "bolder",
    "quieter",
    "clarify",
    "onboard",
    "prototype",
    "overdrive",
    "de-slopify",
    "readme-writing",
    "changelog-md-workmanship",
    "setup-pre-commit",
    "gh-actions",
    "testing-fuzzing",
    "testing-metamorphic",
    "ubs",
    "profiling-software-performance",
    "extreme-software-optimization",
    "grill-me",
    "grill-with-docs",
    "ubiquitous-language",
    "the-interviewer",
    "reality-check-for-project",
    "idea-wizard",
    "library-updater",
    "git-repo-janitor",
    "graphify",
    "zoom-out",
  ]);

  if (HIGH_PRIORITY.has(name)) return 2;
  if (MEDIUM_PRIORITY.has(name)) return 1;
  return 0;
}

/**
 * Clear the skill cache. Call when skills may have changed (rare).
 */
export function clearSkillCache(): void {
  _cachedSkills = null;
  _cachedMappings = null;
  _cachedCwd = undefined;
}

/**
 * Get the total count of installed skills and a breakdown by source.
 */
export function getSkillStats(cwd?: string): {
  total: number;
  bySource: Record<string, number>;
  byPhase: Record<string, number>;
} {
  const skills = getCachedSkills(cwd);
  const mappings = getCachedMappings(cwd);

  const bySource: Record<string, number> = {};
  for (const s of skills) {
    bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  }

  const byPhase: Record<string, number> = {};
  for (const m of mappings) {
    for (const phase of m.phases) {
      byPhase[phase] = (byPhase[phase] ?? 0) + 1;
    }
  }

  return { total: skills.length, bySource, byPhase };
}

/**
 * Check if a specific skill is installed.
 */
export function isSkillInstalled(name: string, cwd?: string): boolean {
  const skills = getCachedSkills(cwd);
  return skills.some((s) => s.name === name);
}
