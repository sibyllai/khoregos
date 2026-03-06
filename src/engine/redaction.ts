/**
 * PII redaction engine for transcript content.
 *
 * Two-pass approach:
 *   1. Regex patterns — configurable rules for structured PII (emails, phones, etc.)
 *   2. NER via compromise — catches person names, locations, and organizations
 *      that regex patterns miss.
 */

import nlp from "compromise";
import type { RedactionPattern } from "../models/config.js";

export interface RedactionResult {
  text: string;
  redacted: boolean;
  patternsMatched: string[];
}

/**
 * Apply regex-based redaction patterns to a text string.
 * Returns the redacted text and metadata about which patterns matched.
 */
export function redactText(
  text: string,
  patterns: RedactionPattern[],
): RedactionResult {
  let result = text;
  let redacted = false;
  const patternsMatched: string[] = [];

  for (const pat of patterns) {
    try {
      const re = new RegExp(pat.pattern, "gi");
      const before = result;
      result = result.replace(re, pat.replacement);
      if (result !== before) {
        redacted = true;
        patternsMatched.push(pat.name);
      }
    } catch {
      // Skip invalid patterns silently.
    }
  }

  return { text: result, redacted, patternsMatched };
}

/**
 * Apply NER-based redaction using compromise.
 * Replaces person names, locations, and organizations with placeholders.
 */
export function redactNER(text: string): RedactionResult {
  const doc = nlp(text);
  let redacted = false;
  const patternsMatched: string[] = [];

  const people = doc.people();
  if (people.found) {
    people.replaceWith("[PERSON]");
    redacted = true;
    patternsMatched.push("ner:person");
  }

  const places = doc.places();
  if (places.found) {
    places.replaceWith("[LOCATION]");
    redacted = true;
    patternsMatched.push("ner:location");
  }

  const orgs = doc.organizations();
  if (orgs.found) {
    orgs.replaceWith("[ORG]");
    redacted = true;
    patternsMatched.push("ner:organization");
  }

  return { text: doc.text(), redacted, patternsMatched };
}

/**
 * Full redaction pipeline: regex patterns first, then NER.
 * The two-pass approach ensures structured PII (emails, SSNs) is caught
 * by precise regex, while names and locations are caught by NER.
 */
export function redactFull(
  text: string,
  patterns: RedactionPattern[],
  opts?: { ner?: boolean },
): RedactionResult {
  // Pass 1: regex patterns.
  const regexResult = redactText(text, patterns);

  // Pass 2: NER (enabled by default).
  if (opts?.ner === false) {
    return regexResult;
  }

  const nerResult = redactNER(regexResult.text);

  return {
    text: nerResult.text,
    redacted: regexResult.redacted || nerResult.redacted,
    patternsMatched: [
      ...regexResult.patternsMatched,
      ...nerResult.patternsMatched,
    ],
  };
}

/** Regex to match Claude thinking blocks in content. */
const THINKING_BLOCK_RE = /<thinking>[\s\S]*?<\/thinking>/gi;

/**
 * Strip `<thinking>...</thinking>` blocks from text content.
 */
export function stripThinkingBlocks(text: string): string {
  return text.replace(THINKING_BLOCK_RE, "[thinking block removed]");
}
