// chunk: c001
export interface Session {
  expiresAt: number;
}

export function validateSession(session: Session, now: number) {
  if (session.expiresAt <= now) {
    return { allowed: false, reason: 'stale-session' as const };
  }
  return { allowed: true, reason: null };
}

// chunk: c002
export function hasMatchingCsrfHeader(header: string | undefined, cookie: string | undefined) {
  return Boolean(header && cookie && header === cookie);
}
