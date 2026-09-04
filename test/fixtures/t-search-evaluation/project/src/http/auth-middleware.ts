// chunk: c003
import { validateSession } from '../auth/session-guard.js';

export function authMiddleware(request: { session: { expiresAt: number } }, next: () => unknown) {
  const verdict = validateSession(request.session, Date.now());
  if (!verdict.allowed) return { status: 401, code: verdict.reason };
  return next();
}
