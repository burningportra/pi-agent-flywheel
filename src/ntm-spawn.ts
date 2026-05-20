/**
 * NTM spawn pane mix helpers — cc / cod / agent (Cursor CLI; preferred over gmi).
 */

import {
  isAnthropicModel,
  isDirectGoogleModel,
  isOpenAICodexModel,
  isOpenRouterGoogleModel,
} from "./model-policy.js";

export type NtmPaneKind = "cc" | "cod" | "agent" | "gmi";

export interface NtmPaneSpec {
  kind: NtmPaneKind;
  count: number;
  model?: string;
}

export function totalPaneCount(specs: NtmPaneSpec[]): number {
  return specs.reduce((sum, spec) => sum + Math.max(0, Math.floor(spec.count)), 0);
}

export function ntmSpawnFlagForSpec(spec: NtmPaneSpec): string {
  const count = Math.max(1, Math.floor(spec.count));
  if (spec.model?.trim()) {
    return `--${spec.kind}=${count}:${spec.model.trim()}`;
  }
  return `--${spec.kind}=${count}`;
}

export function formatNtmSpawnFlags(specs: NtmPaneSpec[]): string {
  return specs
    .filter((spec) => spec.count > 0)
    .map(ntmSpawnFlagForSpec)
    .join(" ");
}

/** Base swarm mixes by project scale (agent replaces gmi in the default recipe). */
export function baseSwarmPaneMix(openBeadCount: number): NtmPaneSpec[] {
  if (openBeadCount >= 400) {
    return [
      { kind: "cc", count: 4, model: "opus" },
      { kind: "cod", count: 4 },
      { kind: "agent", count: 2 },
    ];
  }
  if (openBeadCount >= 100) {
    return [
      { kind: "cc", count: 3, model: "opus" },
      { kind: "cod", count: 3 },
      { kind: "agent", count: 2 },
    ];
  }
  return [
    { kind: "cc", count: 1 },
    { kind: "cod", count: 1 },
    { kind: "agent", count: 1 },
  ];
}

/**
 * Scale a pane mix to an exact total while preserving kind diversity when possible.
 */
export function scalePaneMixToTotal(specs: NtmPaneSpec[], targetTotal: number): NtmPaneSpec[] {
  const total = Math.max(1, Math.floor(targetTotal));
  const base = specs.filter((spec) => spec.count > 0);
  if (base.length === 0) {
    return [{ kind: "agent", count: total }];
  }

  const current = totalPaneCount(base);
  if (current === total) {
    return base.map((spec) => ({ ...spec }));
  }

  const scaled = base.map((spec) => ({
    ...spec,
    count: Math.max(0, Math.floor(spec.count)),
  }));

  if (current < total) {
    let remaining = total - current;
    const addOrder: NtmPaneKind[] = ["cc", "cod", "agent"];
    let idx = 0;
    while (remaining > 0) {
      const kind = addOrder[idx % addOrder.length];
      const entry = scaled.find((spec) => spec.kind === kind);
      if (entry) {
        entry.count += 1;
      } else {
        scaled.push({ kind, count: 1 });
      }
      remaining -= 1;
      idx += 1;
    }
    return scaled.filter((spec) => spec.count > 0);
  }

  let remaining = current - total;
  const removeOrder: NtmPaneKind[] = ["cod", "cc", "agent"];
  while (remaining > 0) {
    let removed = false;
    for (const kind of removeOrder) {
      const entry = scaled.find((spec) => spec.kind === kind);
      if (entry && entry.count > 0) {
        const canRemove = kind === "agent" && entry.count === 1 && scaled.some((s) => s.kind !== "agent" && s.count > 0)
          ? 0
          : 1;
        if (canRemove > 0 && (kind !== "agent" || entry.count > 1 || totalPaneCount(scaled) > 1)) {
          entry.count -= 1;
          remaining -= 1;
          removed = true;
          if (remaining <= 0) break;
        }
      }
    }
    if (!removed) {
      const largest = [...scaled].sort((a, b) => b.count - a.count)[0];
      if (largest && largest.count > 1) {
        largest.count -= 1;
        remaining -= 1;
      } else {
        break;
      }
    }
  }

  const filtered = scaled.filter((spec) => spec.count > 0);
  if (totalPaneCount(filtered) === 0) {
    return [{ kind: "agent", count: total }];
  }
  return filtered;
}

export function recommendSwarmPaneMix(openBeadCount: number, targetTotal?: number): NtmPaneSpec[] {
  const base = baseSwarmPaneMix(openBeadCount);
  if (targetTotal == null) {
    return base;
  }
  return scalePaneMixToTotal(base, targetTotal);
}

function anthropicVariant(model?: string): string | undefined {
  const lower = model?.toLowerCase() ?? "";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return undefined;
}

export interface ResolveSinglePaneOptions {
  /** When false, Google/Gemini models fall back to `--gmi` instead of `--agent`. */
  agentCliAvailable?: boolean;
}

export function resolveSinglePaneSpec(
  model?: string,
  options?: ResolveSinglePaneOptions,
): NtmPaneSpec {
  const agentOk = options?.agentCliAvailable !== false;

  if (isAnthropicModel(model)) {
    return { kind: "cc", count: 1, model: anthropicVariant(model) };
  }
  if (isOpenAICodexModel(model)) {
    return { kind: "cod", count: 1 };
  }
  if (isDirectGoogleModel(model) || isOpenRouterGoogleModel(model)) {
    return agentOk ? { kind: "agent", count: 1 } : { kind: "gmi", count: 1 };
  }
  return agentOk ? { kind: "agent", count: 1 } : { kind: "cc", count: 1 };
}

export function paneSpecsForLaunch(options: {
  agentCount?: number;
  openBeadCount?: number;
  model?: string;
  paneSpecs?: NtmPaneSpec[];
  agentCliAvailable?: boolean;
}): NtmPaneSpec[] {
  if (options.paneSpecs?.length) {
    const total = options.agentCount ?? totalPaneCount(options.paneSpecs);
    if (options.agentCount != null && totalPaneCount(options.paneSpecs) !== total) {
      return scalePaneMixToTotal(options.paneSpecs, total);
    }
    return options.paneSpecs;
  }

  const count = Math.max(1, Math.min(10, Math.floor(options.agentCount ?? 1)));
  if (count === 1) {
    return [resolveSinglePaneSpec(options.model, { agentCliAvailable: options.agentCliAvailable })];
  }
  return recommendSwarmPaneMix(options.openBeadCount ?? 50, count);
}

export function describePaneSpecs(specs: NtmPaneSpec[]): string {
  return specs
    .map((spec) => {
      const variant = spec.model ? `:${spec.model}` : "";
      return `${spec.kind}${variant}×${spec.count}`;
    })
    .join(", ");
}
