import { buildSwarmForecastReport } from "./swarm-forecast-report.js";
import type { SwarmForecastInput, SwarmForecastReport } from "./swarm-forecast.js";

export const SWARM_FORECAST_DRILL_SCHEMA = "swarm-forecast-operator-drill.v1" as const;

export interface SwarmForecastDrillExpectation {
  riskKinds?: string[];
  minRiskCount?: number;
  maxRiskCount?: number;
  maxMutationActions?: number;
}

export interface SwarmForecastDrillSliceInput {
  id: string;
  phase: "red" | "green";
  input: SwarmForecastInput;
  expect: SwarmForecastDrillExpectation;
}

export interface SwarmForecastDrillSlice {
  id: string;
  phase: "red" | "green";
  report: SwarmForecastReport;
  passed: boolean;
  failures: string[];
}

export interface SwarmForecastOperatorDrill {
  schema: typeof SWARM_FORECAST_DRILL_SCHEMA;
  generated_at: string;
  mutation_guard: {
    live_agent_mail: false;
    live_beads: false;
    live_git: false;
    live_dashboard: false;
    live_trading: false;
    writes_only_output_dir: true;
  };
  slices: SwarmForecastDrillSlice[];
  summary: {
    red_count: number;
    green_count: number;
    passed_count: number;
    failed_count: number;
  };
}

function actionMutationCount(report: SwarmForecastReport): number {
  const actions = [
    ...report.forecast.suggested_dry_run_actions,
    ...report.build_lanes.recommendations,
    ...report.agent_fit.recommendations,
  ];
  return actions.filter((action) => action.mutation !== "none" || action.dry_run_only !== true).length;
}

function checkExpectations(report: SwarmForecastReport, expect: SwarmForecastDrillExpectation): string[] {
  const failures: string[] = [];
  const kinds = new Set(report.forecast.risks.map((risk) => risk.kind));
  for (const kind of expect.riskKinds ?? []) {
    if (!kinds.has(kind as any)) failures.push(`missing risk kind: ${kind}`);
  }
  if (expect.minRiskCount !== undefined && report.forecast.risks.length < expect.minRiskCount) failures.push(`risk count ${report.forecast.risks.length} < ${expect.minRiskCount}`);
  if (expect.maxRiskCount !== undefined && report.forecast.risks.length > expect.maxRiskCount) failures.push(`risk count ${report.forecast.risks.length} > ${expect.maxRiskCount}`);
  const mutations = actionMutationCount(report);
  if (expect.maxMutationActions !== undefined && mutations > expect.maxMutationActions) failures.push(`mutation actions ${mutations} > ${expect.maxMutationActions}`);
  return failures;
}

export function buildSwarmForecastOperatorDrill(slices: SwarmForecastDrillSliceInput[], generatedAt = new Date().toISOString()): SwarmForecastOperatorDrill {
  const built = slices.map((slice) => {
    const report = buildSwarmForecastReport({
      input: slice.input,
      source: { kind: "fixture", path: slice.id },
      generatedAt,
      artifacts: { json: `logs/swarm-forecast-drill/${slice.id}.json`, markdown: `logs/swarm-forecast-drill/${slice.id}.md` },
    });
    const failures = checkExpectations(report, slice.expect);
    return { id: slice.id, phase: slice.phase, report, failures, passed: failures.length === 0 };
  });
  return {
    schema: SWARM_FORECAST_DRILL_SCHEMA,
    generated_at: generatedAt,
    mutation_guard: {
      live_agent_mail: false,
      live_beads: false,
      live_git: false,
      live_dashboard: false,
      live_trading: false,
      writes_only_output_dir: true,
    },
    slices: built,
    summary: {
      red_count: built.filter((slice) => slice.phase === "red").length,
      green_count: built.filter((slice) => slice.phase === "green").length,
      passed_count: built.filter((slice) => slice.passed).length,
      failed_count: built.filter((slice) => !slice.passed).length,
    },
  };
}
