import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { observeContext, filterContext, measureContextShare, TurnReviewMemo } from "./review.ts";
import { combineJevUsage, ContextPrefixTracker, estimateTokenImpact, recordDownstreamUsage, snapshotModelPricing, summarizeDownstreamUsage, summarizeJevUsage, summarizeTurnUsage, type CompletedCallUsage, type JevUsageSummary, type ModelPricingSnapshot, type TokenImpactEstimate } from "./telemetry.ts";
import { ANSI, color, contextShareBar, costSummaryBox, estimatedAvoidedLine, formatTokenCount, formatUsd, formatUsdRange, measuredPromptLine, metricConnector, statusCard, tokenEstimateLine } from "./display.ts";
import { readConfig, EXTENSION_DIRECTORY, type FilterConfig } from "./config.ts";

const MAX_LOG_FILES = 9;
const FILES_WRITTEN_PER_INFERENCE = 3;

const MODE_HELP = [
  `Change mode · ${join(EXTENSION_DIRECTORY, "config.json")}`,
  '  "mode": "active"   Remove irrelevant turns',
  '  "mode": "observe"  Preview only; keep all context',
  '  "mode": "off"      TURN OFF Jev calls and filtering',
  "",
  "Save the file. Changes apply on the next message.",
  "No reload needed. Off mode also stops context logging.",
];

async function readApiKey(): Promise<string | undefined> {
  let key = process.env.TYPESAFE_API_KEY;
  if (key === undefined) {
    try {
      key = parseEnv(await readFile(join(EXTENSION_DIRECTORY, ".env"), "utf8")).TYPESAFE_API_KEY;
    } catch {
      // Missing or unreadable configuration must not interrupt inference.
      return undefined;
    }
  }
  key = key?.trim();
  return key && key !== "your_typesafe_api_key_here" ? key : undefined;
}

async function makeRoomForContextLogs(logsDirectory: string): Promise<void> {
  const entries = await readdir(logsDirectory, { withFileTypes: true });
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^(.*_turn-\d+)_(?:before|after|review)\.json$/);
    if (!match) continue;
    const names = grouped.get(match[1]) ?? [];
    names.push(entry.name);
    grouped.set(match[1], names);
  }
  const groups = await Promise.all([...grouped.entries()].map(async ([prefix, names]) => {
    const modifiedTimes = await Promise.all(
      names.map(async (name) => (await stat(join(logsDirectory, name))).mtimeMs),
    );
    return { prefix, names, modifiedAt: Math.max(...modifiedTimes) };
  }));
  groups.sort((left, right) => left.modifiedAt - right.modifiedAt || left.prefix.localeCompare(right.prefix));
  const availableBeforeWrite = MAX_LOG_FILES - FILES_WRITTEN_PER_INFERENCE;
  let existingCount = groups.reduce((total, group) => total + group.names.length, 0);
  for (const group of groups) {
    if (existingCount <= availableBeforeWrite) break;
    await Promise.all(group.names.map((name) => unlink(join(logsDirectory, name))));
    existingCount -= group.names.length;
  }
}

