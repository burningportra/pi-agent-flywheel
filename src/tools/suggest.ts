import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { OrchestratorContext } from "../types.js";
import { TOOL_FAMILIES, TOOL_CANONICAL_PREFIX } from "./shared.js";

/**
 * R-007: typo / wrong-prefix correction.
 *
 * The pi extension MCP layer does not expose an unknown-tool hook, so when
 * an agent calls `orch_doctor` (typo) or `flywhel_select` (drop char), the host
 * returns "tool not found" with no suggestion. The fallback agent recovery
 * path is to call `flywheel_suggest({ wrong_name })` which returns the closest
 * registered name.
 *
 * Documented in `flywheel_robot_docs` so agents see the recovery path inline.
 */

export interface SuggestResult {
  wrong_name: string;
  canonical: string | null;
  distance: number | null;
  is_registered: boolean;
  is_legacy_alias: boolean;
  hint: string;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

export function allRegisteredToolNames(): string[] {
  const out: string[] = [];
  for (const names of Object.values(TOOL_FAMILIES)) {
    for (const n of names) out.push(n);
  }
  return out;
}

export function findClosestToolName(wrong: string): SuggestResult {
  const all = allRegisteredToolNames();
  if (all.includes(wrong)) {
    // Find the canonical for this name (canonical = last in family containing it)
    for (const names of Object.values(TOOL_FAMILIES) as readonly (readonly string[])[]) {
      if ((names as readonly string[]).includes(wrong)) {
        const canonical = names[names.length - 1];
        return {
          wrong_name: wrong,
          canonical,
          distance: 0,
          is_registered: true,
          is_legacy_alias: wrong !== canonical,
          hint: wrong === canonical
            ? `'${wrong}' is the canonical name and is registered.`
            : `'${wrong}' is a legacy alias of '${canonical}'. The legacy alias still works but emits a deprecation warning. Use '${canonical}' instead.`,
        };
      }
    }
  }

  // Strip prefix variants and try direct match
  const stripped = wrong.replace(/^(agent_flywheel_|orch_|flywheel_|fly_wheel_|flywhel_|fwheel_)/, "");
  const candidate = `${TOOL_CANONICAL_PREFIX}${stripped}`;
  if (all.includes(candidate)) {
    return {
      wrong_name: wrong,
      canonical: candidate,
      distance: levenshtein(wrong, candidate),
      is_registered: false,
      is_legacy_alias: false,
      hint: `'${wrong}' is not registered. Closest match by prefix-strip: '${candidate}'.`,
    };
  }

  // Levenshtein fallback
  let best: { name: string; dist: number } | null = null;
  for (const n of all) {
    const d = levenshtein(wrong, n);
    if (!best || d < best.dist) best = { name: n, dist: d };
  }
  if (!best) {
    return { wrong_name: wrong, canonical: null, distance: null, is_registered: false, is_legacy_alias: false, hint: "No registered tools (impossible state)." };
  }

  // If the closest is far (>4 chars), no useful suggestion
  if (best.dist > 4) {
    return {
      wrong_name: wrong,
      canonical: null,
      distance: best.dist,
      is_registered: false,
      is_legacy_alias: false,
      hint: `'${wrong}' is too far from any registered tool (closest: '${best.name}', distance ${best.dist}). Call flywheel_capabilities for the full tool list.`,
    };
  }

  // Resolve to canonical of the closest match's family
  let canonical = best.name;
  for (const names of Object.values(TOOL_FAMILIES) as readonly (readonly string[])[]) {
    if ((names as readonly string[]).includes(best.name)) canonical = names[names.length - 1];
  }
  return {
    wrong_name: wrong,
    canonical,
    distance: best.dist,
    is_registered: false,
    is_legacy_alias: false,
    hint: `Did you mean '${canonical}'? (Levenshtein distance ${best.dist} from '${wrong}'.)`,
  };
}

export function registerSuggestTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: "flywheel_suggest",
    label: "Flywheel Suggest",
    description: "Recovery path for 'tool not found' errors. Pass the wrong_name an agent tried; returns closest canonical match + distance + hint. Use after a tool-not-found error to recover without reading source.",
    promptSnippet: "Suggest the canonical tool name for a wrong/typo invocation",
    parameters: Type.Object({
      wrong_name: Type.String({ description: "The tool name the agent tried (e.g. 'orch_doctor', 'flywhel_select')." }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = findClosestToolName((params as any).wrong_name);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { suggestion: result },
      };
    },

    renderResult(result, _options, theme) {
      const r = (result.details as any)?.suggestion as SuggestResult;
      return new Text(theme.fg("success", `flywheel_suggest: ${r?.canonical ?? "(none)"}`), 0, 0);
    },
  });
}
