import type { AllSettings } from "@lensarent/shared";
import {
  addDays,
  formatMyMobile,
  formatMytDate,
  formatMytDateTime,
  formatRM,
  mytDateTime,
} from "@lensarent/shared";
import type { BookingRow } from "./bookings";
import { getBooking } from "./bookings";
import type { Hasher } from "./crypto";
import type { EmailTemplate } from "./outbox";

/**
 * Email content, in Bahasa Melayu. Outbox rows carry ids only; the text is rendered at
 * send time from the current booking, so nothing personal sits in the queue's payload.
 * Every value is escaped for HTML; there is no template engine.
 */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface RenderContext {
  db: D1Database;
  hasher: Hasher;
  settings: AllSettings;
  siteOrigin: string | undefined;
}

interface Content {
  subject: string;
  paragraphs: string[];
  link?: { label: string; url: string } | undefined;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function render(content: Content, settings: AllSettings): RenderedEmail {
  const brand = settings.businessInfo.brandName;
  const contact = `WhatsApp ${formatMyMobile(settings.businessInfo.whatsappE164)}`;
  const footer = `${brand} · ${contact}`;
  const linkText = content.link ? [`${content.link.label}: ${content.link.url}`] : [];
  const text = [...content.paragraphs, ...linkText, "", footer].join("\n\n");
  const html = [
    '<!doctype html><html lang="ms"><body style="font-family:sans-serif;line-height:1.5">',
    ...content.paragraphs.map(
      (paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`,
    ),
    content.link
      ? `<p><a href="${escapeHtml(content.link.url)}">${escapeHtml(content.link.label)}</a></p>`
      : "",
    `<p style="color:#666;font-size:13px">${escapeHtml(footer)}</p>`,
    "</body></html>",
  ].join("");
  return { subject: content.subject, text, html };
}

function locationName(settings: AllSettings, id: string): string {
  return settings.meetupLocations.locations.find((location) => location.id === id)?.name ?? id;
}

function schedule(booking: BookingRow, settings: AllSettings): string {
  return [
    `Ambil: ${formatMytDateTime(new Date(booking.pickup_at))}, ${locationName(settings, booking.pickup_location_id)}`,
    `Pulang: ${formatMytDateTime(new Date(booking.return_at))}, ${locationName(settings, booking.return_location_id)}`,
  ].join("\n");
}

async function statusLink(context: RenderContext, booking: BookingRow): Promise<Content["link"]> {
  if (!context.siteOrigin) return undefined;
  const token = await context.hasher.hash("lookup", booking.id);
  // The token rides in the fragment: browsers never send it to any server or log.
  return {
    label: "Semak status tempahan",
    url: `${context.siteOrigin}/tempahan?ref=${encodeURIComponent(booking.ref_code)}#t=${token}`,
  };
}

function adminLink(context: RenderContext): Content["link"] {
  return context.siteOrigin
    ? { label: "Buka panel admin", url: `${context.siteOrigin}/admin/` }
    : undefined;
}

async function bookingContent(
  context: RenderContext,
  template: Exclude<EmailTemplate, "admin_daily_summary">,
  booking: BookingRow,
): Promise<Content> {
  const { settings } = context;
  const ref = booking.ref_code;
  switch (template) {
    case "booking_confirmed":
      return {
        subject: `Tempahan disahkan — ${ref}`,
        paragraphs: [
          `Salam ${booking.customer_name},`,
          `Terima kasih. Bayaran diterima dan tempahan ${ref} telah disahkan.`,
          schedule(booking, settings),
          [
            `Jumlah dibayar: ${formatRM(booking.total_payable_sen)}`,
            `Termasuk deposit keselamatan ${formatRM(booking.deposit_sen)}, dipulangkan selepas pemeriksaan kamera.`,
            booking.receipt_no ? `No. resit: ${booking.receipt_no}` : "",
          ]
            .filter((line) => line !== "")
            .join("\n"),
          "Semasa serahan, sila bawa MyKad untuk pengesahan. Kami hanya mencatat 4 digit terakhir; tiada salinan atau gambar MyKad disimpan.",
        ],
        link: await statusLink(context, booking),
      };
    case "pickup_reminder":
      return {
        subject: `Peringatan: ambil kamera esok — ${ref}`,
        paragraphs: [
          `Salam ${booking.customer_name},`,
          `Ini peringatan untuk tempahan ${ref}.`,
          schedule(booking, settings),
          "Sila bawa MyKad. Jika ada perubahan, hubungi kami melalui WhatsApp secepat mungkin.",
        ],
        link: await statusLink(context, booking),
      };
    case "admin_new_booking":
      return {
        subject: `Tempahan baharu ${ref}`,
        paragraphs: [
          `Tempahan ${ref} telah dibayar dan disahkan (unit ${booking.unit_id}).`,
          schedule(booking, settings),
          `Pelanggan: ${booking.customer_name}, ${formatMyMobile(booking.customer_phone_e164)}`,
          `Jumlah: ${formatRM(booking.total_payable_sen)} (deposit ${formatRM(booking.deposit_sen)})`,
        ],
        link: adminLink(context),
      };
    case "admin_payment_problem":
      return {
        subject: `TINDAKAN DIPERLUKAN: masalah bayaran ${ref}`,
        paragraphs: [
          `Bayaran untuk ${ref} tidak sepadan atau tiba selepas tempahan ditutup (status: ${booking.status}, sebab: ${booking.status_reason ?? "-"}).`,
          "Semak bayaran di dashboard CHIP dan selesaikan bayaran balik secara manual. Tarikh tempahan ini sudah dilepaskan.",
        ],
        link: adminLink(context),
      };
    case "admin_overdue":
      return {
        subject: `Lewat dipulangkan: ${ref}`,
        paragraphs: [
          `Kamera untuk ${ref} belum dipulangkan. Slot pulang tamat ${formatMytDateTime(new Date(booking.return_slot_end))}.`,
          `Pelanggan: ${booking.customer_name}, ${formatMyMobile(booking.customer_phone_e164)}`,
        ],
        link: adminLink(context),
      };
    case "admin_hold_unresolved":
      return {
        subject: `TINDAKAN DIPERLUKAN: hold ${ref} tidak dapat diselesaikan`,
        paragraphs: [
          `Hold untuk ${ref} sudah tamat tetapi status bayarannya di CHIP tidak dapat disahkan. Tarikhnya masih dikunci.`,
          "Semak pembelian ini di dashboard CHIP. Sistem akan terus mencuba setiap minit.",
        ],
        link: adminLink(context),
      };
  }
}

interface DayRow {
  ref_code: string;
  pickup_at: string;
  return_at: string;
  pickup_location_id: string;
  return_location_id: string;
  customer_name: string;
}

async function dailySummary(context: RenderContext, date: string): Promise<Content> {
  const { settings } = context;
  const query = (column: "pickup_at" | "return_at", statuses: string) =>
    context.db
      .prepare(
        `SELECT ref_code, pickup_at, return_at, pickup_location_id, return_location_id, customer_name
         FROM bookings WHERE ${column} >= ? AND ${column} < ? AND status IN (${statuses})
         ORDER BY ${column}`,
      )
      .bind(mytDateTime(date).toISOString(), mytDateTime(addDays(date, 1)).toISOString())
      .all<DayRow>();
  const [pickups, returns] = await Promise.all([
    query("pickup_at", "'confirmed', 'ready_for_pickup'"),
    query("return_at", "'active_rental', 'overdue'"),
  ]);
  const list = (rows: DayRow[], kind: "pickup" | "return") =>
    rows.length === 0
      ? "Tiada."
      : rows
          .map((row) => {
            const at = kind === "pickup" ? row.pickup_at : row.return_at;
            const where = kind === "pickup" ? row.pickup_location_id : row.return_location_id;
            return `• ${formatMytDateTime(new Date(at))} — ${row.ref_code}, ${row.customer_name}, ${locationName(settings, where)}`;
          })
          .join("\n");
  return {
    subject: `Ringkasan ${formatMytDate(date)}: ${pickups.results.length.toString()} ambil, ${returns.results.length.toString()} pulang`,
    paragraphs: [
      `Serahan hari ini (${formatMytDate(date)}):`,
      `AMBIL\n${list(pickups.results, "pickup")}`,
      `PULANG\n${list(returns.results, "return")}`,
    ],
    link: adminLink(context),
  };
}

/** Renders a queued message. Null when what it refers to no longer exists. */
export async function renderEmail(
  context: RenderContext,
  template: EmailTemplate,
  payload: Readonly<Record<string, unknown>>,
): Promise<RenderedEmail | null> {
  if (template === "admin_daily_summary") {
    return typeof payload.date === "string"
      ? render(await dailySummary(context, payload.date), context.settings)
      : null;
  }
  const bookingId = payload.bookingId;
  if (typeof bookingId !== "string") return null;
  const booking = await getBooking(context.db, bookingId);
  if (!booking) return null;
  return render(await bookingContent(context, template, booking), context.settings);
}
