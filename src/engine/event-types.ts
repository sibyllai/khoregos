/**
 * Shared event type display mapping for CLI/report output.
 */

export const EVENT_TYPE_DISPLAY: Record<string, string> = {
  gate_triggered: "sensitive_needs_review",
};

export function displayEventType(eventType: string): string {
  return EVENT_TYPE_DISPLAY[eventType] ?? eventType;
}
