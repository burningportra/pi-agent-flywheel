import type { StagedBeadMutationPlan } from "./beads.js";

export type ReviewFeedbackSourceKind = "code-review" | "markdown" | "message" | "unknown";

export interface ReviewFeedbackAnnotation {
  sourceKind: ReviewFeedbackSourceKind;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  quotedText?: string;
  feedback: string;
}

const SOURCE_HEADINGS: Array<[RegExp, ReviewFeedbackSourceKind]> = [
  [/code review feedback/i, "code-review"],
  [/markdown annotations?/i, "markdown"],
  [/message annotations?/i, "message"],
];

const FILE_PATH_RE = /(?:^|[\s`"'(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w.-]*)(?::(\d+)(?:-(\d+))?)?/;
const LINE_RANGE_RE = /\bline(?:s)?\s+(\d+)(?:\s*[-:]\s*(\d+))?/i;

interface DraftAnnotation {
  sourceKind: ReviewFeedbackSourceKind;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  quotedLines: string[];
  feedbackLines: string[];
}

function startDraft(sourceKind: ReviewFeedbackSourceKind): DraftAnnotation {
  return { sourceKind, quotedLines: [], feedbackLines: [] };
}

function trimFence(line: string): string {
  return line.replace(/^```[A-Za-z0-9_-]*\s*$/, "").replace(/^```\s*$/, "");
}

function matchSourceHeading(line: string): ReviewFeedbackSourceKind | null {
  for (const [pattern, kind] of SOURCE_HEADINGS) {
    if (pattern.test(line)) return kind;
  }
  return null;
}

function matchFilePath(line: string): { filePath: string; lineStart?: number; lineEnd?: number } | null {
  const match = line.match(FILE_PATH_RE);
  if (!match) return null;
  const lineStart = match[2] ? Number.parseInt(match[2], 10) : undefined;
  const lineEnd = match[3] ? Number.parseInt(match[3], 10) : lineStart;
  return {
    filePath: match[1],
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
  };
}

function matchLineRange(line: string): { lineStart: number; lineEnd: number } | null {
  const match = line.match(LINE_RANGE_RE);
  if (!match) return null;
  const lineStart = Number.parseInt(match[1], 10);
  const lineEnd = match[2] ? Number.parseInt(match[2], 10) : lineStart;
  return { lineStart, lineEnd };
}

function cleanFeedbackLine(line: string): string {
  return line
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*(?:feedback|comment|review|message|note|human feedback)\s*:\s*/i, "")
    .trim();
}

function isFeedbackLabel(line: string): boolean {
  return /^\s*(?:feedback|comment|review|message|note|human feedback)\s*:/i.test(line);
}

function finalizeDraft(draft: DraftAnnotation): ReviewFeedbackAnnotation | null {
  const feedback = draft.feedbackLines
    .map(cleanFeedbackLine)
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!feedback) return null;
  const quotedText = draft.quotedLines.map((line) => line.trim()).filter(Boolean).join("\n").trim();
  return {
    sourceKind: draft.sourceKind,
    ...(draft.filePath ? { filePath: draft.filePath } : {}),
    ...(draft.lineStart !== undefined ? { lineStart: draft.lineStart } : {}),
    ...(draft.lineEnd !== undefined ? { lineEnd: draft.lineEnd } : {}),
    ...(quotedText ? { quotedText } : {}),
    feedback,
  };
}

function looksLikeAnnotationStart(line: string): boolean {
  return Boolean(matchFilePath(line)) || /^\s*(?:file|path)\s*:/i.test(line);
}

export function parseReviewFeedbackAnnotations(input: string): ReviewFeedbackAnnotation[] {
  const annotations: ReviewFeedbackAnnotation[] = [];
  let currentKind: ReviewFeedbackSourceKind = "unknown";
  let draft: DraftAnnotation | null = null;
  let inCodeFence = false;

  const flush = () => {
    if (!draft) return;
    const annotation = finalizeDraft(draft);
    if (annotation) annotations.push(annotation);
    draft = null;
  };

  for (const rawLine of input.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    const cleanLine = trimFence(line);
    if (line.trim().startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }

    const sourceHeading = matchSourceHeading(line);
    if (sourceHeading) {
      flush();
      currentKind = sourceHeading;
      continue;
    }

    const fileMatch = matchFilePath(line);
    if (fileMatch && (looksLikeAnnotationStart(line) || !draft?.filePath)) {
      if (draft && draft.feedbackLines.length > 0) flush();
      draft ??= startDraft(currentKind);
      draft.filePath = fileMatch.filePath;
      if (fileMatch.lineStart !== undefined) draft.lineStart = fileMatch.lineStart;
      if (fileMatch.lineEnd !== undefined) draft.lineEnd = fileMatch.lineEnd;
      const afterPath = line.slice(line.indexOf(fileMatch.filePath) + fileMatch.filePath.length).replace(/^:\d+(?:-\d+)?/, "").trim();
      if (afterPath && !/^[-:]*\s*$/.test(afterPath)) draft.feedbackLines.push(afterPath);
      continue;
    }

    const lineRange = matchLineRange(line);
    if (lineRange) {
      draft ??= startDraft(currentKind);
      draft.lineStart = lineRange.lineStart;
      draft.lineEnd = lineRange.lineEnd;
      const cleaned = cleanFeedbackLine(line.replace(LINE_RANGE_RE, ""));
      if (cleaned) draft.feedbackLines.push(cleaned);
      continue;
    }

    if (!draft && isFeedbackLabel(line)) {
      draft = startDraft(currentKind);
    }

    if (!draft) continue;
    if (inCodeFence || line.trim().startsWith(">")) {
      draft.quotedLines.push(line.replace(/^\s*>\s?/, ""));
      continue;
    }

    const cleaned = cleanFeedbackLine(cleanLine);
    if (cleaned) draft.feedbackLines.push(cleaned);
  }

  flush();
  return annotations;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/^-+|-+$/g, "");
  return slug || "review-feedback";
}

function titleForGroup(filePath: string | undefined, annotations: ReviewFeedbackAnnotation[]): string {
  if (filePath) return `Address review feedback in ${filePath}`;
  const kind = annotations[0]?.sourceKind === "message" ? "message annotations" : "review feedback";
  return `Address ${kind}`;
}

function locationLabel(annotation: ReviewFeedbackAnnotation): string {
  if (!annotation.filePath) return "Message annotation";
  if (annotation.lineStart === undefined) return annotation.filePath;
  if (annotation.lineEnd !== undefined && annotation.lineEnd !== annotation.lineStart) {
    return `${annotation.filePath}:${annotation.lineStart}-${annotation.lineEnd}`;
  }
  return `${annotation.filePath}:${annotation.lineStart}`;
}

function extractOrderingHints(annotations: ReviewFeedbackAnnotation[]): string[] {
  const hints = new Set<string>();
  const combined = annotations.map((annotation) => annotation.feedback).join("\n");
  for (const match of combined.matchAll(/\b(?:bead|todo|task)\s+([a-z][a-z0-9]*-[a-z0-9]+)\b/gi)) {
    hints.add(`Preserve relationship to referenced ${match[0]}.`);
  }
  for (const match of combined.matchAll(/\b(?:spec|plan)\s+(?:section\s+)?["'`]?([^"'`\n.;]+)["'`]?/gi)) {
    hints.add(`Check ordering against referenced ${match[1].trim()} section.`);
  }
  return Array.from(hints);
}

function descriptionForGroup(filePath: string | undefined, annotations: ReviewFeedbackAnnotation[]): string {
  const feedbackLines = annotations.map((annotation, index) => {
    const quoted = annotation.quotedText ? `\n  Quoted code:\n  ${annotation.quotedText.split("\n").map((line) => `> ${line}`).join("\n  ")}` : "";
    return `${index + 1}. ${locationLabel(annotation)}\n   Feedback: ${annotation.feedback}${quoted}`;
  });

  const files = filePath ? [filePath] : ["Review message / pasted annotation"];
  const orderingHints = extractOrderingHints(annotations);
  const orderingSection = orderingHints.length
    ? `\n\n## Ordering and dependency hints\n${orderingHints.map((hint) => `- ${hint}`).join("\n")}`
    : "";
  return `## Context
Pasted review annotations identified actionable remediation work that should be tracked as a bead instead of handled ad hoc.

## Rationale
Review feedback is structured implementation scope. Tracking it as a bead prevents missed comments, preserves line references, and routes remediation through normal review and verification.

## Original feedback
${feedbackLines.join("\n\n")}${orderingSection}

## Acceptance criteria
- [ ] Address every listed review annotation for this ${filePath ? "file" : "message"}.
- [ ] Preserve the original feedback details and line references while implementing the fix.
- [ ] Add or update tests when the feedback changes behavior.

### Verification:
- Commands/checks: run the focused tests for the changed file and npm run build.
- Success looks like: the review feedback is resolved, relevant focused tests pass, and TypeScript compiles.
- Manual proof fallback: if automation cannot run, capture the exact blocker and manually inspect each listed annotation against the diff.

### Files:
${files.map((file) => `- ${file}`).join("\n")}`;
}

export function reviewFeedbackToMutationPlan(annotations: ReviewFeedbackAnnotation[]): StagedBeadMutationPlan {
  const groups = new Map<string, ReviewFeedbackAnnotation[]>();
  for (const annotation of annotations) {
    const key = annotation.filePath ?? "__message__";
    groups.set(key, [...(groups.get(key) ?? []), annotation]);
  }

  const beads = Array.from(groups.entries()).map(([key, group], index) => {
    const filePath = key === "__message__" ? undefined : key;
    const localId = `review-feedback-${slugify(filePath ?? group[0]?.feedback ?? String(index))}`;
    return {
      localId,
      title: titleForGroup(filePath, group),
      description: descriptionForGroup(filePath, group),
      type: "task",
      priority: 2,
      files: filePath ? [filePath] : ["Review message / pasted annotation"],
      verification: {
        commandsChecks: "run the focused tests for the changed file and npm run build",
        successLooksLike: "the review feedback is resolved, relevant focused tests pass, and TypeScript compiles",
        manualProofFallback: "if automation cannot run, capture the exact blocker and manually inspect each listed annotation against the diff",
      },
      metadata: { orderingHints: extractOrderingHints(group) },
    };
  });

  return {
    beads,
    dependencies: [],
    metadata: { source: "review-feedback-annotations", annotationCount: annotations.length },
  };
}

export function formatReviewFeedbackBeadPlan(plan: StagedBeadMutationPlan): string {
  if (plan.beads.length === 0) return "No review feedback annotations were detected.";
  const summary = plan.beads
    .map((bead) => `- ${bead.localId}: ${bead.title} (${bead.files.join(", ")})`)
    .join("\n");
  return `Detected review annotations and converted them into ${plan.beads.length} staged remediation bead(s):\n${summary}\n\nUse this JSON with the bead approval flow if the feedback should become tracked work:\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
}
