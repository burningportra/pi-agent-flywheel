import type { BeadTemplate, ExpandTemplateResult } from "./types.js";

const BUILTIN_TEMPLATES: BeadTemplate[] = [
  {
    id: "add-api-endpoint",
    label: "Add API endpoint",
    summary: "Create a new endpoint with validation, error handling, and tests.",
    descriptionTemplate: `Implement a new API endpoint for {{endpointPath}} in the {{moduleName}} area. Add request validation, success/error responses, and any supporting wiring needed so the endpoint behaves consistently with the existing API surface.

Why this bead exists:
- The feature needs a concrete endpoint for {{endpointPurpose}}.
- The work should land with validation, error handling, and test coverage instead of a stub.

Acceptance criteria:
- [ ] Add the {{httpMethod}} {{endpointPath}} endpoint with validation for the expected inputs.
- [ ] Return clear success and failure responses for the main path and obvious edge cases.
- [ ] Add tests covering the happy path and at least one error path.

### Verification:
- Commands/checks: run npm test -- {{testFile}} and npm run build.
- Success looks like: endpoint tests cover the happy path and at least one invalid-input path, and build/type-check finishes without errors.
- Manual proof fallback: if commands cannot run, capture the exact blocker and manually inspect {{implementationFile}} and {{testFile}} for validation, success responses, error responses, and assertions.

### Recommended Skills:
- \`tdd\` — Write tests first, then implement. Ensures each acceptance criterion has a failing test before the code passes.
- \`harden\` — Add error handling, input validation, and edge-case coverage for production readiness.
- \`logging-best-practices\` — Add canonical log lines for debugging and observability.

### Files:
- {{implementationFile}}
- {{testFile}}`,
    recommendedSkills: ["tdd", "harden", "logging-best-practices"],
    placeholders: [
      { name: "endpointPath", description: "Route or RPC path to implement", example: "/users", required: true },
      { name: "moduleName", description: "Owning module or feature area", example: "user-management", required: true },
      { name: "endpointPurpose", description: "Why the endpoint is being added", example: "return a filtered user list", required: true },
      { name: "httpMethod", description: "HTTP method or action name", example: "GET", required: true },
      { name: "implementationFile", description: "Primary source file to edit or create", example: "src/api/users.ts", required: true },
      { name: "testFile", description: "Test file covering the endpoint", example: "src/api/users.test.ts", required: true },
    ],
    acceptanceCriteria: [
      "Add request validation and explicit error handling for invalid inputs.",
      "Implement the endpoint behavior in the named module without leaving TODO stubs.",
      "Cover the endpoint with automated tests for success and failure paths.",
    ],
    filePatterns: ["src/api/*.ts", "src/**/*.test.ts"],
    dependencyHints: "Other beads that depend on this endpoint should list it as a dependency. If test coverage is split into a separate bead, that bead depends on this one.",
    examples: [
      {
        description: `Implement a new API endpoint for /users in the user-management area. Add request validation, success/error responses, and any supporting wiring needed so the endpoint behaves consistently with the existing API surface.

Why this bead exists:
- The feature needs a concrete endpoint for return a filtered user list.
- The work should land with validation, error handling, and test coverage instead of a stub.

Acceptance criteria:
- [ ] Add the GET /users endpoint with validation for the expected inputs.
- [ ] Return clear success and failure responses for the main path and obvious edge cases.
- [ ] Add tests covering the happy path and at least one error path.

### Verification:
- Commands/checks: run npm test -- src/api/users.test.ts and npm run build.
- Success looks like: endpoint tests cover the happy path and at least one invalid-input path, and build/type-check finishes without errors.
- Manual proof fallback: if commands cannot run, capture the exact blocker and manually inspect src/api/users.ts and src/api/users.test.ts for validation, success responses, error responses, and assertions.

### Recommended Skills:
- \`tdd\` — Write tests first, then implement. Ensures each acceptance criterion has a failing test before the code passes.
- \`harden\` — Add error handling, input validation, and edge-case coverage for production readiness.
- \`logging-best-practices\` — Add canonical log lines for debugging and observability.

### Files:
- src/api/users.ts
- src/api/users.test.ts`,
      },
    ],
  },
  {
    id: "refactor-module",
    label: "Refactor module",
    summary: "Restructure an existing module while preserving behavior and tests.",
    descriptionTemplate: `Refactor the {{moduleName}} module to improve {{refactorGoal}} while preserving existing behavior. Reorganize the code, update any touched call sites, and keep the resulting structure easier for future agents to extend.

Why this bead exists:
- The current module has pain around {{currentPain}}.
- The refactor should reduce maintenance cost without changing outward behavior.

Acceptance criteria:
- [ ] Reorganize {{moduleName}} to improve {{refactorGoal}} without changing intended behavior.
- [ ] Update affected call sites or imports if the internal structure changes.
- [ ] Add or update regression tests covering the preserved behavior.

### Verification:
- Commands/checks: run npm test -- {{testFile}} and npm run build.
- Success looks like: regression tests pass, build/type-check finishes without errors, and preserved behavior remains covered by assertions.
- Manual proof fallback: if commands cannot run, capture the exact blocker and manually inspect {{moduleFile}} and {{testFile}} for preserved behavior, updated imports, and regression assertions.

### Recommended Skills:
- \`simplify-and-refactor-code-isomorphically\` — Shrink and unify code without changing behavior. Preserves API, performance, and compilation.
- \`extract\` — Extract repeated patterns into reusable components and design tokens.
- \`tdd\` — Run existing tests before and after to confirm behavioral preservation.

### Files:
- {{moduleFile}}
- {{testFile}}`,
    recommendedSkills: ["simplify-and-refactor-code-isomorphically", "extract", "tdd"],
    placeholders: [
      { name: "moduleName", description: "Module or subsystem being refactored", example: "scan pipeline", required: true },
      { name: "refactorGoal", description: "Desired improvement from the refactor", example: "separation of parsing from UI formatting", required: true },
      { name: "currentPain", description: "Current maintenance or correctness pain", example: "logic and rendering are tightly coupled", required: true },
      { name: "moduleFile", description: "Primary implementation file", example: "src/scan.ts", required: true },
      { name: "testFile", description: "Regression test file to update", example: "src/scan.test.ts", required: true },
    ],
    acceptanceCriteria: [
      "Improve module structure without regressing the externally visible behavior.",
      "Keep imports, naming, and seams understandable for future edits.",
      "Add or update regression tests to lock in the preserved behavior.",
    ],
    filePatterns: ["src/**/*.ts", "src/**/*.test.ts"],
    dependencyHints: "Refactor beads often unblock documentation or follow-up cleanup beads after the structural work lands.",
    examples: [
      {
        description: `Refactor the scan pipeline module to improve separation of parsing from UI formatting while preserving existing behavior. Reorganize the code, update any touched call sites, and keep the resulting structure easier for future agents to extend.

Why this bead exists:
- The current module has pain around logic and rendering are tightly coupled.
- The refactor should reduce maintenance cost without changing outward behavior.

Acceptance criteria:
- [ ] Reorganize scan pipeline to improve separation of parsing from UI formatting without changing intended behavior.
- [ ] Update affected call sites or imports if the internal structure changes.
- [ ] Add or update regression tests covering the preserved behavior.

### Verification:
- Commands/checks: run npm test -- src/scan.test.ts and npm run build.
- Success looks like: regression tests pass, build/type-check finishes without errors, and preserved behavior remains covered by assertions.
- Manual proof fallback: if commands cannot run, capture the exact blocker and manually inspect src/scan.ts and src/scan.test.ts for preserved behavior, updated imports, and regression assertions.

### Recommended Skills:
- \`simplify-and-refactor-code-isomorphically\` — Shrink and unify code without changing behavior. Preserves API, performance, and compilation.
- \`extract\` — Extract repeated patterns into reusable components and design tokens.
- \`tdd\` — Run existing tests before and after to confirm behavioral preservation.

### Files:
- src/scan.ts
- src/scan.test.ts`,
      },
    ],
  },
  {
    id: "add-tests",
    label: "Add tests",
    summary: "Add missing unit or integration coverage for existing behavior.",
    descriptionTemplate: `Add automated tests for {{featureName}} so the current behavior is covered before future changes land. Focus on the highest-risk paths, document the expected behavior in assertions, and avoid relying on manual verification.

Why this bead exists:
- {{featureName}} currently has insufficient automated coverage around {{riskArea}}.
- The goal is to lock in behavior before follow-up changes expand the feature.

Acceptance criteria:
- [ ] Add automated tests covering the primary behavior of {{featureName}}.
- [ ] Include at least one edge case or failure-path assertion for {{riskArea}}.
- [ ] Keep the tests readable enough that they document the intended behavior.

### Verification:
- Commands/checks: run npm test -- {{testFile}} and npm run build.
- Success looks like: the focused test file passes, build/type-check finishes without errors, and assertions cover the primary behavior plus at least one edge or failure path.
- Manual proof fallback: if commands cannot run, capture the exact blocker and manually inspect {{implementationFile}} and {{testFile}} for meaningful assertions tied to {{featureName}} and {{riskArea}}.

### Recommended Skills:
- \`tdd\` — Write tests that document expected behavior. Each test should fail before the covered code passes.
- \`testing-fuzzing\` — Add fuzzing harnesses for crash discovery and edge-case verification (when applicable).
- \`testing-metamorphic\` — Add metamorphic tests for systems without simple oracle assertions (when applicable).

### Files:
- {{implementationFile}}
- {{testFile}}`,
    recommendedSkills: ["tdd", "testing-fuzzing", "testing-metamorphic"],
    placeholders: [
      { name: "featureName", description: "Feature or function needing coverage", example: "plan-to-bead audit warnings", required: true },
      { name: "riskArea", description: "High-risk behavior or regression area", example: "empty sections and weak mappings", required: true },
      { name: "implementationFile", description: "Referenced source file", example: "src/prompts.ts", required: true },
      { name: "testFile", description: "Test file to create or extend", example: "src/flywheel.test.ts", required: true },
    ],
    acceptanceCriteria: [
      "Cover the main behavior with stable automated tests.",
      "Add at least one edge-case or failure-path assertion.",
      "Keep tests focused and descriptive rather than snapshotting vague output.",
    ],
    filePatterns: ["src/**/*.ts", "src/**/*.test.ts"],
    dependencyHints: "add-tests usually depends on an implementation bead when the tested feature is still being built.",
    examples: [
      {
        description: `Add automated tests for plan-to-bead audit warnings so the current behavior is covered before future changes land. Focus on the highest-risk paths, document the expected behavior in assertions, and avoid relying on manual verification.

Why this bead exists:
- plan-to-bead audit warnings currently has insufficient automated coverage around empty sections and weak mappings.
- The goal is to lock in behavior before follow-up changes expand the feature.

Acceptance criteria:
- [ ] Add automated tests covering the primary behavior of plan-to-bead audit warnings.
- [ ] Include at least one edge case or failure-path assertion for empty sections and weak mappings.
- [ ] Keep the tests readable enough that they document the intended behavior.

### Verification:
- Commands/checks: run npm test -- src/flywheel.test.ts and npm run build.
- Success looks like: the focused test file passes, build/type-check finishes without errors, and assertions cover the primary behavior plus at least one edge or failure path.
- Manual proof fallback: if commands cannot run, capture the exact blocker and manually inspect src/prompts.ts and src/flywheel.test.ts for meaningful assertions tied to plan-to-bead audit warnings and empty sections and weak mappings.

### Recommended Skills:
- \`tdd\` — Write tests that document expected behavior. Each test should fail before the covered code passes.
- \`testing-fuzzing\` — Add fuzzing harnesses for crash discovery and edge-case verification (when applicable).
- \`testing-metamorphic\` — Add metamorphic tests for systems without simple oracle assertions (when applicable).

### Files:
- src/prompts.ts
- src/flywheel.test.ts`,
      },
    ],
  },
];

