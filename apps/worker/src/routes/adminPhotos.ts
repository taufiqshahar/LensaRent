import {
  API_SECURITY_HEADERS,
  errorResponse,
  jsonResponse,
  validationErrorResponse,
} from "../lib/http";
import { getBooking } from "../lib/bookings";
import { newId } from "../lib/db";
import { auditStatement } from "../lib/audit";
import type { Handler } from "../router";
import { requireAdmin } from "./adminAuth";

/**
 * Handover photos (condition evidence at checkout and return). Stored in a private R2
 * bucket, uploaded and viewed only through these admin endpoints, and deleted by the cron
 * once the retention period after the booking closes has passed. Never a MyKad.
 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const BOOKING_ID = /^[A-Za-z0-9]{20}$/;
/** Photos can only be added while the camera is changing hands or being inspected. */
const STAGE_STATUSES: Readonly<Record<"checkout" | "return", readonly string[]>> = {
  checkout: ["ready_for_pickup", "active_rental"],
  return: ["active_rental", "overdue", "return_inspection", "disputed"],
};

/** Content type from the file's first bytes; the client's Content-Type is not trusted. */
export function sniffImageType(
  bytes: Uint8Array,
): "image/jpeg" | "image/png" | "image/webp" | null {
  const at = (index: number) => bytes[index] ?? -1;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => at(i) === byte)) {
    return "image/png";
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

async function readLimited(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_PHOTO_BYTES || !request.body) return null;
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PHOTO_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** POST /api/admin/bookings/:id/photos?stage=checkout|return — raw image body. */
export const uploadPhotoHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: true });
  if ("response" in auth) return auth.response;
  const bucket = context.services.photos;
  if (!bucket) return errorResponse("PHOTOS_UNAVAILABLE");
  const id = context.params.id ?? "";
  const stage = context.url.searchParams.get("stage");
  if (stage !== "checkout" && stage !== "return") {
    return validationErrorResponse({ stage: "Peringkat gambar mesti checkout atau return." });
  }
  const booking = BOOKING_ID.test(id) ? await getBooking(context.services.db, id) : null;
  if (!booking) return errorResponse("NOT_FOUND");
  if (!STAGE_STATUSES[stage].includes(booking.status)) return errorResponse("INVALID_TRANSITION");

  const bytes = await readLimited(context.request);
  if (!bytes) return errorResponse("PAYLOAD_TOO_LARGE");
  const type = sniffImageType(bytes);
  if (!type || bytes.byteLength === 0) return errorResponse("UNSUPPORTED_MEDIA_TYPE");

  const photoId = newId();
  const key = `bookings/${booking.id}/${stage}/${photoId}`;
  const now = context.services.now();
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  const db = context.services.db;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO handover_photos (id, booking_id, stage, r2_key, content_type, size_bytes, uploaded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          photoId,
          booking.id,
          stage,
          key,
          type,
          bytes.byteLength,
          auth.admin.email,
          now.toISOString(),
        ),
      auditStatement(db, {
        actor: auth.admin,
        action: `photo.upload.${stage}`,
        targetTable: "handover_photos",
        targetId: photoId,
        at: now,
      }),
    ]);
  } catch (error) {
    // No row, no orphan: remove the object we just stored.
    await bucket.delete(key);
    throw error;
  }
  return jsonResponse({ ok: true, id: photoId }, 201);
};

/** GET /api/admin/photos/:id — the image, never cached, never framed, never sniffed. */
export const downloadPhotoHandler: Handler = async (context) => {
  const auth = await requireAdmin(context, { mutating: false });
  if ("response" in auth) return auth.response;
  const bucket = context.services.photos;
  if (!bucket) return errorResponse("PHOTOS_UNAVAILABLE");
  const id = context.params.id ?? "";
  if (!BOOKING_ID.test(id)) return errorResponse("NOT_FOUND");
  const row = await context.services.db
    .prepare("SELECT r2_key, content_type FROM handover_photos WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<{ r2_key: string; content_type: string }>();
  const object = row ? await bucket.get(row.r2_key) : null;
  if (!row || !object) return errorResponse("NOT_FOUND");
  return new Response(object.body, {
    headers: {
      ...API_SECURITY_HEADERS,
      "Content-Type": row.content_type,
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
    },
  });
};
