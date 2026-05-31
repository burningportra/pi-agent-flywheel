import { describe, expect, it } from "vitest";
import {
  formatReviewFeedbackBeadPlan,
  parseReviewFeedbackAnnotations,
  reviewFeedbackToMutationPlan,
} from "./review-feedback.js";

describe("parseReviewFeedbackAnnotations", () => {
  it("parses a file-level code review comment", () => {
    const parsed = parseReviewFeedbackAnnotations(`
Code Review Feedback

File: src/tools/review.ts
Feedback: This fail path loses actionable review feedback. Convert it into remediation beads.
`);

    expect(parsed).toEqual([
      expect.objectContaining({
        sourceKind: "code-review",
        filePath: "src/tools/review.ts",
        feedback: "This fail path loses actionable review feedback. Convert it into remediation beads.",
      }),
    ]);
  });

  it("parses a line-range comment with quoted code", () => {
    const parsed = parseReviewFeedbackAnnotations(`
Markdown Annotations

src/prompts.ts:42-47
\`\`\`ts
return "create beads manually";
\`\`\`
Comment: This should use the staged mutation workflow instead of raw br commands.
`);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      sourceKind: "markdown",
      filePath: "src/prompts.ts",
      lineStart: 42,
      lineEnd: 47,
      quotedText: "return \"create beads manually\";",
      feedback: "This should use the staged mutation workflow instead of raw br commands.",
    });
  });

  it("parses message annotation feedback without a file path", () => {
    const parsed = parseReviewFeedbackAnnotations(`
Message Annotations

Feedback: The handoff says all tests passed but only a focused test ran. Preserve exact verification output.
`);

    expect(parsed).toEqual([
      expect.objectContaining({
        sourceKind: "message",
        feedback: "The handoff says all tests passed but only a focused test ran. Preserve exact verification output.",
      }),
    ]);
    expect(parsed[0].filePath).toBeUndefined();
  });

  it("groups multiple comments for the same file into one staged bead", () => {
    const parsed = parseReviewFeedbackAnnotations(`
Code Review Feedback

File: src/beads.ts
Line 80
Feedback: The parser ignores dependency ordering.

File: src/beads.ts
Lines 120-124
Feedback: Preserve the original line comment in the generated bead.
`);
    const plan = reviewFeedbackToMutationPlan(parsed);

    expect(plan.beads).toHaveLength(1);
    expect(plan.beads[0]).toMatchObject({
      localId: "review-feedback-src-beads-ts",
      title: "Address review feedback in src/beads.ts",
      files: ["src/beads.ts"],
      verification: expect.objectContaining({
        commandsChecks: expect.stringContaining("npm run build"),
      }),
    });
    expect(plan.beads[0].description).toContain("src/beads.ts:80");
    expect(plan.beads[0].description).toContain("src/beads.ts:120-124");
    expect(plan.beads[0].description).toContain("## Rationale");
    expect(plan.beads[0].description).toContain("### Verification:");
    expect(plan.beads[0].description).toContain("### Files:");
  });
});

describe("reviewFeedbackToMutationPlan", () => {
  it("formats generated bead descriptions with original feedback and file scope", () => {
    const plan = reviewFeedbackToMutationPlan([
      {
        sourceKind: "code-review",
        filePath: "src/tools/review.ts",
        lineStart: 10,
        lineEnd: 12,
        feedback: "Add a review action that produces beads.",
      },
    ]);

    expect(plan).toMatchObject({
      dependencies: [],
      metadata: { source: "review-feedback-annotations", annotationCount: 1 },
    });
    expect(plan.beads[0].description).toContain("Add a review action that produces beads.");
    expect(plan.beads[0].description).toContain("- src/tools/review.ts");
  });

  it("preserves referenced beads and plan sections as ordering hints", () => {
    const plan = reviewFeedbackToMutationPlan([
      {
        sourceKind: "code-review",
        filePath: "src/review-feedback.ts",
        feedback: "This should depend on bead pi-yeh0 and match spec section \"Review remediation\".",
      },
    ]);

    expect(plan.beads[0].description).toContain("## Ordering and dependency hints");
    expect(plan.beads[0].description).toContain("bead pi-yeh0");
    expect(plan.beads[0].description).toContain("Review remediation");
    expect(plan.beads[0].metadata).toEqual({
      orderingHints: [
        "Preserve relationship to referenced bead pi-yeh0.",
        "Check ordering against referenced Review remediation section.",
      ],
    });
  });

  it("renders a copyable staged mutation plan summary", () => {
    const plan = reviewFeedbackToMutationPlan([
      {
        sourceKind: "message",
        feedback: "Create tracked remediation work from this annotation.",
      },
    ]);

    const formatted = formatReviewFeedbackBeadPlan(plan);
    expect(formatted).toContain("staged remediation bead");
    expect(formatted).toContain("```json");
    expect(formatted).toContain("review-feedback-create-tracked-remediation-work-from-this");
  });
});