const PLACEHOLDER_PATTERN = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const INVALID_VALUE_PATTERN = /[\r\0]/;

function cloneTemplate(template: BeadTemplate): BeadTemplate {
  return {
    ...template,
    placeholders: template.placeholders.map((placeholder) => ({ ...placeholder })),
    acceptanceCriteria: [...template.acceptanceCriteria],
    filePatterns: [...template.filePatterns],
    examples: template.examples.map((example) => ({ ...example })),
  };
}

export function listBeadTemplates(): BeadTemplate[] {
  return BUILTIN_TEMPLATES.map(cloneTemplate);
}

export function getTemplateById(templateId: string): BeadTemplate | undefined {
  const template = BUILTIN_TEMPLATES.find((candidate) => candidate.id === templateId);
  return template ? cloneTemplate(template) : undefined;
}

export function formatTemplatesForPrompt(): string {
  return BUILTIN_TEMPLATES.map((template) => {
    const placeholderNames = template.placeholders.map((placeholder) => placeholder.name).join(", ");
    return `- ${template.id}: ${template.summary} Placeholders: ${placeholderNames}`;
  }).join("\n");
}

function validatePlaceholderValues(placeholders: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(placeholders)) {
    if (INVALID_VALUE_PATTERN.test(value)) {
      return `Invalid placeholder value for ${name}. Values must not contain carriage returns or null bytes.`;
    }
  }
  return undefined;
}

