import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export type DependencyChange = {
  type: "added" | "removed" | "updated";
  name: string;
  oldVersion?: string;
  newVersion?: string;
};

function parseJsonObject(raw: string, source: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[k6s] warning: failed to parse ${source}: ${message}\n`);
    return null;
  }
}

function asDependencyMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version === "string") out[name] = version;
  }
  return out;
}

function getAllDeclaredDependencies(pkg: Record<string, unknown>): Record<string, string> {
  return {
    ...(asDependencyMap(pkg.dependencies) ?? {}),
    ...(asDependencyMap(pkg.devDependencies) ?? {}),
  };
}

export function diffDeps(
  oldDeps: Record<string, string> | undefined,
  newDeps: Record<string, string> | undefined,
): DependencyChange[] {
  const oldMap = oldDeps ?? {};
  const newMap = newDeps ?? {};
  const changes: DependencyChange[] = [];

  for (const [name, newVersion] of Object.entries(newMap)) {
    if (!(name in oldMap)) {
      changes.push({ type: "added", name, newVersion });
      continue;
    }
    const oldVersion = oldMap[name];
    if (oldVersion !== newVersion) {
      changes.push({ type: "updated", name, oldVersion, newVersion });
    }
  }

  for (const [name, oldVersion] of Object.entries(oldMap)) {
    if (!(name in newMap)) {
      changes.push({ type: "removed", name, oldVersion });
    }
  }

  return changes;
}

export function detectDependencyChanges(
  filePath: string,
  projectRoot: string,
): DependencyChange[] {
  if (path.basename(filePath) !== "package.json") return [];

  let currentRaw: string;
  try {
    currentRaw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const currentPkg = parseJsonObject(currentRaw, filePath);
  if (!currentPkg) return [];

  const relativePath = path.isAbsolute(filePath) ? path.relative(projectRoot, filePath) : filePath;

  let previousPkg: Record<string, unknown> | null = null;
  try {
    const previousRaw = execFileSync("git", ["show", `HEAD:${relativePath}`], {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    previousPkg = parseJsonObject(previousRaw, `HEAD:${relativePath}`);
    if (!previousPkg) return [];
  } catch {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: projectRoot,
        stdio: "ignore",
      });
    } catch {
      return [];
    }
    const allCurrent = getAllDeclaredDependencies(currentPkg);
    return Object.entries(allCurrent).map(([name, newVersion]) => ({
      type: "added",
      name,
      newVersion,
    }));
  }

  const oldDeps = asDependencyMap(previousPkg.dependencies);
  const oldDevDeps = asDependencyMap(previousPkg.devDependencies);
  const newDeps = asDependencyMap(currentPkg.dependencies);
  const newDevDeps = asDependencyMap(currentPkg.devDependencies);

  return [...diffDeps(oldDeps, newDeps), ...diffDeps(oldDevDeps, newDevDeps)];
}
