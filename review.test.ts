import { test } from "node:test";
import assert from "node:assert/strict";
import { groupContext, buildReviewRequest, observeContext, reviewScopeFingerprint, TurnReviewMemo } from "./review.ts";
import { combineJevUsage, ContextPrefixTracker, estimateTokenImpact, recordDownstreamUsage, snapshotModelPricing, summarizeDownstreamUsage, summarizeJevUsage, summarizeTurnUsage } from "./telemetry.ts";
import { costSummaryBox, contextShareBar, contextShareLine, detailsBox, estimatedAvoidedLine, formatUsd, formatUsdRange, measuredPromptLine, metricConnector, statusCard, tokenEstimateLine } from "./display.ts";

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const messages = [
  { role: "custom", content: "preamble" },
  { role: "user", content: "Unrelated weather question" },
  { role: "assistant", content: [{ type: "toolCall", id: "a", name: "weather", arguments: { city: "Paris" } }, { type: "thinking", thinking: "private", signature: "secret" }], usage: { cost: 1 } },
  { role: "toolResult", toolCallId: "a", toolName: "weather", content: [{ type: "text", text: "Sunny" }] },
  { role: "user", content: "Project context" },
  { role: "compactionSummary", summary: "Use TypeScript" },
  { role: "user", content: "Implement the project" },
] as any;

test("groups preserve tool pairs and protect preamble, summaries and active turn", () => {
  const groups = groupContext(messages);
  assert.deepEqual(groups.map(g => g.protected), [true, false, true, true]);
  assert.equal(groups[1].messages.length, 3);
  assert.deepEqual(groups.flatMap(g => g.messages), messages);
  assert.deepEqual(groupContext([]), []);
});

test("review projection keeps semantic evidence and strips metadata", () => {
  const request = buildReviewRequest(groupContext(messages));
  const text = JSON.stringify(request);
  assert.match(text, /Sunny/);
  assert.match(text, /Use TypeScript/);
  assert.match(text, /weather/);
  assert.doesNotMatch(text, /secret|private|usage/);
  assert.deepEqual(Object.keys(request.questions), ["turn-001"]);
  assert.equal(request.state.activeTurnId, "turn-003");
});

test("valid batched response proposes removal without mutating original messages", async () => {
  const before = structuredClone(messages);
  const result = await observeContext(messages, { apiKey: "test", fetchImpl: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(JSON.parse(init!.body as string).questions["turn-001"].type, "noul");
    return Response.json({ answers: { "turn-001": { type: "noul", noul: 0.01 } } });
  } });
  assert.equal(result.status, "reviewed");
  assert.equal(result.jevApiCallCount, 1);
  assert.deepEqual(result.proposedRemovedGroupIds, ["turn-001"]);
  assert.deepEqual(messages, before);
});

test("threshold boundary and uncertain answers keep turns", async () => {
  for (const noul of [0.2, 0.5, 1]) {
    const result = await observeContext(messages, { apiKey: "test", fetchImpl: async () => Response.json({ answers: { "turn-001": { type: "noul", noul } } }) });
    assert.deepEqual(result.proposedRemovedGroupIds, []);
  }
});

test("missing key and empty context skip HTTP", async () => {
  const fetchImpl = async () => { throw new Error("must not call"); };
  assert.equal((await observeContext(messages, { fetchImpl })).status, "skipped");
  assert.equal((await observeContext(messages, { fetchImpl })).jevApiCallCount, 0);
  const empty = await observeContext([], { apiKey: "test", fetchImpl });
  assert.equal(empty.status, "skipped");
  assert.equal(empty.jevApiCallCount, 0);

});

test("HTTP, network and malformed responses fail open", async () => {
  for (const fetchImpl of [
    async () => new Response("unauthorized", { status: 401 }),
    async () => { throw new Error("network failure"); },
    async () => Response.json({ answers: {} }),
    async () => Response.json({ answers: { "turn-001": { type: "noul", noul: 2 } } }),
    async () => new Response("invalid JSON"),
  ]) {
    const result = await observeContext(messages, { apiKey: "test", fetchImpl });
    assert.equal(result.status, "error");
    assert.equal(result.jevApiCallCount, 1);
    assert.deepEqual(result.proposedRemovedGroupIds, []);
  }
});

