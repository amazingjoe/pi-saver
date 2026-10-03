import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function messageFingerprint(message: AgentMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

export interface PrefixStability {
  method: "exact-agent-message-json-sha256";
  previousContextAvailable: boolean;
  historicalPrefixUnchanged: boolean | null;
  matchingPrefixMessageCount: number;
  previousMessageCount: number;
  currentMessageCount: number;
  firstChangedMessageIndex: number | null;
  appendedMessageCount: number | null;
}

/** Tracks whether the previous message array is an exact prefix of this one. */
export class ContextPrefixTracker {
  private previous?: string[];

  reset(): void {
    this.previous = undefined;
  }

  observe(messages: AgentMessage[]): PrefixStability {
    const current = messages.map(messageFingerprint);
    const previous = this.previous;
    this.previous = current;
    if (!previous) {
      return {
        method: "exact-agent-message-json-sha256",
        previousContextAvailable: false,
        historicalPrefixUnchanged: null,
        matchingPrefixMessageCount: 0,
        previousMessageCount: 0,
        currentMessageCount: current.length,
        firstChangedMessageIndex: null,
        appendedMessageCount: null,
      };
    }
    let matching = 0;
    while (
      matching < previous.length &&
      matching < current.length &&
      previous[matching] === current[matching]
    ) matching += 1;
    const unchanged = matching === previous.length;
    return {
      method: "exact-agent-message-json-sha256",
      previousContextAvailable: true,
      historicalPrefixUnchanged: unchanged,
      matchingPrefixMessageCount: matching,
      previousMessageCount: previous.length,
      currentMessageCount: current.length,
      firstChangedMessageIndex: unchanged ? null : matching,
      appendedMessageCount: unchanged ? current.length - previous.length : null,
    };
  }
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export const JEV_PRICING_SNAPSHOT = {
  source: "https://docs.typesafe.ai/models",
  checkedAt: "2026-09-20",
  currency: "USD",
  unitTokens: 1_000_000,
  models: {
    "jev-1.13.0": { inputPerMillionTokens: 0.042, outputPerMillionTokens: 0 },
  },
} as const;

interface JevUsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

function jevReviewLeaves(review: unknown): Record<string, unknown>[] {
  if (!review || typeof review !== "object") return [];
  const candidate = review as Record<string, unknown>;
  if (!Array.isArray(candidate.batches)) return [candidate];
  return candidate.batches.flatMap((batch) => {
    if (!batch || typeof batch !== "object") return [];
    const nested = (batch as Record<string, unknown>).review;
    return nested && typeof nested === "object" ? [nested as Record<string, unknown>] : [];
  });
}

/** Aggregate usage returned by fresh Jev calls with a versioned pricing snapshot. */
export function summarizeJevUsage(review: unknown) {
  const candidate = review && typeof review === "object" ? review as Record<string, unknown> : {};
  const attemptedCalls = nonnegativeNumber(candidate.jevApiCallCount) ?? 0;
  const entries: JevUsageEntry[] = [];
  let unpricedReportedCalls = 0;
  for (const leaf of jevReviewLeaves(review)) {
    const usage = leaf.usage as Record<string, unknown> | undefined;
    const inputTokens = nonnegativeNumber(usage?.input_tokens);
    const outputTokens = nonnegativeNumber(usage?.output_tokens);
    const model = typeof leaf.model === "string" ? leaf.model : undefined;
    if (inputTokens === undefined || outputTokens === undefined || !model) continue;
    const price = JEV_PRICING_SNAPSHOT.models[model as keyof typeof JEV_PRICING_SNAPSHOT.models];
    if (!price) unpricedReportedCalls++;
    entries.push({
      model,
      inputTokens,
      outputTokens,
      ...(price ? {
        costUsd: inputTokens / JEV_PRICING_SNAPSHOT.unitTokens * price.inputPerMillionTokens
          + outputTokens / JEV_PRICING_SNAPSHOT.unitTokens * price.outputPerMillionTokens,
      } : {}),
    });
  }
  const inputTokens = entries.reduce((total, entry) => total + entry.inputTokens, 0);
  const outputTokens = entries.reduce((total, entry) => total + entry.outputTokens, 0);
  const reportedCostUsd = entries.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
  const reportedCalls = entries.length;
  const summary = {
    status: attemptedCalls === 0 ? "none" as const : reportedCalls ? "reported" as const : "unavailable" as const,
    attemptedCalls,
    reportedCalls,
    unavailableUsageCalls: Math.max(0, attemptedCalls - reportedCalls),
    pricedCalls: entries.length - unpricedReportedCalls,
    unpricedReportedCalls,
    inputTokens,
    outputTokens,
    models: [...new Set(entries.map(entry => entry.model))],
    reportedCostUsd,
    pricingSnapshot: JEV_PRICING_SNAPSHOT,
  };
  return {
    ...summary,
    costComplete: summary.unavailableUsageCalls === 0 && summary.unpricedReportedCalls === 0,
  };
}

export type JevUsageSummary = ReturnType<typeof summarizeJevUsage>;

export function combineJevUsage(summaries: JevUsageSummary[]) {
  const combined = {
    attemptedCalls: summaries.reduce((total, summary) => total + summary.attemptedCalls, 0),
    reportedCalls: summaries.reduce((total, summary) => total + summary.reportedCalls, 0),
    unavailableUsageCalls: summaries.reduce((total, summary) => total + summary.unavailableUsageCalls, 0),
    pricedCalls: summaries.reduce((total, summary) => total + summary.pricedCalls, 0),
    unpricedReportedCalls: summaries.reduce((total, summary) => total + summary.unpricedReportedCalls, 0),
    inputTokens: summaries.reduce((total, summary) => total + summary.inputTokens, 0),
    outputTokens: summaries.reduce((total, summary) => total + summary.outputTokens, 0),
    reportedCostUsd: summaries.reduce((total, summary) => total + summary.reportedCostUsd, 0),
    models: [...new Set(summaries.flatMap(summary => summary.models))],
    pricingSnapshot: JEV_PRICING_SNAPSHOT,
  };
  return {
    ...combined,
    costComplete: combined.unavailableUsageCalls === 0 && combined.unpricedReportedCalls === 0,
  };
}

export interface TokenImpactEstimate {
  method: "pi-estimateTokens-chars-div-4";
  removedTokens: number;
  keptTokens: number;
  originalTokens: number;
  removedPercent: number;
  keptPercent: number;
}

/** Estimate message-token impact with the same heuristic Pi uses for compaction. */
export function estimateTokenImpact(
  messages: AgentMessage[],
  kept: AgentMessage[],
  estimateMessageTokens: (message: AgentMessage) => number,
): TokenImpactEstimate {
  const retained = new Set(kept);
  let removedTokens = 0;
  let keptTokens = 0;
  for (const message of messages) {
    const tokens = estimateMessageTokens(message);
    if (retained.has(message)) keptTokens += tokens;
    else removedTokens += tokens;
  }
  const originalTokens = removedTokens + keptTokens;
  const removedPercent = originalTokens ? Math.round(removedTokens / originalTokens * 1000) / 10 : 0;
  const keptPercent = originalTokens ? Math.round((100 - removedPercent) * 10) / 10 : 0;
  return {
    method: "pi-estimateTokens-chars-div-4",
    removedTokens,
    keptTokens,
    originalTokens,
    removedPercent,
    keptPercent,
  };
}

/** Normalize Pi's provider-reported assistant usage for one completed inference. */
export function summarizeDownstreamUsage(message: AgentMessage) {
  const candidate = message as unknown as Record<string, unknown>;
  const usage = candidate.usage as Record<string, unknown> | undefined;
  const input = nonnegativeNumber(usage?.input);
  const cacheRead = nonnegativeNumber(usage?.cacheRead);
  const cacheWrite = nonnegativeNumber(usage?.cacheWrite);
  if (candidate.role !== "assistant" || input === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return { status: "unavailable" as const };
  }
  const promptTokens = input + cacheRead + cacheWrite;
  const cost = usage?.cost as Record<string, unknown> | undefined;
  const normalizedCost = cost && {
    input: nonnegativeNumber(cost.input),
    cacheRead: nonnegativeNumber(cost.cacheRead),
    cacheWrite: nonnegativeNumber(cost.cacheWrite),
    output: nonnegativeNumber(cost.output),
    total: nonnegativeNumber(cost.total),
  };
  return {
    status: "reported" as const,
    provider: typeof candidate.provider === "string" ? candidate.provider : undefined,
    model: typeof candidate.model === "string" ? candidate.model : undefined,
    responseModel: typeof candidate.responseModel === "string" ? candidate.responseModel : undefined,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(nonnegativeNumber(usage?.cacheWrite1h) === undefined ? {} : { cacheWrite1hTokens: nonnegativeNumber(usage?.cacheWrite1h) }),
    cachedInputTokens: cacheRead,
    uncachedInputTokens: input + cacheWrite,
    promptTokens,
    cacheHitRatePercent: promptTokens ? Math.round(cacheRead / promptTokens * 1000) / 10 : 0,
    cacheReportingObserved: cacheRead + cacheWrite > 0,
    outputTokens: nonnegativeNumber(usage?.output),
    totalTokens: nonnegativeNumber(usage?.totalTokens),
    ...(normalizedCost ? { cost: normalizedCost } : {}),
  };
}

export type DownstreamUsage = ReturnType<typeof summarizeDownstreamUsage>;

export interface ModelPricingSnapshot {
  provider?: string;
  model?: string;
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number };
  tiers: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
}

export function snapshotModelPricing(model: unknown): ModelPricingSnapshot | undefined {
  if (!model || typeof model !== "object") return undefined;
  const candidate = model as Record<string, unknown>;
  const cost = candidate.cost as Record<string, unknown> | undefined;
  const input = nonnegativeNumber(cost?.input);
  const output = nonnegativeNumber(cost?.output);
  const cacheRead = nonnegativeNumber(cost?.cacheRead);
  const cacheWrite = nonnegativeNumber(cost?.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  const tiers = Array.isArray(cost?.tiers) ? cost.tiers.flatMap((tier) => {
    if (!tier || typeof tier !== "object") return [];
    const value = tier as Record<string, unknown>;
    const inputTokensAbove = nonnegativeNumber(value.inputTokensAbove);
    const tierInput = nonnegativeNumber(value.input);
    const tierOutput = nonnegativeNumber(value.output);
    const tierCacheRead = nonnegativeNumber(value.cacheRead);
    const tierCacheWrite = nonnegativeNumber(value.cacheWrite);
    return inputTokensAbove === undefined || tierInput === undefined || tierOutput === undefined || tierCacheRead === undefined || tierCacheWrite === undefined
      ? []
      : [{ inputTokensAbove, input: tierInput, output: tierOutput, cacheRead: tierCacheRead, cacheWrite: tierCacheWrite }];
  }) : [];
  return {
    provider: typeof candidate.provider === "string" ? candidate.provider : undefined,
    model: typeof candidate.id === "string" ? candidate.id : undefined,
    rates: { input, output, cacheRead, cacheWrite },
    tiers,
  };
}

export interface CompletedCallUsage {
  inferenceCall: number;
  estimate: TokenImpactEstimate;
  usage: DownstreamUsage;
  pricing?: ModelPricingSnapshot;
}

function ratesForInput(pricing: ModelPricingSnapshot, promptTokens: number) {
  let rates = pricing.rates;
  let matchedThreshold = -1;
  for (const tier of pricing.tiers) {
    if (promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  return rates;
}

/** Aggregate completed calls and construct the estimated no-pruning comparison. */
export function summarizeTurnUsage(calls: CompletedCallUsage[]) {
  const reported = calls.filter(
    (call): call is CompletedCallUsage & { usage: Extract<DownstreamUsage, { status: "reported" }> } =>
      call.usage.status === "reported",
  );
  if (!reported.length) return { status: "unavailable" as const, callCount: calls.length };
  const sum = (select: (call: typeof reported[number]) => number | undefined) =>
    reported.reduce((total, call) => total + (select(call) ?? 0), 0);
  const actualPromptTokens = sum(call => call.usage.promptTokens);
  const estimatedAvoidedTokens = sum(call => call.estimate.removedTokens);
  const estimatedWithoutPruningTokens = actualPromptTokens + estimatedAvoidedTokens;
  const cachedInputTokens = sum(call => call.usage.cachedInputTokens);
  const uncachedInputTokens = sum(call => call.usage.uncachedInputTokens);
  const actualDownstreamCostValues = reported.map(call => call.usage.cost?.total);
  const actualDownstreamCostComplete = actualDownstreamCostValues.every(value => value !== undefined);
  const actualDownstreamCostUsd = actualDownstreamCostValues.reduce<number>((total, value) => total + (value ?? 0), 0);
  let estimatedGrossSavingsLowUsd = 0;
  let estimatedGrossSavingsLikelyUsd = 0;
  let estimatedGrossSavingsHighUsd = 0;
  let pricedEstimateCalls = 0;
  for (const call of reported) {
    if (!call.pricing) continue;
    pricedEstimateCalls++;
    const rates = ratesForInput(call.pricing, call.usage.promptTokens + call.estimate.removedTokens);
    const possibleRates = call.usage.cacheReportingObserved
      ? [rates.input, rates.cacheRead, rates.cacheWrite]
      : [rates.input];
    const lowRate = Math.min(...possibleRates);
    const highRate = Math.max(...possibleRates);
    const likelyRate = call.usage.cacheReportingObserved ? rates.cacheRead : rates.input;
    estimatedGrossSavingsLowUsd += call.estimate.removedTokens / 1_000_000 * lowRate;
    estimatedGrossSavingsLikelyUsd += call.estimate.removedTokens / 1_000_000 * likelyRate;
    estimatedGrossSavingsHighUsd += call.estimate.removedTokens / 1_000_000 * highRate;
  }
  const savingsCostEstimateComplete = pricedEstimateCalls === reported.length;
  return {
    status: "reported" as const,
    callCount: calls.length,
    reportedCallCount: reported.length,
    actualPromptTokens,
    estimatedAvoidedTokens,
    estimatedWithoutPruningTokens,
    estimatedReductionPercent: estimatedWithoutPruningTokens
      ? Math.round(estimatedAvoidedTokens / estimatedWithoutPruningTokens * 1000) / 10
      : 0,
    cachedInputTokens,
    uncachedInputTokens,
    cacheHitRatePercent: actualPromptTokens
      ? Math.round(cachedInputTokens / actualPromptTokens * 1000) / 10
      : 0,
    outputTokens: sum(call => call.usage.outputTokens),
    actualDownstreamCostUsd,
    actualDownstreamCostComplete,
    savingsCostEstimateComplete,
    pricedEstimateCalls,
    unpricedEstimateCalls: reported.length - pricedEstimateCalls,
    estimatedGrossSavingsLowUsd,
    estimatedGrossSavingsLikelyUsd,
    estimatedGrossSavingsHighUsd,
    ...(actualDownstreamCostComplete && savingsCostEstimateComplete ? {
      estimatedWithoutPruningCostLowUsd: actualDownstreamCostUsd + estimatedGrossSavingsLowUsd,
      estimatedWithoutPruningCostLikelyUsd: actualDownstreamCostUsd + estimatedGrossSavingsLikelyUsd,
      estimatedWithoutPruningCostHighUsd: actualDownstreamCostUsd + estimatedGrossSavingsHighUsd,
    } : {}),
  };
}

export async function recordDownstreamUsage(
  reviewLogPath: string,
  inferenceCall: number,
  message: AgentMessage,
): Promise<void> {
  const diagnostic = JSON.parse(await readFile(reviewLogPath, "utf8"));
  diagnostic.downstreamUsage = {
    inferenceCall,
    ...summarizeDownstreamUsage(message),
  };
  await writeFile(reviewLogPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
}
