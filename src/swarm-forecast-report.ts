import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  SWARM_FORECAST_REPORT_SCHEMA,
  forecastAgentFit,
  forecastBuildLanes,
  forecastFromInput,
  summarizeForecastInput,
  type SwarmForecastAgentFitOutput,
  type SwarmForecastBuildLanesOutput,
  type SwarmForecastDryRunAction,
  type SwarmForecastInput,
  type SwarmForecastOutput,
  type SwarmForecastReport,
} from "./swarm-forecast.js";

export interface SwarmForecastReportSource extends Record<string, unknown> {
  kind: "fixture" | "saved-input" | "implementation-mode";
  path?: string;
  generated_by?: string;
  warnings?: string[];
}

export interface SwarmForecastStrictThresholds {
  max_critical_risks?: number;
  max_saturated_lanes?: number;
  max_stale_holders?: number;
}

export interface SwarmForecastStrictBreach {
  id: string;
  label: string;
  actual: number;
  max: number;
}

export interface BuildSwarmForecastReportOptions {
  input: SwarmForecastInput;
  source: SwarmForecastReportSource;
  generatedAt?: string;
  artifacts?: { json: string; markdown: string };
  strictThresholds?: SwarmForecastStrictThresholds;
}

export interface WriteSwarmForecastReportOptions extends BuildSwarmForecastReportOptions {
  outputDir: string;
  basename?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function canonicalForecastJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function strictBreaches(
  forecast: SwarmForecastOutput,
  buildLanes: SwarmForecastBuildLanesOutput,
  agentFit: SwarmForecastAgentFitOutput,
  thresholds: SwarmForecastStrictThresholds = {}
): SwarmForecastStrictBreach[] {
  const breaches: SwarmForecastStrictBreach[] = [];
  const criticalRisks = forecast.risks.filter((risk) => risk.severity === "critical").length;
  const saturatedLanes = buildLanes.summary.saturated_lanes.length;
  const staleHolders = agentFit.summary.stale_holder_count;
  if (thresholds.max_critical_risks !== undefined && criticalRisks > thresholds.max_critical_risks) {
    breaches.push({ id: "critical-risks", label: "Critical risks", actual: criticalRisks, max: thresholds.max_critical_risks });
  }
  if (thresholds.max_saturated_lanes !== undefined && saturatedLanes > thresholds.max_saturated_lanes) {
    breaches.push({ id: "saturated-lanes", label: "Saturated validation lanes", actual: saturatedLanes, max: thresholds.max_saturated_lanes });
  }
  if (thresholds.max_stale_holders !== undefined && staleHolders > thresholds.max_stale_holders) {
    breaches.push({ id: "stale-holders", label: "Stale holders", actual: staleHolders, max: thresholds.max_stale_holders });
  }
  return breaches;
}

export function buildSwarmForecastReport(options: BuildSwarmForecastReportOptions): SwarmForecastReport {
  const forecast = forecastFromInput(options.input);
  const buildLanes = forecastBuildLanes(options.input, options.input.forecast_config);
  const agentFit = forecastAgentFit(options.input);
  const thresholds = options.strictThresholds ?? {};
  const breaches = strictBreaches(forecast, buildLanes, agentFit, thresholds);
  return {
    schema: SWARM_FORECAST_REPORT_SCHEMA,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    source: options.source,
    inputs: options.input,
    input_counts: summarizeForecastInput(options.input),
    forecast,
    build_lanes: buildLanes,
    agent_fit: agentFit,
    artifacts: options.artifacts ?? {
      json: ".pi-agent-flywheel/swarm-forecast/latest.json",
      markdown: ".pi-agent-flywheel/swarm-forecast/latest.md",
    },
    strict: {
      thresholds,
      breach_count: breaches.length,
      breaches,
    },
  };
}

function formatList(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function actionText(action: SwarmForecastDryRunAction): string {
  if (action.copy_text) return action.copy_text;
  if (action.command) return action.command;
  return action.rationale;
}

export function renderSwarmForecastMarkdown(report: SwarmForecastReport): string {
  const lines: string[] = [
    "# Swarm Forecast Report",
    "",
    `- Generated: ${report.generated_at}`,
    `- Source: ${String(report.source.kind ?? "unknown")}`,
    `- Beads: ${report.input_counts.beads}`,
    `- Agents: ${report.input_counts.agents}`,
    `- Dominant constraint: ${report.build_lanes.summary.dominant_constraint}`,
    `- Critical risks: ${report.forecast.risks.filter((risk) => risk.severity === "critical").length}`,
    "",
    "## Forecast Summary",
    "",
    `- Ready: ${report.forecast.summary.ready_count}`,
    `- Blocked: ${report.forecast.summary.blocked_count}`,
    `- In progress: ${report.forecast.summary.in_progress_count}`,
    `- Horizon minutes: ${report.forecast.summary.forecast_horizon_minutes}`,
    "",
    "## Top Bottlenecks",
    "",
  ];

  if (report.forecast.risks.length === 0) {
    lines.push("- none");
  } else {
    for (const risk of report.forecast.risks.slice(0, 10)) {
      lines.push(`- ${risk.severity} ${risk.kind}: ${risk.id}`);
      for (const evidence of risk.evidence.slice(0, 3)) lines.push(`  - evidence: ${evidence}`);
    }
  }

  lines.push("", "## Critical Path", "", `- ${formatList(report.forecast.summary.critical_path)}`);

  lines.push("", "## File Contention", "");
  const fileRisks = report.forecast.risks.filter((risk) => risk.kind === "file-contention");
  if (fileRisks.length === 0) lines.push("- none");
  for (const risk of fileRisks) lines.push(`- ${risk.id}: ${formatList(risk.affected_paths)} (${formatList(risk.affected_beads)})`);

  lines.push("", "## Build-Lane Pressure", "");
  if (report.build_lanes.lanes.length === 0) {
    lines.push("- none");
  } else {
    lines.push("| Lane | Pressure | Capacity | Bottleneck | Estimate |", "| --- | ---: | ---: | --- | ---: |");
    for (const lane of report.build_lanes.lanes) {
      lines.push(`| ${lane.id} | ${lane.pressure} | ${lane.capacity} | ${lane.bottleneck ? "yes" : "no"} | ${lane.estimated_seconds}s |`);
    }
  }

  lines.push("", "## Agent Fit and Stale Holders", "");
  lines.push(`- Agent count: ${report.agent_fit.summary.agent_count}`);
  lines.push(`- Active candidate beads: ${formatList(report.agent_fit.summary.active_candidate_beads)}`);
  lines.push(`- Stale holders: ${report.agent_fit.summary.stale_holder_count}`);
  if (report.agent_fit.stale_holders.length > 0) {
    for (const holder of report.agent_fit.stale_holders) lines.push(`  - ${String(holder.agent)} (${String(holder.status)}): ${String(holder.current_bead ?? "reserved work")}`);
  }

  lines.push("", "## Dry-Run Actions", "");
  const actions = [
    ...report.forecast.suggested_dry_run_actions,
    ...report.build_lanes.recommendations,
    ...report.agent_fit.recommendations,
  ];
  if (actions.length === 0) lines.push("- none");
  for (const action of actions.slice(0, 12)) {
    lines.push(`- ${action.label}: ${actionText(action)}`);
    lines.push(`  - mutation=${action.mutation}; dry_run_only=${String(action.dry_run_only)}`);
  }

  lines.push("", "## Strict Mode", "");
  const strict = report.strict as { breach_count?: number; breaches?: SwarmForecastStrictBreach[] } | undefined;
  if (!strict || !strict.breach_count) {
    lines.push("- no breaches");
  } else {
    for (const breach of strict.breaches ?? []) lines.push(`- ${breach.label}: ${breach.actual} > ${breach.max}`);
  }

  lines.push("", "## What Not To Automate", "", "- Do not assign agents from this report.", "- Do not release reservations from this report.", "- Do not reopen or close beads from this report.", "- Do not run Git commits or pushes from this report.", "");
  return lines.join("\n");
}

export function formatSwarmForecastLaunchAdvisory(report: SwarmForecastReport): string {
  const topRisks = report.forecast.risks.slice(0, 3);
  const actions = [
    ...report.forecast.suggested_dry_run_actions,
    ...report.build_lanes.recommendations,
    ...report.agent_fit.recommendations,
  ].slice(0, 5);
  const lines = [
    "## 🔮 Swarm Forecast (read-only)",
    "",
    `- Artifact JSON: \`${report.artifacts.json}\``,
    `- Artifact Markdown: \`${report.artifacts.markdown}\``,
    `- Dominant constraint: **${report.build_lanes.summary.dominant_constraint}**`,
    `- Critical path: ${formatList(report.forecast.summary.critical_path)}`,
    `- Saturated lanes: ${formatList(report.build_lanes.summary.saturated_lanes)}`,
    `- Stale holders: ${report.agent_fit.summary.stale_holder_count}`,
    "",
    "### Top forecast risks",
  ];
  if (topRisks.length === 0) {
    lines.push("- none");
  } else {
    for (const risk of topRisks) {
      lines.push(`- ${risk.severity} ${risk.kind}: ${risk.affected_beads.join(", ") || risk.id}`);
      if (risk.affected_paths.length > 0) lines.push(`  - paths: ${risk.affected_paths.join(", ")}`);
    }
  }
  lines.push("", "### Copy-only dry-run guidance");
  for (const action of actions) lines.push(`- ${action.label}: ${actionText(action)} (mutation=${action.mutation}, dry_run_only=${String(action.dry_run_only)})`);
  lines.push("", "Forecast output is advisory only: do not auto-assign agents, release reservations, reopen beads, or mutate Git from these recommendations.");
  return lines.join("\n");
}

export function writeSwarmForecastReport(options: WriteSwarmForecastReportOptions): SwarmForecastReport {
  const basename = options.basename ?? "latest";
  const artifacts = {
    json: join(options.outputDir, `${basename}.json`),
    markdown: join(options.outputDir, `${basename}.md`),
  };
  const report = buildSwarmForecastReport({ ...options, artifacts });
  mkdirSync(options.outputDir, { recursive: true });
  writeFileSync(artifacts.json, canonicalForecastJson(report));
  writeFileSync(artifacts.markdown, renderSwarmForecastMarkdown(report));
  return report;
}