test("timeout aborts the request", async () => {
  const keepAlive = setTimeout(() => {}, 100);
  try {
    const result = await observeContext(messages, { apiKey: "test", timeoutMs: 5, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    }) });
    assert.equal(result.status, "error");
    assert.equal(result.jevApiCallCount, 1);
  } finally { clearTimeout(keepAlive); }
});

test("configured threshold changes proposals and is recorded in the review", async () => {
  for (const [threshold, expected] of [[0.1, []], [0.2, ["turn-001"]], [0.13, []]] as const) {
    const result = await observeContext(messages, { apiKey: "test", threshold, fetchImpl: async () => Response.json({ answers: { "turn-001": { type: "noul", noul: 0.13 } } }) });
    assert.equal(result.status, "reviewed");
    assert.equal("threshold" in result && result.threshold, threshold);
    assert.deepEqual(result.proposedRemovedGroupIds, expected);
  }
});

test("configuration supports live edits and rejects invalid thresholds", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readThreshold } = await import("./config.ts");
  const directory = await mkdtemp(join(tmpdir(), "jev-config-"));
  const file = join(directory, "config.json");
  try {
    assert.equal(await readThreshold(directory), 0.2);
    for (const threshold of [0.2, 0.3, 0, 1]) {
      await writeFile(file, JSON.stringify({ removalThreshold: threshold }));
      assert.equal(await readThreshold(directory), threshold);
    }
    for (const value of ['{"removalThreshold":"0.2"}', '{"removalThreshold":-1}', '{"removalThreshold":1.1}', '{}', 'null', 'broken JSON']) {
      await writeFile(file, value);
      await assert.rejects(readThreshold(directory));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("active filtering removes complete turns, preserves references and ignores protected IDs", async () => {
  const { filterContext } = await import("./review.ts");
  const original = structuredClone(messages);
  const result = filterContext(messages, ["preamble", "turn-001", "turn-002", "turn-003", "unknown"]);
  assert.deepEqual(result.removedGroupIds, ["turn-001"]);
  assert.deepEqual(result.messages, [messages[0], ...messages.slice(4)]);
  assert.ok(result.messages.every(message => messages.includes(message)));
  assert.deepEqual(messages, original);
  assert.equal(filterContext(messages, []).messages, messages);
  assert.deepEqual(filterContext([], ["turn-001"]).messages, []);
  // A later inference can restore an earlier turn from the unchanged history.
  assert.equal(filterContext(messages, []).messages.length, original.length);
});

test("latest user request stays fixed as assistant tool activity expands", () => {
  const original = [
    { role: "user", content: "Build a game" },
    { role: "assistant", content: [{ type: "text", text: "Built it" }] },
    { role: "user", content: [{ type: "text", text: "Change the title to orange" }] },
  ] as any;
  const before = buildReviewRequest(groupContext(original));
  const after = buildReviewRequest(groupContext([...original,
    { role: "assistant", content: [{ type: "text", text: "I will also fix game startup" }] },
    { role: "toolResult", content: [{ type: "text", text: "Startup code" }] },
  ] as any));
  assert.equal(before.state.latestUserRequest, "Change the title to orange");
  assert.equal(after.state.latestUserRequest, before.state.latestUserRequest);
  assert.match(after.state.groups.at(-1)!.text, /fix game startup/);
  assert.equal(buildReviewRequest([]).state.latestUserRequest, "");
});

test("review scope ignores growing active-turn activity but detects changed review evidence", () => {
  const original = [
    { role: "user", content: "Use TypeScript" },
    { role: "assistant", content: [{ type: "text", text: "Noted" }] },
    { role: "user", content: "Implement the feature" },
  ] as any;
  const fingerprint = reviewScopeFingerprint(original);
  assert.equal(reviewScopeFingerprint([...original,
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: { path: "index.ts" } }] },
    { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "source" }] },
  ] as any), fingerprint);
  assert.notEqual(reviewScopeFingerprint([
    { role: "user", content: "Use JavaScript" },
    ...original.slice(1),
  ] as any), fingerprint);
  assert.notEqual(reviewScopeFingerprint([
    ...original.slice(0, -1),
    { role: "user", content: "Implement something else" },
  ] as any), fingerprint);
  assert.notEqual(reviewScopeFingerprint([
    ...original,
    { role: "user", content: "Unexpected new request" },
  ] as any), fingerprint);
});

