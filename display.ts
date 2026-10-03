export const ANSI = {
  reset: "\x1b[0m",
  title: "\x1b[1;36m",
  label: "\x1b[1;35m",
  value: "\x1b[97m",
  actual: "\x1b[97m",
  cached: "\x1b[38;5;75m",
  saved: "\x1b[38;5;114m",
  estimated: "\x1b[38;5;221m",
  running: "\x1b[1;32m",
  warning: "\x1b[1;33m",
  error: "\x1b[1;31m",
  removed: "\x1b[38;5;114m",
  kept: "\x1b[97m",
  structure: "\x1b[38;5;244m",
};

export function color(text: string, style: string): string {
  return text ? `${style}${text}${ANSI.reset}` : "";
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

const BAR_WIDTH = 40;
const VALUE_INDENT = "           ";
const BOX_INNER_WIDTH = 72;
const BOX_TEXT_WIDTH = BOX_INNER_WIDTH - 2;

export function contextShareLine(removedPercent: number, keptPercent: number): string {
  return `Context    ${color(`${removedPercent.toFixed(1)}% removed`, ANSI.removed)} · ${color(`${keptPercent.toFixed(1)}% kept`, ANSI.kept)} (by text size)`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  return String(tokens);
}

export function formatUsd(value: number): string {
  const absolute = Math.abs(value);
  const digits = absolute >= 1 ? 2 : absolute >= 0.01 ? 4 : absolute >= 0.001 ? 5 : 6;
  return `${value < 0 ? "-" : ""}$${absolute.toFixed(digits)}`;
}

export function formatUsdRange(low: number, high: number): string {
  if (Math.abs(low - high) < 1e-12) return formatUsd(low);
  return low < 0 || high < 0 ? `${formatUsd(low)} to ${formatUsd(high)}` : `${formatUsd(low)}–${formatUsd(high)}`;
}

export function tokenEstimateLine(removedTokens: number, keptTokens: number): string {
  return `Tokens     ${color(`~${formatTokenCount(removedTokens)} removed`, ANSI.removed)} · ${color(`~${formatTokenCount(keptTokens)} sent`, ANSI.kept)} (Pi estimate)`;
}

export function measuredPromptLine(actualTokens: number, estimatedWithoutPruningTokens: number): string {
  return `Prompt     ${color(`${formatTokenCount(actualTokens)} actual`, ANSI.actual)} · ${color(`~${formatTokenCount(estimatedWithoutPruningTokens)} without pruning`, ANSI.estimated)}`;
}

export function estimatedAvoidedLine(tokens: number, percent: number): string {
  return `Avoided    ${color(`~${formatTokenCount(tokens)} tokens · ${percent.toFixed(1)}% estimated`, ANSI.saved)}`;
}

export function contextShareBar(removedPercent: number): string {
  const bounded = Math.min(100, Math.max(0, removedPercent));
  const removedCells = Math.round(bounded / 100 * BAR_WIDTH);
  const keptCells = BAR_WIDTH - removedCells;
  return `${VALUE_INDENT}${color("━".repeat(removedCells), ANSI.removed)}${color("━".repeat(keptCells), ANSI.kept)}`;
}

export function metricConnector(): string {
  return `${VALUE_INDENT}${color("│", ANSI.structure)}`;
}

export interface CostSummaryValues {
  estimatedWithoutUsd?: number;
  actualTotalUsd: number;
  modelUsd: number;
  jevUsd: number;
  netSavingsUsd?: number;
  savingsPercent?: number;
}

function approximateUsd(value: number): string {
  const formatted = formatUsd(value);
  return value < 0 ? `-~${formatted.slice(1)}` : `~${formatted}`;
}

function costBoxRow(parts: Array<{ text: string; style?: string }>): string {
  const visibleLength = parts.reduce((total, part) => total + part.text.length, 0);
  const padding = " ".repeat(Math.max(0, BOX_TEXT_WIDTH - visibleLength));
  return `${color("│", ANSI.structure)} ${parts.map(part => part.style ? color(part.text, part.style) : part.text).join("")}${padding} ${color("│", ANSI.structure)}`;
}

/** Render a compact ledger: counterfactual, actual bill, then the net result. */
export function costSummaryBox(values: CostSummaryValues): string[] {
  const labelWidth = 22;
  const title = "─ COST SUMMARY ";
  const lines = [
    color(`┌${title}${"─".repeat(BOX_INNER_WIDTH - title.length)}┐`, ANSI.structure),
  ];
  if (values.estimatedWithoutUsd !== undefined) {
    lines.push(costBoxRow([
      { text: "Without PI-Saver".padEnd(labelWidth) },
      { text: approximateUsd(values.estimatedWithoutUsd), style: ANSI.estimated },
      { text: " estimated", style: ANSI.structure },
    ]));
  }
  lines.push(costBoxRow([
    { text: "You paid".padEnd(labelWidth) },
    { text: formatUsd(values.actualTotalUsd), style: ANSI.actual },
    { text: "  ·  ", style: ANSI.structure },
    { text: formatUsd(values.modelUsd), style: ANSI.actual },
    { text: " model + ", style: ANSI.structure },
    { text: formatUsd(values.jevUsd), style: ANSI.actual },
    { text: " Jev", style: ANSI.structure },
  ]));
  if (values.netSavingsUsd !== undefined) {
    const saved = values.netSavingsUsd >= 0;
    const percentage = values.savingsPercent === undefined ? "" : ` · ${Math.abs(values.savingsPercent)}%`;
    lines.push(
      color(`├${"─".repeat(BOX_INNER_WIDTH)}┤`, ANSI.structure),
      costBoxRow([
        { text: (saved ? "YOU SAVED" : "EXTRA COST").padEnd(labelWidth), style: saved ? ANSI.saved : ANSI.warning },
        { text: approximateUsd(Math.abs(values.netSavingsUsd)), style: saved ? ANSI.saved : ANSI.warning },
        { text: percentage, style: saved ? ANSI.saved : ANSI.warning },
      ]),
    );
  }
  lines.push(color(`└${"─".repeat(BOX_INNER_WIDTH)}┘`, ANSI.structure));
  return lines;
}

function wrapBoxLine(line: string): string[] {
  if (!line) return [""];
  if (line.length <= BOX_TEXT_WIDTH) return [line];
  const leading = line.match(/^\s*/)?.[0] ?? "";
  const width = Math.max(1, BOX_TEXT_WIDTH - leading.length);
  const words = line.trim().split(/\s+/);
  const output: string[] = [];
  let current = leading;
  for (const word of words) {
    const chunks = word.match(new RegExp(`.{1,${width}}`, "g")) ?? [word];
    for (const chunk of chunks) {
      const separator = current.trim() ? " " : "";
      if (current.length + separator.length + chunk.length > BOX_TEXT_WIDTH) {
        output.push(current);
        current = `${leading}${chunk}`;
      } else {
        current += `${separator}${chunk}`;
      }
    }
  }
  if (current || !output.length) output.push(current);
  return output;
}

export function detailsBox(lines: string[]): string[] {
  const title = "─ DETAILS ";
  const content = lines.flatMap(wrapBoxLine);
  return [
    color(`┌${title}${"─".repeat(BOX_INNER_WIDTH - title.length)}┐`, ANSI.structure),
    ...content.map((line) => `${color("│", ANSI.structure)} ${line.padEnd(BOX_TEXT_WIDTH)} ${color("│", ANSI.structure)}`),
    color(`└${"─".repeat(BOX_INNER_WIDTH)}┘`, ANSI.structure),
  ];
}

export function statusCard(
  status: string,
  summaryLines: string[],
  detailLines: string[],
  modeHelpLines: string[],
): string {
  const boxedLines = [
    ...detailLines,
    ...(detailLines.length && modeHelpLines.length ? [""] : []),
    ...modeHelpLines,
  ];
  return [
    `${color("PI-Saver", ANSI.title)} · ${color(status, statusColor(status))}`,
    color("─".repeat(40), ANSI.structure),
    ...summaryLines.map(emphasizeField),
    "",
    ...detailsBox(boxedLines),
  ].join("\n");
}
