import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { observeContext, filterContext, measureContextShare } from "./review.ts";
import { readConfig, EXTENSION_DIRECTORY, type FilterConfig } from "./config.ts";

const MAX_LOG_FILES = 9;
const FILES_WRITTEN_PER_INFERENCE = 3;

const ANSI = {
  reset: "\x1b[0m",
  title: "\x1b[1;36m",
  label: "\x1b[1;35m",
  value: "\x1b[97m",
  running: "\x1b[1;32m",
  warning: "\x1b[1;33m",
  error: "\x1b[1;31m",
};

function color(text: string, style: string): string {
  return `${style}${text}${ANSI.reset}`;
}

function statusColor(status: string): string {
  if (status.includes("ERROR") || status.includes("FAILED")) return ANSI.error;
  if (status.includes("OFF") || status.includes("SKIPPED")) return ANSI.warning;
  return ANSI.running;
}

function emphasizeField(line: string): string {
  const match = line.match(/^(Mode|Threshold)(\s+)(.*)$/);
  if (!match) return line;
  return `${color(match[1], ANSI.label)}${match[2]}${color(match[3], ANSI.value)}`;
}

const MODE_HELP = [
  `Change mode · ${join(EXTENSION_DIRECTORY, "config.json")}`,
  '  "mode": "active"   Remove irrelevant turns',
  '  "mode": "observe"  Preview only; keep all context',
  '  "mode": "off"      TURN OFF Jev calls and filtering',
  "",
  "Save the file. Changes apply on the next message.",
  "No reload needed. Off mode also stops context logging.",
].join("\n");

function statusCard(status: string, lines: string[]): string {
  return [
    `${color("PI-Saver", ANSI.title)} · ${color(status, statusColor(status))}`,
    "────────────────────────────────────────",
    ...lines.map(emphasizeField),
    "",
    MODE_HELP,
  ].join("\n");
}

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
  const contextLogNames = entries
    .filter(
      (entry) =>
        entry.isFile() && /_turn-\d+_(?:before|after|review)\.json$/.test(entry.name),
    )
    .map((entry) => entry.name);

  const contextLogs = await Promise.all(
    contextLogNames.map(async (name) => ({
      name,
      modifiedAt: (await stat(join(logsDirectory, name))).mtimeMs,
    })),
  );
  contextLogs.sort(
    (left, right) =>
      left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name),
  );

  const availableBeforeWrite = MAX_LOG_FILES - FILES_WRITTEN_PER_INFERENCE;
  const deleteCount = Math.max(0, contextLogs.length - availableBeforeWrite);
  await Promise.all(
    contextLogs
      .slice(0, deleteCount)
      .map(({ name }) => unlink(join(logsDirectory, name))),
  );
}