test("turn review memo reuses only matching request scope and configuration", () => {
  const original = [
    { role: "user", content: "Historical context" },
    { role: "user", content: "Current request" },
  ] as any;
  const expanded = [...original,
    { role: "assistant", content: [{ type: "text", text: "Working" }] },
  ] as any;
  const memo = new TurnReviewMemo<{ proposedRemovedGroupIds: string[] }>();
  const decision = { proposedRemovedGroupIds: ["turn-001"] };
  memo.remember(original, "active:0.2", 1, decision);
  assert.deepEqual(memo.reuse(expanded, "active:0.2"), { value: decision, originCall: 1 });
  assert.equal(memo.reuse(expanded, "active:0.3"), undefined);
  assert.equal(memo.reuse([
    { role: "user", content: "Changed history" },
    original[1],
  ] as any, "active:0.2"), undefined);
  memo.reset();
  assert.equal(memo.reuse(original, "active:0.2"), undefined);
});


test("requests beyond the old character cutoff reach the API intact; rejection retains context", async () => {
  const text = "project history ".repeat(5000);
  const large = [{ role: "user", content: text }, { role: "user", content: "next" }] as any;
  let called = false;
  const result = await observeContext(large, { apiKey: "test", fetchImpl: async (_url, init) => {
    called = true;
    const body = JSON.parse(init!.body as string);
    assert.ok((init!.body as string).length > 60000);
    assert.equal(body.state.groups[0].text, `user: ${text}`);
    return Response.json({ answers: { "turn-001": { type: "noul", noul: 0.9 } } });
  } });
  assert.equal(called, true);
  assert.equal(result.status, "reviewed");
  for (const status of [413, 422]) {
    const rejected = await observeContext(large, { apiKey: "test", fetchImpl: async () => new Response("", { status }) });
    assert.equal(rejected.status, "error");
    assert.deepEqual(rejected.proposedRemovedGroupIds, []);
    assert.equal("reason" in rejected && rejected.reason, `http-${status}`);
  }
});

test("large histories batch with stable IDs and protected context; failed candidates stay", async () => {
  const history = [
    { role: "custom", content: "protected preamble" },
    { role: "user", content: "A".repeat(45000) },
    { role: "user", content: "B".repeat(45000) },
    { role: "user", content: "Change title" },
  ] as any;
  const seen: string[][] = [];
  const result = await observeContext(history, { apiKey: "test", fetchImpl: async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    const ids = Object.keys(request.questions);
    seen.push(ids);
    assert.equal(request.state.latestUserRequest, "Change title");
    assert.ok(request.state.groups.some((g: any) => g.id === "preamble"));
    assert.ok(request.state.groups.some((g: any) => g.id === "turn-003" && g.protected));
    if (ids.includes("turn-002")) return new Response("", { status: 401 });
    return Response.json({ answers: { "turn-001": { type: "noul", noul: 0.01 } } });
  } });
  assert.equal(seen.length, 2);
  assert.deepEqual(result.proposedRemovedGroupIds, ["turn-001"]);
  assert.equal("batchCount" in result && result.batchCount, 2);
  assert.ok("decisions" in result && result.decisions.some(d => d.id === "turn-002" && d.decision === "keep"));
});

