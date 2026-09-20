import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_REMOVAL_THRESHOLD = 0.2;

export function isValidThreshold(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

export interface FilterConfig {
  mode: "observe" | "active" | "off";
  removalThreshold: number;
}

export async function readConfig(
  directory: string = EXTENSION_DIRECTORY,
): Promise<FilterConfig> {
  let text: string;
  try {
    text = await readFile(join(directory, "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { mode: "observe", removalThreshold: DEFAULT_REMOVAL_THRESHOLD };
    throw error;
  }
  const config = JSON.parse(text);
  if (!isValidThreshold(config?.removalThreshold))
    throw new Error("invalid-config");
  const mode = config.mode ?? "observe";
  if (mode !== "observe" && mode !== "active" && mode !== "off")
    throw new Error("invalid-config");
  return { mode, removalThreshold: config.removalThreshold };
}

export async function readThreshold(
  directory: string = EXTENSION_DIRECTORY,
): Promise<number> {
  return (await readConfig(directory)).removalThreshold;
}