/** Review context, optionally applying whole-turn removals for this inference. */
export default function piSaver(pi: ExtensionAPI) {
  let inferenceCall = 0;
  let announcedConfig = "";
  function announce(config: FilterConfig, ctx: ExtensionContext) {
    const signature = JSON.stringify(config);
    if (!ctx.hasUI || signature === announcedConfig) return;
    announcedConfig = signature;
    ctx.ui.notify(statusCard(config.mode === "off" ? "OFF" : "RUNNING", [
      `Mode       ${config.mode === "active" ? "Active — removal enabled" : config.mode === "observe" ? "Observer — preview only" : "Off — disabled"}`,
      `Threshold  ${config.removalThreshold}`,
      "",
      config.mode === "off" ? "Full context retained. No Jev calls or new logs."
        : config.mode === "active" ? "Irrelevant turns are removed from this inference only."
        : "Removal decisions are logged. Full context is retained.",
      "Saved conversation history stays intact.",
    ]), "info");
  }
  pi.on("session_start", async (_event, ctx) => {
    announcedConfig = "";
    try { announce(await readConfig(), ctx); }
    catch {
      if (ctx.hasUI) ctx.ui.notify(statusCard("CONFIGURATION ERROR", ["Full context retained; review is disabled.", "Fix the JSON configuration and set removalThreshold from 0 to 1."]), "warning");
    }
  });
  pi.on("before_agent_start", () => { inferenceCall = 0; });
  pi.on("context", async (event, ctx) => {
    const call = ++inferenceCall;
    let review: Awaited<ReturnType<typeof observeContext>>;
    let mode: FilterConfig["mode"] = "observe";
    let virtualMessages = event.messages;
    let removedGroupIds: string[] = [];
    let failureReason = "invalid-config";
    try {
      const config = await readConfig();
      mode = config.mode;
      announce(config, ctx);
      if (mode === "off") return { messages: event.messages };
      failureReason = "filter-failed";
      review = await observeContext(event.messages, { apiKey: await readApiKey(), threshold: config.removalThreshold });
      if (mode === "active" && review.status === "reviewed") {
        const filtered = filterContext(event.messages, review.proposedRemovedGroupIds);
        virtualMessages = filtered.messages;
        removedGroupIds = filtered.removedGroupIds;
      }
    } catch {
      virtualMessages = event.messages;
      removedGroupIds = [];
      review = { mode, status: "error", reason: failureReason, proposedRemovedGroupIds: [] };
    }
    const diagnostic = {
      ...review, mode, removedGroupIds,
      removedMessageCount: event.messages.length - virtualMessages.length,
      keptMessageCount: virtualMessages.length,
      keptTurnCount: virtualMessages.filter(message => message.role === "user").length,
    };
    try {
      const contextShare = measureContextShare(event.messages, virtualMessages);
      const loggedDiagnostic = { ...diagnostic, contextShare };
      const logsDirectory = join(EXTENSION_DIRECTORY, "logs");
      const prefix = `${new Date().toISOString().replaceAll(":", "-")}_turn-${String(call).padStart(3, "0")}`;
      await mkdir(logsDirectory, { recursive: true });
      await makeRoomForContextLogs(logsDirectory);
      await Promise.all([
        ["before", event.messages], ["after", virtualMessages], ["review", loggedDiagnostic],
      ].map(([suffix, value]) => writeFile(join(logsDirectory, `${prefix}_${suffix}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf8")));
      if (ctx.hasUI) ctx.ui.notify(
        statusCard(review.status === "reviewed" ? "RUNNING" : review.status === "error" ? "REVIEW FAILED" : "REVIEW SKIPPED", [
          `Mode       ${mode === "active" ? "Active — removal enabled" : "Observer — preview only"}`,
          `Review     #${call} · ${review.status}${"reason" in review ? ` (${review.reason})` : ""}`,
          ...("threshold" in review ? [`Threshold  ${review.threshold}`] : []),
          ...("batchCount" in review ? [`Batches    ${review.batchCount} API requests`] : []),
          "",
          mode === "active"
            ? `Removed    ${removedGroupIds.length} turns · ${diagnostic.removedMessageCount} messages`
            : `Proposed   ${review.proposedRemovedGroupIds.length} turns to remove (not applied)`,
          `Kept       ${diagnostic.keptTurnCount} turns · ${diagnostic.keptMessageCount} messages`,
          `Context    ${contextShare.removedPercent.toFixed(1)}% removed · ${contextShare.keptPercent.toFixed(1)}% kept (by text size)`,
          "Excludes images, thinking and external system prompt.",
          "Saved conversation history stays intact.",
          "",
          `Logs       ${logsDirectory}`,
          `           ${prefix}_{before,after,review}.json`,
        ]),
        review.status === "error" ? "warning" : "info",
      );
    } catch {
      if (ctx.hasUI) ctx.ui.notify(statusCard("LOGGING FAILED", [`Mode       ${mode}`, `Removed    ${removedGroupIds.length} turns`, `Kept       ${diagnostic.keptTurnCount} turns`, "Could not write logs. Returning the selected inference context."]), "warning");
    }
    return { messages: virtualMessages };
  });
}
