import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface FakeSeamFinding {
  filePath: string;
  line: number;
  matchedTerm: string;
  severity: "high";
  reason: string;
  lineText: string;
}

const SUSPICIOUS_TERMS: Array<{ term: string; pattern: RegExp; reason: string }> = [
  { term: "layerMemory", pattern: /\blayerMemory\b/i, reason: "production composition appears to use an in-memory layer" },
  { term: "InMemory", pattern: /\bInMemory\w*\b/i, reason: "production code appears to reference an in-memory adapter" },
  { term: "fake", pattern: /\bfake\w*\b/i, reason: "production code appears to reference a fake implementation" },
  { term: "mock", pattern: /\bmock\w*\b/i, reason: "production code appears to reference a mock implementation" },
  { term: "test adapter", pattern: /\btest\s+adapter\b/i, reason: "production code appears to reference a test adapter" },
  { term: "TODO fallback", pattern: /\bTODO\b.{0,80}\bfallback\b|\bfallback\b.{0,80}\bTODO\b/i, reason: "production code appears to retain a TODO fallback" },
  { term: "placeholder", pattern: /\bplaceholder\b/i, reason: "production code appears to contain placeholder wiring" },
  { term: "stub", pattern: /\bstub\b/i, reason: "production code appears to contain stub wiring" },
  { term: "not implemented", pattern: /\bnot implemented\b/i, reason: "production code appears to contain an unimplemented path" },
];

export function isProductionPathForFakeSeamScan(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(normalized)) return false;
  return !(
    /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?|testdata)(?:\/|$)/.test(normalized) ||
    /\.(?:test|spec|fixture)\.[cm]?[tj]sx?$/.test(normalized) ||
    /(?:test|mock|fixture)[-_]?(?:helper|adapter|utils?)\.[cm]?[tj]sx?$/.test(normalized)
  );
}

export function detectFakeSeamsInText(filePath: string, text: string): FakeSeamFinding[] {
  if (!isProductionPathForFakeSeamScan(filePath)) return [];
  const findings: FakeSeamFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    for (const term of SUSPICIOUS_TERMS) {
      if (term.pattern.test(lineText)) {
        findings.push({
          filePath,
          line: i + 1,
          matchedTerm: term.term,
          severity: "high",
          reason: term.reason,
          lineText: lineText.trim(),
        });
      }
    }
  }
  return findings;
}

export function scanFakeSeamsInFiles(cwd: string, filePaths: string[]): FakeSeamFinding[] {
  const findings: FakeSeamFinding[] = [];
  for (const filePath of filePaths) {
    if (!isProductionPathForFakeSeamScan(filePath)) continue;
    const resolved = join(cwd, filePath);
    if (!existsSync(resolved)) continue;
    findings.push(...detectFakeSeamsInText(filePath, readFileSync(resolved, "utf8")));
  }
  return findings;
}

export function formatFakeSeamReport(findings: FakeSeamFinding[]): string {
  if (findings.length === 0) return "";
  return [
    "⛔ Production fake/test seam detector found high-confidence matches:",
    ...findings.map((finding) =>
      `- ${finding.filePath}:${finding.line} matched "${finding.matchedTerm}" — ${finding.reason}. Line: ${finding.lineText}`
    ),
    "",
    "These can make verification pass while production wiring still uses fake, in-memory, mock, placeholder, stub, fallback, or not-implemented paths.",
  ].join("\n");
}
