/**
 * Convert a stored goal into a compact, single-line UI preview.
 *
 * Refined goals are often stored as Markdown documents (for example
 * `## Goal\n...\n## Constraints`). Status widgets, restore logs, and menu labels
 * must never receive those raw newlines because they corrupt terminal row
 * accounting. This helper extracts the first meaningful goal sentence and
 * collapses whitespace for display-only use.
 */
export function goalPreviewText(goal: string | undefined | null, maxChars?: number): string {
  const raw = typeof goal === "string" ? goal : "";
  if (!raw.trim()) return "";

  const lines = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const goalHeadingIndex = lines.findIndex((line) => isGoalHeading(line));
  const candidate = goalHeadingIndex >= 0
    ? firstMeaningfulLine(lines.slice(goalHeadingIndex + 1)) || inlineGoalHeadingText(lines[goalHeadingIndex])
    : inlineGoalHeadingText(lines[0]) || firstMeaningfulLine(lines) || "";

  const singleLine = candidate.replace(/\s+/g, " ").trim();
  if (maxChars === undefined || maxChars <= 0 || singleLine.length <= maxChars) {
    return singleLine;
  }

  if (maxChars <= 3) return ".".repeat(maxChars);
  return `${singleLine.slice(0, maxChars - 3)}...`;
}

function isGoalHeading(line: string): boolean {
  return /^#{1,6}\s*goal\b/i.test(line) || /^goal\s*:?$/i.test(line);
}

function inlineGoalHeadingText(line: string): string {
  const match = line.match(/^#{1,6}\s*goal\b\s*[:—-]?\s*(.*)$/i)
    ?? line.match(/^goal\s*:\s*(.*)$/i);
  const text = match?.[1]?.trim() ?? "";
  return hasMeaningfulText(text) ? text : "";
}

function firstMeaningfulLine(lines: string[]): string {
  return lines.find((line) => hasMeaningfulText(line) && !/^#{1,6}\s+/.test(line)) ?? "";
}

function hasMeaningfulText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
