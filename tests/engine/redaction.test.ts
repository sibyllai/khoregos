/**
 * Tests for PII redaction engine.
 */

import { describe, it, expect } from "vitest";
import {
  redactText,
  redactNER,
  redactFull,
  stripThinkingBlocks,
} from "../../src/engine/redaction.js";

describe("redactText", () => {
  const defaultPatterns = [
    { name: "email", pattern: "[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}", replacement: "[EMAIL]" },
    { name: "phone", pattern: "\\b\\d{3}[\\-.]?\\d{3}[\\-.]?\\d{4}\\b", replacement: "[PHONE]" },
    { name: "ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", replacement: "[SSN]" },
    { name: "credit_card", pattern: "\\b\\d{4}[\\- ]?\\d{4}[\\- ]?\\d{4}[\\- ]?\\d{4}\\b", replacement: "[CREDIT_CARD]" },
  ];

  it("redacts email addresses", () => {
    const result = redactText("Contact user@example.com for info.", defaultPatterns);
    expect(result.text).toBe("Contact [EMAIL] for info.");
    expect(result.redacted).toBe(true);
    expect(result.patternsMatched).toContain("email");
  });

  it("redacts phone numbers", () => {
    const result = redactText("Call 555-123-4567 now.", defaultPatterns);
    expect(result.text).toBe("Call [PHONE] now.");
    expect(result.redacted).toBe(true);
  });

  it("redacts SSN", () => {
    const result = redactText("SSN: 123-45-6789", defaultPatterns);
    expect(result.text).toContain("[SSN]");
    expect(result.redacted).toBe(true);
  });

  it("redacts credit card numbers", () => {
    const result = redactText("Card: 4111 1111 1111 1111", defaultPatterns);
    expect(result.text).toContain("[CREDIT_CARD]");
    expect(result.redacted).toBe(true);
  });

  it("returns unchanged text when no patterns match", () => {
    const result = redactText("Hello, world!", defaultPatterns);
    expect(result.text).toBe("Hello, world!");
    expect(result.redacted).toBe(false);
    expect(result.patternsMatched).toEqual([]);
  });

  it("handles multiple patterns in one text", () => {
    const result = redactText("Email: foo@bar.com, Phone: 555-111-2222", defaultPatterns);
    expect(result.text).toContain("[EMAIL]");
    expect(result.text).toContain("[PHONE]");
    expect(result.patternsMatched).toContain("email");
    expect(result.patternsMatched).toContain("phone");
  });

  it("skips invalid regex patterns silently", () => {
    const patterns = [
      { name: "bad", pattern: "[invalid", replacement: "X" },
      { name: "email", pattern: "[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}", replacement: "[EMAIL]" },
    ];
    const result = redactText("test@example.com", patterns);
    expect(result.text).toBe("[EMAIL]");
    expect(result.redacted).toBe(true);
  });

  it("handles empty patterns list", () => {
    const result = redactText("test@example.com", []);
    expect(result.text).toBe("test@example.com");
    expect(result.redacted).toBe(false);
  });
});

describe("redactNER", () => {
  it("redacts person names", () => {
    const result = redactNER("Contact John Doe for details.");
    expect(result.text).toContain("[PERSON]");
    expect(result.text).not.toContain("John Doe");
    expect(result.redacted).toBe(true);
    expect(result.patternsMatched).toContain("ner:person");
  });

  it("redacts multiple person names", () => {
    const result = redactNER("John Doe and Jane Smith worked together.");
    expect(result.text).not.toContain("John Doe");
    expect(result.text).not.toContain("Jane Smith");
    expect(result.redacted).toBe(true);
  });

  it("redacts locations", () => {
    const result = redactNER("The team moved to San Francisco last year.");
    expect(result.text).not.toContain("San Francisco");
    expect(result.redacted).toBe(true);
    expect(result.patternsMatched).toContain("ner:location");
  });

  it("redacts organizations", () => {
    const result = redactNER("She works at Microsoft on cloud services.");
    expect(result.text).toContain("[ORG]");
    expect(result.text).not.toContain("Microsoft");
    expect(result.patternsMatched).toContain("ner:organization");
  });

  it("returns unchanged text when no entities found", () => {
    const result = redactNER("The function returns a boolean value.");
    expect(result.redacted).toBe(false);
    expect(result.patternsMatched).toEqual([]);
  });
});

describe("redactFull", () => {
  const patterns = [
    { name: "email", pattern: "[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}", replacement: "[EMAIL]" },
    { name: "ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", replacement: "[SSN]" },
  ];

  it("applies both regex and NER redaction", () => {
    const result = redactFull(
      "Contact John Doe about john@example.com and SSN 123-45-6789",
      patterns,
    );
    expect(result.text).not.toContain("John Doe");
    expect(result.text).not.toContain("john@example.com");
    expect(result.text).not.toContain("123-45-6789");
    expect(result.text).toContain("[EMAIL]");
    expect(result.text).toContain("[SSN]");
    expect(result.redacted).toBe(true);
    expect(result.patternsMatched).toContain("email");
    expect(result.patternsMatched).toContain("ssn");
    expect(result.patternsMatched).toContain("ner:person");
  });

  it("skips NER when ner option is false", () => {
    const result = redactFull(
      "John Doe, john@example.com",
      patterns,
      { ner: false },
    );
    expect(result.text).toContain("[EMAIL]");
    // NER disabled, so the name should remain.
    expect(result.text).toContain("John Doe");
    expect(result.patternsMatched).not.toContain("ner:person");
  });

  it("handles text with no PII", () => {
    const result = redactFull("The function returns true.", patterns);
    expect(result.text).toBe("The function returns true.");
    expect(result.redacted).toBe(false);
  });
});

describe("stripThinkingBlocks", () => {
  it("removes thinking blocks", () => {
    const text = "Before <thinking>secret thoughts</thinking> After";
    expect(stripThinkingBlocks(text)).toBe("Before [thinking block removed] After");
  });

  it("removes multiple thinking blocks", () => {
    const text = "<thinking>first</thinking>middle<thinking>second</thinking>end";
    expect(stripThinkingBlocks(text)).toBe("[thinking block removed]middle[thinking block removed]end");
  });

  it("handles multiline thinking blocks", () => {
    const text = "Hello\n<thinking>\nline 1\nline 2\n</thinking>\nDone";
    expect(stripThinkingBlocks(text)).toBe("Hello\n[thinking block removed]\nDone");
  });

  it("returns text unchanged when no thinking blocks", () => {
    const text = "Just regular text";
    expect(stripThinkingBlocks(text)).toBe("Just regular text");
  });
});