/** Review context, optionally applying whole-turn removals for this inference. */
export default function piSaver(pi: ExtensionAPI) {
  let inferenceCall = 0;
  let announcedConfig = "";
  const pendingCalls: { inferenceCall: number; estimate: TokenImpactEstimate; pricing?: ModelPricingSnapshot; path?: string }[] = [];
  const completedCalls: CompletedCallUsage[] = [];
  const freshJevUsages: JevUsageSummary[] = [];
  const prefixTracker = new ContextPrefixTracker();
  const reviewMemo = new TurnReviewMemo<Awaited<ReturnType<typeof observeContext>>>();
  function announce(config: FilterConfig, ctx: ExtensionContext) {
    const signature = JSON.stringify(config);
    if (!ctx.hasUI || signature === announcedConfig) return;
    announcedConfig = signature;
    ctx.ui.notify(statusCard(config.mode === "off" ? "OFF" : "RUNNING", [
      `Mode       ${config.mode === "active" ? "Active — removal enabled" : config.mode === "observe" ? "Observer — preview only" : "Off — disabled"}`,
      `Threshold  ${config.removalThreshold}`,
    ], [
      config.mode === "off" ? "Full context retained. No Jev calls or new logs."
        : config.mode === "active" ? "Irrelevant turns are removed from this inference only."
        : "Removal decisions are logged. Full context is retained.",
      "Saved conversation history stays intact.",
    ], MODE_HELP), "info");
  }
  pi.on("session_start", async (_event, ctx) => {
    announcedConfig = "";
    pendingCalls.length = 0;
    completedCalls.length = 0;
    freshJevUsages.length = 0;
    prefixTracker.reset();
    try { announce(await readConfig(), ctx); }
    catch {
      if (ctx.hasUI) ctx.ui.notify(statusCard("CONFIGURATION ERROR", ["Full context retained; review is disabled."], ["Fix the JSON configuration and set removalThreshold from 0 to 1."], MODE_HELP), "warning");
    }
  });
  pi.on("before_agent_start", () => {
    inferenceCall = 0;
    pendingCalls.length = 0;
    completedCalls.length = 0;
    freshJevUsages.length = 0;
    reviewMemo.reset();
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const pending = pendingCalls.shift();
    if (!pending) return;
    const usage = summarizeDownstreamUsage(event.message);
    completedCalls.push({ inferenceCall: pending.inferenceCall, estimate: pending.estimate, pricing: pending.pricing, usage });
    if (!pending.path) return;
    try {
      await recordDownstreamUsage(pending.path, pending.inferenceCall, event.message);
    } catch {
      if (ctx.hasUI) ctx.ui.notify("PI-Saver could not record downstream cache usage.", "warning");
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    const summary = summarizeTurnUsage(completedCalls);
    if (!ctx.hasUI || summary.status !== "reported") return;
    const jev = combineJevUsage(freshJevUsages);
    const incomplete = summary.reportedCallCount !== summary.callCount;
    const costLines: string[] = [];
    const costDetails: string[] = [];
    let netLikely: number | undefined;
    let savingsPercent: number | undefined;
    if (summary.savingsCostEstimateComplete && jev.costComplete) {
      const netLow = summary.estimatedGrossSavingsLowUsd - jev.reportedCostUsd;
      netLikely = summary.estimatedGrossSavingsLikelyUsd - jev.reportedCostUsd;
      const netHigh = summary.estimatedGrossSavingsHighUsd - jev.reportedCostUsd;
      const likelyWithout = summary.estimatedWithoutPruningCostLikelyUsd;
      savingsPercent = likelyWithout ? Math.round(netLikely / likelyWithout * 100) : undefined;
      costDetails.push(
        `Savings estimate range   ${formatUsdRange(netLow, netHigh)}`,
        `Gross model savings      ~${formatUsd(summary.estimatedGrossSavingsLikelyUsd)}`,
        "Estimation basis         Cache-read pricing when observed; input otherwise.",
      );
    }
    if (summary.actualDownstreamCostComplete && jev.costComplete) {
      costLines.push(...costSummaryBox({
        estimatedWithoutUsd: summary.estimatedWithoutPruningCostLikelyUsd,
        actualTotalUsd: summary.actualDownstreamCostUsd + jev.reportedCostUsd,
        modelUsd: summary.actualDownstreamCostUsd,
        jevUsd: jev.reportedCostUsd,
        netSavingsUsd: netLikely,
        savingsPercent,
      }));
    } else if (summary.actualDownstreamCostComplete) {
      costLines.push(`Actually paid   ${color(formatUsd(summary.actualDownstreamCostUsd), ANSI.actual)} model · ${color(formatUsd(jev.reportedCostUsd), ANSI.actual)} Jev reported`);
    }
    ctx.ui.notify(statusCard("MEASURED", [
      `Calls      ${color(`${summary.reportedCallCount} provider request${summary.reportedCallCount === 1 ? "" : "s"}${incomplete ? ` · ${summary.callCount - summary.reportedCallCount} unavailable` : ""}`, ANSI.actual)}`,
      measuredPromptLine(summary.actualPromptTokens, summary.estimatedWithoutPruningTokens),
      estimatedAvoidedLine(summary.estimatedAvoidedTokens, summary.estimatedReductionPercent),
      contextShareBar(summary.estimatedReductionPercent),
      `Cache      ${color(`${formatTokenCount(summary.cachedInputTokens)} read · ${summary.cacheHitRatePercent.toFixed(1)}% hit`, ANSI.cached)}`,
      `Uncached   ${color(`${formatTokenCount(summary.uncachedInputTokens)} input`, ANSI.actual)}`,
      `Output     ${color(`${formatTokenCount(summary.outputTokens)} tokens`, ANSI.actual)}`,
      ...(costLines.length ? ["", ...costLines] : []),
    ], [
      ...costDetails,
      "Prompt, cache and output values are provider-reported totals.",
      "Without pruning = actual prompt + Pi-estimated removed message tokens.",
      `Jev       ${jev.attemptedCalls} fresh calls · ${formatTokenCount(jev.inputTokens)} input · ${formatUsd(jev.reportedCostUsd)} reported`,
      ...(jev.unavailableUsageCalls || jev.unpricedReportedCalls
        ? [`           ${jev.unavailableUsageCalls} usage unavailable · ${jev.unpricedReportedCalls} unpriced`]
        : []),
      ...(summary.unpricedEstimateCalls
        ? [`Savings   unavailable for ${summary.unpricedEstimateCalls} call${summary.unpricedEstimateCalls === 1 ? "" : "s"} without Pi model pricing.`]
        : []),
    ], []), "info");
    completedCalls.length = 0;
    freshJevUsages.length = 0;
  });
  pi.on("context", async (event, ctx) => {
    const call = ++inferenceCall;
    let review: Awaited<ReturnType<typeof observeContext>>;
    let reviewSource: "fresh" | "reused" = "fresh";
    let reviewOriginCall = call;
    let mode: FilterConfig["mode"] = "observe";
    let virtualMessages = event.messages;
    let removedGroupIds: string[] = [];
    let failureReason = "invalid-config";
    try {
      const config = await readConfig();
      mode = config.mode;
      announce(config, ctx);
      if (mode === "off") {
        reviewMemo.reset();
        prefixTracker.observe(event.messages);
        return { messages: event.messages };
      }
      failureReason = "filter-failed";
      const configSignature = JSON.stringify(config);
      const reused = reviewMemo.reuse(event.messages, configSignature);
      if (reused) {
        review = reused.value;
        reviewSource = "reused";
        reviewOriginCall = reused.originCall;
      } else {
        reviewMemo.reset();
        review = await observeContext(event.messages, { apiKey: await readApiKey(), threshold: config.removalThreshold });
        if (review.status === "reviewed") {
          reviewMemo.remember(event.messages, configSignature, call, review);
        }
      }
      if (mode === "active" && review.status === "reviewed") {
        const filtered = filterContext(event.messages, review.proposedRemovedGroupIds);
        virtualMessages = filtered.messages;
        removedGroupIds = filtered.removedGroupIds;
      }
    } catch {
      reviewMemo.reset();
      virtualMessages = event.messages;
      removedGroupIds = [];
      review = { mode, status: "error", reason: failureReason, jevApiCallCount: 0, proposedRemovedGroupIds: [] };
    }
    const originalReviewJevApiCallCount = review.jevApiCallCount;
    const jevApiCallCount = reviewSource === "fresh" ? originalReviewJevApiCallCount : 0;
    const freshJevUsage = summarizeJevUsage(review);
    if (reviewSource === "fresh" && freshJevUsage.attemptedCalls > 0) freshJevUsages.push(freshJevUsage);
    const jevUsage = reviewSource === "fresh" ? { reviewSource, ...freshJevUsage } : {
      reviewSource,
      status: "reused" as const,
      originCall: reviewOriginCall,
      attemptedCalls: 0,
      reportedCostUsd: 0,
    };
    const prefixStability = prefixTracker.observe(virtualMessages);
    const diagnostic = {
      ...review, mode, reviewSource, reviewOriginCall,
      jevApiCallMade: jevApiCallCount > 0,
      jevApiCallCount,
      originalReviewJevApiCallCount,
      jevUsage,
      prefixStability,
      downstreamUsage: { status: "pending", inferenceCall: call },
      removedGroupIds,
      removedMessageCount: event.messages.length - virtualMessages.length,
      keptMessageCount: virtualMessages.length,
      keptTurnCount: virtualMessages.filter(message => message.role === "user").length,
    };
    const contextShare = measureContextShare(event.messages, virtualMessages);
    const tokenEstimate = estimateTokenImpact(event.messages, virtualMessages, estimateTokens);
    const logsDirectory = join(EXTENSION_DIRECTORY, "logs");
    const prefix = `${new Date().toISOString().replaceAll(":", "-")}_turn-${String(call).padStart(3, "0")}`;
    const reviewLogPath = join(logsDirectory, `${prefix}_review.json`);
    const downstreamPricing = snapshotModelPricing(ctx.model);
    const pending = { inferenceCall: call, estimate: tokenEstimate, pricing: downstreamPricing, path: undefined as string | undefined };
    pendingCalls.push(pending);
    try {
      const loggedDiagnostic = { ...diagnostic, contextShare, tokenEstimate, downstreamPricing };
      await mkdir(logsDirectory, { recursive: true });
      await makeRoomForContextLogs(logsDirectory);
      await Promise.all([
        ["before", event.messages], ["after", virtualMessages], ["review", loggedDiagnostic],
      ].map(([suffix, value]) => writeFile(join(logsDirectory, `${prefix}_${suffix}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf8")));
      pending.path = reviewLogPath;
      if (ctx.hasUI) ctx.ui.notify(
        statusCard(review.status === "reviewed" ? "RUNNING" : review.status === "error" ? "REVIEW FAILED" : "REVIEW SKIPPED", [
          `Mode       ${mode === "active" ? "Active — removal enabled" : "Observer — preview only"}`,
          `Review     #${call} · ${review.status}${reviewSource === "reused" ? ` (reused #${reviewOriginCall}; no Jev call)` : "reason" in review ? ` (${review.reason})` : ""}`,
          reviewSource === "reused"
            ? `Jev        0 calls · reused review #${reviewOriginCall}`
            : freshJevUsage.status === "reported"
              ? `Jev        ${jevApiCallCount} call${jevApiCallCount === 1 ? "" : "s"} · ${formatTokenCount(freshJevUsage.inputTokens)} input`
              : `Jev        ${jevApiCallCount} call${jevApiCallCount === 1 ? "" : "s"} · usage unavailable`,
          ...(reviewSource === "fresh" && freshJevUsage.pricedCalls
            ? [`Jev cost   ${formatUsd(freshJevUsage.reportedCostUsd)}${freshJevUsage.costComplete ? "" : " reported"}`]
            : []),
          ...("threshold" in review ? [`Threshold  ${review.threshold}`] : []),
          ...("batchCount" in review ? [`Batches    ${review.batchCount} API requests`] : []),
          metricConnector(),
          mode === "active"
            ? `Removed    ${removedGroupIds.length} turns · ${diagnostic.removedMessageCount} messages`
            : `Proposed   ${review.proposedRemovedGroupIds.length} turns to remove (not applied)`,
          `Kept       ${diagnostic.keptTurnCount} turns · ${diagnostic.keptMessageCount} messages`,
          tokenEstimateLine(tokenEstimate.removedTokens, tokenEstimate.keptTokens),
          contextShareBar(tokenEstimate.removedPercent),
        ], [
          "Token figures use Pi's per-message compaction estimate (characters ÷ 4).",
          "They exclude request framing, tool definitions and external system prompt.",
          ...(reviewSource === "fresh" && freshJevUsage.reportedCalls
            ? [`Jev output ${formatTokenCount(freshJevUsage.outputTokens)} tokens${freshJevUsage.pricedCalls ? " · free for priced model versions." : ""}`,
              `Jev price  ${freshJevUsage.models.join(", ") || "unpriced model"} · checked ${freshJevUsage.pricingSnapshot.checkedAt}.`]
            : []),
          "Saved conversation history stays intact.",
          "",
          `Logs       ${logsDirectory}`,
          `           ${prefix}_{before,after,review}.json`,
        ], MODE_HELP),
        review.status === "error" ? "warning" : "info",
      );
    } catch {
      if (ctx.hasUI) ctx.ui.notify(statusCard("LOGGING FAILED", [`Mode       ${mode}`, `Removed    ${removedGroupIds.length} turns`, `Kept       ${diagnostic.keptTurnCount} turns`], ["Could not write logs. Returning the selected inference context."], MODE_HELP), "warning");
    }
    return { messages: virtualMessages };
  });
}