test("API size rejection splits candidate batches and merges successful results", async () => {
  const history = [{role:"user",content:"old one"},{role:"user",content:"old two"},{role:"user",content:"current"}] as any;
  let calls = 0;
  const result = await observeContext(history, { apiKey: "test", fetchImpl: async (_url, init) => {
    calls++;
    const ids = Object.keys(JSON.parse(init!.body as string).questions);
    if (ids.length > 1) return new Response("", { status: 422 });
    return Response.json({ answers: { [ids[0]]: { type: "noul", noul: 0.01 } } });
  } });
  assert.equal(calls, 3);
  assert.equal(result.jevApiCallCount, 3);
  assert.deepEqual(result.proposedRemovedGroupIds, ["turn-001", "turn-002"]);
});

test("prefix telemetry detects append-only context and the first changed message", () => {
  const tracker = new ContextPrefixTracker();
  const first = [{ role: "user", content: "one" }] as any;
  const baseline = tracker.observe(first);
  assert.equal(baseline.historicalPrefixUnchanged, null);
  const appended = tracker.observe([...first, { role: "assistant", content: [] }] as any);
  assert.equal(appended.historicalPrefixUnchanged, true);
  assert.equal(appended.matchingPrefixMessageCount, 1);
  assert.equal(appended.appendedMessageCount, 1);
  const changed = tracker.observe([
    { role: "user", content: "changed" },
    { role: "assistant", content: [] },
  ] as any);
  assert.equal(changed.historicalPrefixUnchanged, false);
  assert.equal(changed.firstChangedMessageIndex, 0);
  assert.equal(changed.appendedMessageCount, null);
});

test("downstream telemetry separates cached and uncached provider input", () => {
  const telemetry = summarizeDownstreamUsage({
    role: "assistant", provider: "example", model: "model", content: [],
    usage: {
      input: 200, output: 20, cacheRead: 700, cacheWrite: 100, cacheWrite1h: 40,
      totalTokens: 1020,
      cost: { input: 2, output: 0.2, cacheRead: 0.7, cacheWrite: 1.25, total: 4.15 },
    },
  } as any);
  assert.equal(telemetry.status, "reported");
  assert.equal(telemetry.cachedInputTokens, 700);
  assert.equal(telemetry.uncachedInputTokens, 300);
  assert.equal(telemetry.promptTokens, 1000);
  assert.equal(telemetry.cacheHitRatePercent, 70);
  assert.equal(telemetry.cacheWrite1hTokens, 40);
  assert.deepEqual(summarizeDownstreamUsage({ role: "user", content: "no usage" } as any), { status: "unavailable" });
});

test("Pi token estimates partition removed and retained messages", () => {
  const before = [
    { role: "user", content: "a".repeat(400) },
    { role: "assistant", content: [{ type: "text", text: "b".repeat(200) }] },
  ] as any;
  const estimate = estimateTokenImpact(before, [before[1]], message => {
    const content = message.role === "user" ? message.content : message.content[0].text;
    return Math.ceil(content.length / 4);
  });
  assert.equal(estimate.method, "pi-estimateTokens-chars-div-4");
  assert.equal(estimate.removedTokens, 100);
  assert.equal(estimate.keptTokens, 50);
  assert.equal(estimate.originalTokens, 150);
  assert.equal(estimate.removedPercent, 66.7);
  assert.equal(estimate.keptPercent, 33.3);
});

test("Jev telemetry aggregates batch usage and prices only known model versions", () => {
  const summary = summarizeJevUsage({
    jevApiCallCount: 2,
    batches: [
      { review: { model: "jev-1.13.0", usage: { input_tokens: 20_631, output_tokens: 44 } } },
      { review: { model: "jev-1.13.0", usage: { input_tokens: 25_882, output_tokens: 84 } } },
    ],
  });
  assert.equal(summary.status, "reported");
  assert.equal(summary.reportedCalls, 2);
  assert.equal(summary.inputTokens, 46_513);
  assert.equal(summary.outputTokens, 128);
  assert.equal(summary.reportedCostUsd, 0.001953546);
  assert.equal(summary.costComplete, true);
  assert.equal(combineJevUsage([summary]).reportedCostUsd, 0.001953546);

  const unknown = summarizeJevUsage({
    jevApiCallCount: 1,
    model: "jev-future",
    usage: { input_tokens: 1_000, output_tokens: 10 },
  });
  assert.equal(unknown.inputTokens, 1_000);
  assert.equal(unknown.unpricedReportedCalls, 1);
  assert.equal(unknown.reportedCostUsd, 0);
  assert.equal(unknown.costComplete, false);
});

