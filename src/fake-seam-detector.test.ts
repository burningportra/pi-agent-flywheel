import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectFakeSeamsInText,
  formatFakeSeamReport,
  isProductionPathForFakeSeamScan,
  scanFakeSeamsInFiles,
} from "./fake-seam-detector.js";

describe("fake seam detector", () => {
  it("flags high-confidence fake/test seam references in production files", () => {
    const findings = detectFakeSeamsInText("src/runtime/composition.ts", [
      "const layer = layerMemory;",
      "const adapter = new InMemoryDatabase();",
      "throw new Error('not implemented');",
    ].join("\n"));

    expect(findings.map((finding) => finding.matchedTerm)).toEqual(["layerMemory", "InMemory", "not implemented"]);
    expect(findings[0]).toMatchObject({
      filePath: "src/runtime/composition.ts",
      line: 1,
      severity: "high",
    });
  });

  it("excludes test files, fixtures, and explicit test helpers", () => {
    for (const filePath of [
      "src/runtime/composition.test.ts",
      "src/__tests__/composition.ts",
      "tests/fixtures/composition.ts",
      "src/runtime/test-helper.ts",
      "src/runtime/mock-adapter.ts",
    ]) {
      expect(isProductionPathForFakeSeamScan(filePath)).toBe(false);
      expect(detectFakeSeamsInText(filePath, "const layer = layerMemory;")).toEqual([]);
    }
  });

  it("scans existing files and reports path, line, matched term, and reason", () => {
    const root = mkdtempSync(join(tmpdir(), "fake-seam-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "prod.ts"), "export const adapter = fakeAdapter;\n");
      writeFileSync(join(root, "src", "prod.test.ts"), "export const adapter = fakeAdapter;\n");

      const findings = scanFakeSeamsInFiles(root, ["src/prod.ts", "src/prod.test.ts"]);
      expect(findings).toHaveLength(1);
      expect(findings[0].filePath).toBe("src/prod.ts");
      expect(findings[0].line).toBe(1);
      expect(findings[0].matchedTerm).toBe("fake");
      expect(findings[0].reason).toContain("fake implementation");

      const report = formatFakeSeamReport(findings);
      expect(report).toContain("src/prod.ts:1");
      expect(report).toContain("matched \"fake\"");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("review flow blocks completion unless fake seam findings are explicitly overridden", () => {
    const reviewSource = readFileSync(new URL("./tools/review.ts", import.meta.url), "utf8");
    expect(reviewSource).toContain("scanFakeSeamsInFiles");
    expect(reviewSource).toContain("Block completion and fix fake/test seams");
    expect(reviewSource).toContain("Override — references are intentional");
    expect(reviewSource).toContain("fakeSeamBlocked");
  });
});