export function expandTemplate(templateId: string, placeholders: Record<string, string>): ExpandTemplateResult {
  const template = BUILTIN_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) {
    return { success: false, error: `Unknown bead template: ${templateId}` };
  }

  const invalidValueError = validatePlaceholderValues(placeholders);
  if (invalidValueError) {
    return { success: false, error: invalidValueError };
  }

  const missingRequired = template.placeholders
    .filter((placeholder) => placeholder.required && !placeholders[placeholder.name]?.trim())
    .map((placeholder) => placeholder.name);
  if (missingRequired.length > 0) {
    const knownNames = new Set(template.placeholders.map((p) => p.name));
    const extraKeys = Object.keys(placeholders).filter((k) => !knownNames.has(k));
    const hint = extraKeys.length > 0 ? ` (unrecognized keys: ${extraKeys.join(", ")})` : "";
    return {
      success: false,
      error: `Missing required placeholders for ${templateId}: ${missingRequired.join(", ")}${hint}`,
    };
  }

  const description = template.descriptionTemplate.replace(PLACEHOLDER_PATTERN, (_match, placeholderName: string) => {
    return placeholders[placeholderName] ?? `{{${placeholderName}}}`;
  });

  const unresolved = Array.from(description.matchAll(PLACEHOLDER_PATTERN)).map((match) => match[1]);
  if (unresolved.length > 0) {
    return {
      success: false,
      error: `Unresolved placeholders for ${templateId}: ${Array.from(new Set(unresolved)).join(", ")}`,
    };
  }

  return { success: true, description };
}