test("turn telemetry compares actual prompt usage with estimated unpruned calls", () => {
  const usage = summarizeDownstreamUsage({
    role: "assistant", provider: "example", model: "model", content: [],
    usage: {
      input: 200, output: 20, cacheRead: 700, cacheWrite: 100, totalTokens: 1020,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as any);
  const summary = summarizeTurnUsage([
    {
      inferenceCall: 1,
      estimate: {
        method: "pi-estimateTokens-chars-div-4", removedTokens: 500, keptTokens: 1_000,
        originalTokens: 1_500, removedPercent: 33.3, keptPercent: 66.7,
      },
      usage,
    },
  ]);
  assert.equal(summary.status, "reported");
  assert.equal(summary.actualPromptTokens, 1_000);
  assert.equal(summary.estimatedAvoidedTokens, 500);
  assert.equal(summary.estimatedWithoutPruningTokens, 1_500);
  assert.equal(summary.estimatedReductionPercent, 33.3);
  assert.equal(summary.cacheHitRatePercent, 70);
});

test("turn cost telemetry applies Pi model rates and reports a savings range", () => {
  const usage = summarizeDownstreamUsage({
    role: "assistant", provider: "example", model: "model", content: [],
    usage: {
      input: 200, output: 20, cacheRead: 700, cacheWrite: 100, totalTokens: 1020,
      cost: { input: 0.0006, output: 0.0003, cacheRead: 0.00021, cacheWrite: 0.000375, total: 0.001485 },
    },
  } as any);
  const pricing = snapshotModelPricing({
    provider: "example", id: "model",
    cost: {
      input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
      tiers: [{ inputTokensAbove: 1_200, input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 }],
    },
  });
  const summary = summarizeTurnUsage([{
    inferenceCall: 1,
    estimate: {
      method: "pi-estimateTokens-chars-div-4", removedTokens: 500, keptTokens: 1_000,
      originalTokens: 1_500, removedPercent: 33.3, keptPercent: 66.7,
    },
    usage,
    pricing,
  }]);
  assert.equal(summary.status, "reported");
  assert.equal(summary.actualDownstreamCostUsd, 0.001485);
  assert.equal(summary.estimatedGrossSavingsLowUsd, 0.0003);
  assert.equal(summary.estimatedGrossSavingsLikelyUsd, 0.0003);
  assert.equal(summary.estimatedGrossSavingsHighUsd, 0.00375);
  assert.equal(summary.estimatedWithoutPruningCostLikelyUsd, 0.001785);
});

test("completed downstream usage updates the matching review log", async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "pi-saver-telemetry-"));
  const logPath = join(directory, "review.json");
  try {
    await writeFile(logPath, JSON.stringify({ downstreamUsage: { status: "pending", inferenceCall: 2 } }));
    await recordDownstreamUsage(logPath, 2, {
      role: "assistant", provider: "example", model: "model", content: [],
      usage: {
        input: 20, output: 2, cacheRead: 80, cacheWrite: 0, totalTokens: 102,
        cost: { input: 0.02, output: 0.02, cacheRead: 0.008, cacheWrite: 0, total: 0.048 },
      },
    } as any);
    const logged = JSON.parse(await readFile(logPath, "utf8"));
    assert.equal(logged.downstreamUsage.status, "reported");
    assert.equal(logged.downstreamUsage.inferenceCall, 2);
    assert.equal(logged.downstreamUsage.cachedInputTokens, 80);
    assert.equal(logged.downstreamUsage.uncachedInputTokens, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("context percentages partition retained and removed text without counting metadata", async () => {
  const { measureContextShare, filterContext } = await import("./review.ts");
  const kept = filterContext(messages, ["turn-001"]).messages;
  const estimate = measureContextShare(messages, kept);
  assert.ok(estimate.removedCharacters > 0);
  assert.ok(estimate.keptCharacters > 0);
  assert.equal(estimate.totalCharacters, estimate.removedCharacters + estimate.keptCharacters);
  assert.equal(estimate.removedPercent + estimate.keptPercent, 100);
  assert.equal(measureContextShare(messages, messages).keptPercent, 100);
  assert.equal(measureContextShare(messages, []).removedPercent, 100);
  assert.equal(measureContextShare([], []).keptPercent, 0);
  assert.equal(measureContextShare(messages, messages).removedCharacters, 0);
  assert.equal(measureContextShare([], []).totalCharacters, 0);
  const withMetadata = messages.map((m: any) => ({ ...m, usage: { tokens: 999999 }, signature: "x".repeat(10000) }));
  assert.equal(measureContextShare(withMetadata, withMetadata).totalCharacters, estimate.totalCharacters);
});

test("status display renders a colored context bar, metric connector and aligned details box", () => {
  const bar = contextShareBar(72.4);
  assert.equal(stripAnsi(bar).trim().length, 40);
  assert.match(bar, /\x1b\[38;5;114m/);
  assert.match(bar, /\x1b\[97m/);
  assert.equal(stripAnsi(metricConnector()).trim(), "│");
  assert.match(contextShareLine(72.4, 27.6), /72\.4% removed/);
  assert.match(tokenEstimateLine(12_400, 4_700), /~12k removed.*~4\.7k sent/);
  assert.match(measuredPromptLine(4_700, 17_100), /4\.7k actual.*~17k without pruning/);
  assert.match(estimatedAvoidedLine(12_400, 72.5), /~12k tokens.*72\.5% estimated/);
  assert.equal(formatUsd(0.001953546), "$0.00195");
  assert.equal(formatUsd(-0.00042), "-$0.000420");
  assert.equal(formatUsdRange(0.001, 0.002), "$0.00100–$0.00200");

  const costs = costSummaryBox({
    estimatedWithoutUsd: 0.0161,
    actualTotalUsd: 0.00812,
    modelUsd: 0.00552,
    jevUsd: 0.0026,
    netSavingsUsd: 0.00794,
    savingsPercent: 49,
  });
  assert.ok(costs.every((line) => stripAnsi(line).length === 74));
  assert.match(stripAnsi(costs.join("\n")), /Without PI-Saver.*~\$0\.0161 estimated/);
  assert.match(stripAnsi(costs.join("\n")), /You paid.*\$0\.00812.*\$0\.00552 model \+ \$0\.00260 Jev/);
  assert.match(stripAnsi(costs.join("\n")), /YOU SAVED.*~\$0\.00794 · 49%/);

  const box = detailsBox(["Saved conversation history stays intact.", "", "Logs       /a/long/path"]);
  assert.ok(stripAnsi(box[0]).startsWith("┌─ DETAILS "));
  assert.ok(stripAnsi(box.at(-1)!).startsWith("└"));
  assert.ok(box.every((line) => stripAnsi(line).length === 74));
  assert.match(stripAnsi(box.join("\n")), /Logs       \/a\/long\/path/);

  const card = statusCard(
    "RUNNING",
    ["Mode       Active", contextShareBar(50)],
    ["Details"],
    ["Mode help"],
  );
  assert.match(stripAnsi(card), /PI-Saver · RUNNING/);
  assert.match(stripAnsi(card), /DETAILS/);
});

test("system and developer messages protect their entire historical turn", async () => {
  const { filterContext } = await import("./review.ts");
  for (const role of ["system", "developer"]) {
    const history = [{ role: "user", content: "old" }, { role, content: "instructions" }, { role: "user", content: "current" }] as any;
    assert.deepEqual(filterContext(history, ["turn-001", "turn-002"]).messages, history);
  }
});
