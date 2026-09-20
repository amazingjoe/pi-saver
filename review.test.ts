import { test } from "node:test";
import assert from "node:assert/strict";
import { groupContext, buildReviewRequest, observeContext } from "./review.ts";

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
  assert.deepEqual(result.proposedRemovedGroupIds, ["turn-001"]);
  assert.deepEqual(messages, before);
});

test("threshold boundary and uncertain answers keep turns", async () => {
  for (const noul of [0.1, 0.5, 1]) {
    const result = await observeContext(messages, { apiKey: "test", fetchImpl: async () => Response.json({ answers: { "turn-001": { type: "noul", noul } } }) });
    assert.deepEqual(result.proposedRemovedGroupIds, []);
  }
});

test("missing key and empty context skip HTTP", async () => {
  const fetchImpl = async () => { throw new Error("must not call"); };
  assert.equal((await observeContext(messages, { fetchImpl })).status, "skipped");
  assert.equal((await observeContext([], { apiKey: "test", fetchImpl })).status, "skipped");

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
    assert.equal(await readThreshold(directory), 0.1);
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
  assert.deepEqual(result.proposedRemovedGroupIds, ["turn-001", "turn-002"]);
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

test("system and developer messages protect their entire historical turn", async () => {
  const { filterContext } = await import("./review.ts");
  for (const role of ["system", "developer"]) {
    const history = [{ role: "user", content: "old" }, { role, content: "instructions" }, { role: "user", content: "current" }] as any;
    assert.deepEqual(filterContext(history, ["turn-001", "turn-002"]).messages, history);
  }
});
