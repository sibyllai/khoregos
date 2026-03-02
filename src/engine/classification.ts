import picomatch from "picomatch";
import type {
  ClassificationConfig,
  ClassificationLevel,
} from "../models/config.js";

const LEVEL_RANK: Record<ClassificationLevel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

type CompiledRule = {
  level: ClassificationLevel;
  matchers: Array<(path: string) => boolean>;
};

export class ClassificationResolver {
  private readonly compiledRules: CompiledRule[];

  constructor(private readonly rules: ClassificationConfig[]) {
    this.compiledRules = rules.map((rule) => ({
      level: rule.level,
      matchers: rule.paths.map((pattern) => picomatch(pattern, { dot: true })),
    }));
  }

  classify(filePath: string): ClassificationLevel {
    for (const rule of this.compiledRules) {
      if (rule.matchers.some((match) => match(filePath))) {
        return rule.level;
      }
    }
    return "public";
  }

  classifyMany(filePaths: string[]): { level: ClassificationLevel; files: string[] }[] {
    const grouped = new Map<ClassificationLevel, string[]>();
    for (const filePath of filePaths) {
      const level = this.classify(filePath);
      const bucket = grouped.get(level) ?? [];
      bucket.push(filePath);
      grouped.set(level, bucket);
    }
    return [...grouped.entries()]
      .sort((a, b) => LEVEL_RANK[b[0]] - LEVEL_RANK[a[0]])
      .map(([level, files]) => ({ level, files }));
  }

  highestLevel(filePaths: string[]): ClassificationLevel {
    let highest: ClassificationLevel = "public";
    for (const filePath of filePaths) {
      const level = this.classify(filePath);
      if (LEVEL_RANK[level] > LEVEL_RANK[highest]) {
        highest = level;
      }
    }
    return highest;
  }
}
