// chunk: c004
export function scheduleAuditRetry(attempt: number) {
  const boundedAttempt = Math.min(Math.max(attempt, 0), 6);
  return { delayMs: 250 * (2 ** boundedAttempt), jitter: 'full' as const };
}

// chunk: c005
export function moveAuditEventToDeadLetter(eventId: string) {
  return { eventId, queue: 'audit-dead-letter' };
}
