import { errorResponse, isSameOrigin } from "../lib/http";
import type { Session } from "../lib/sessions";
import { findSession, readSessionToken } from "../lib/sessions";
import type { RequestContext } from "../router";

/**
 * Every /api/admin/* handler starts here. Reads need a live session; anything that
 * changes state also needs a same-origin request (CSRF guard).
 */
export async function requireAdmin(
  context: RequestContext,
  options: { mutating: boolean },
): Promise<{ session: Session } | { response: Response }> {
  if (options.mutating && !isSameOrigin(context.request, context.url)) {
    return { response: errorResponse("FORBIDDEN_ORIGIN") };
  }
  const token = readSessionToken(context.request);
  const session = token
    ? await findSession(context.services.db, token, context.services.now())
    : null;
  if (!session) return { response: errorResponse("UNAUTHENTICATED") };
  return { session };
}
