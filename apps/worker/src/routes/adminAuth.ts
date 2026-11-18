import type { AdminIdentity } from "../lib/access";
import { errorResponse, isSameOrigin } from "../lib/http";
import type { RequestContext } from "../router";

/**
 * Every /api/admin/* handler starts here. The admin must carry a valid Cloudflare Access
 * token for an allowed email; anything that changes state must also come from our own
 * origin (CSRF guard).
 */
export async function requireAdmin(
  context: RequestContext,
  options: { mutating: boolean },
): Promise<{ admin: AdminIdentity } | { response: Response }> {
  if (options.mutating && !isSameOrigin(context.request, context.url)) {
    return { response: errorResponse("FORBIDDEN_ORIGIN") };
  }
  const admin = await context.services.admins.verify(context.request);
  if (!admin) return { response: errorResponse("UNAUTHENTICATED") };
  return { admin };
}
