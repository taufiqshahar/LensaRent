import { BOOKING_STATUS_LABELS, LEDGER_TYPE_LABELS } from "@lensarent/shared/bookingLabels";
import type { LedgerEntryType } from "@lensarent/shared/ledger";
import { formatRM } from "@lensarent/shared/money";
import { formatMyMobile, whatsappUrl } from "@lensarent/shared/phone";
import type { BookingStatus } from "@lensarent/shared/stateMachine";
import { BOOKING_STATUSES } from "@lensarent/shared/stateMachine";
import {
  addDays,
  formatMytDate,
  formatMytDateTime,
  mytDateString,
  mytDateTime,
} from "@lensarent/shared/time";
import { api, send } from "./adminApi";
import { el } from "./dom";

/**
 * Admin operations views: today, bookings (list + detail with actions), calendar, units
 * and maintenance blocks, customers, settings and the audit log. Every action calls the
 * Worker, which re-checks everything; the UI only offers what makes sense for a status.
 */
export type OpsView =
  "today" | "bookings" | "calendar" | "fleet" | "customers" | "settings" | "audit";

type Child = Node | string | null | undefined | false;

/** Handover/return checklist items shown to the admin. */
const CHECKLIST: readonly [string, string][] = [
  ["body_ok", "Badan & gimbal tiada kerosakan"],
  ["lens_clean", "Lensa bersih, tiada calar"],
  ["screen_ok", "Skrin berfungsi, tiada retak"],
  ["battery_ok", "Bateri dicas"],
  ["storage_empty", "Storan kosong / diformat"],
  ["accessories_complete", "Semua aksesori lengkap"],
];

// ── Small helpers ───────────────────────────────────────────────────────────────────────

function rm(sen: number): string {
  return formatRM(sen);
}

/** "30" or "30.50" ringgit → integer sen, without floating point. */
export function parseRm(text: string): number | null {
  const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
}

function field(label: string, input: HTMLElement): HTMLElement {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return el("div", { class: "field" }, el("label", { for: id }, label), input);
}

function input(name: string, attributes: Record<string, string | boolean> = {}): HTMLInputElement {
  return el("input", { name, ...attributes });
}

function select(
  name: string,
  options: readonly [string, string][],
  current = "",
): HTMLSelectElement {
  return el(
    "select",
    { name },
    ...options.map(([value, label]) => el("option", { value, selected: value === current }, label)),
  );
}

function message(): HTMLParagraphElement {
  return el("p", { class: "form-status small", role: "status" });
}

function setMessage(node: HTMLElement, text: string, kind: "ok" | "error" | "" = ""): void {
  node.textContent = text;
  node.dataset.kind = kind;
}

/** A form whose submit runs `action`; the returned promise's error text is shown. */
function actionForm(
  title: string,
  children: Child[],
  submitLabel: string,
  action: (form: HTMLFormElement) => Promise<string | null>,
): HTMLFormElement {
  const status = message();
  const button = el("button", { class: "button button--small", type: "submit" }, submitLabel);
  const form = el("form", { class: "card" }, el("h3", {}, title), ...children, button, status);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    button.disabled = true;
    setMessage(status, "Menyimpan…");
    void action(form).then((error) => {
      button.disabled = false;
      if (error) setMessage(status, error, "error");
      else setMessage(status, "Disimpan.", "ok");
    });
  });
  return form;
}

function value(form: HTMLFormElement, name: string): string {
  const entry = new FormData(form).get(name);
  return typeof entry === "string" ? entry : "";
}

function errorText(result: {
  ok: false;
  error: { message: string; fields?: Record<string, string> };
}): string {
  const fields = Object.values(result.error.fields ?? {});
  return fields.length > 0 ? fields.join(" ") : result.error.message;
}

function table(headers: readonly string[], rows: Child[][]): HTMLTableElement {
  return el(
    "table",
    { class: "ops-table" },
    el("thead", {}, el("tr", {}, ...headers.map((header) => el("th", {}, header)))),
    el(
      "tbody",
      {},
      ...rows.map((cells) => el("tr", {}, ...cells.map((cell) => el("td", {}, cell)))),
    ),
  );
}

// ── Bookings ────────────────────────────────────────────────────────────────────────────

interface BookingSummary {
  id: string;
  ref_code: string;
  status: BookingStatus;
  unit_id: string;
  customer_name: string;
  customer_phone_e164: string;
  pickup_at: string;
  return_at: string;
  total_payable_sen: number;
}

function bookingItem(booking: BookingSummary, container: HTMLElement): HTMLElement {
  const open = el("button", { class: "button button--small", type: "button" }, "Buka");
  open.addEventListener("click", () => {
    showBooking(booking.id, container);
  });
  return el(
    "li",
    { class: "card" },
    el(
      "div",
      { class: "ops-row" },
      el("strong", {}, `${booking.ref_code} · ${booking.customer_name}`),
      el(
        "span",
        { class: "status-badge", "data-status": booking.status },
        BOOKING_STATUS_LABELS[booking.status],
      ),
    ),
    el(
      "p",
      { class: "small" },
      `Ambil ${formatMytDateTime(new Date(booking.pickup_at))} · Pulang ${formatMytDateTime(new Date(booking.return_at))} · ${booking.unit_id} · ${rm(booking.total_payable_sen)}`,
    ),
    open,
  );
}

function bookingList(
  container: HTMLElement,
  query: () => URLSearchParams,
  controls: Child[],
): void {
  const list = el("ul", { class: "ops-list" });
  const summary = el("p", { class: "muted small", role: "status" });
  const more = el(
    "button",
    { class: "button button--ghost", type: "button", hidden: true },
    "Muat lagi",
  );
  let next: string | null = null;
  const load = (append: boolean) => {
    const params = query();
    if (append && next) params.set("before", next);
    if (!append) list.replaceChildren();
    summary.textContent = "Memuatkan…";
    void api<{ bookings: BookingSummary[]; next: string | null }>(
      `/api/admin/bookings?${params.toString()}`,
    ).then((result) => {
      if (!result.ok) {
        summary.textContent = result.error.message;
        return;
      }
      list.append(...result.value.bookings.map((booking) => bookingItem(booking, container)));
      next = result.value.next;
      more.hidden = next === null;
      summary.textContent = list.childElementCount === 0 ? "Tiada tempahan." : "";
    });
  };
  more.addEventListener("click", () => {
    load(true);
  });
  const reload = el(
    "button",
    { class: "button button--small button--ghost", type: "button" },
    "Muat semula",
  );
  reload.addEventListener("click", () => {
    load(false);
  });
  container.replaceChildren(
    el(
      "div",
      { class: "filters card" },
      ...controls.filter((c): c is Node | string => !!c),
      reload,
    ),
    summary,
    list,
    more,
  );
  for (const control of container.querySelectorAll("select, input")) {
    control.addEventListener("change", () => {
      load(false);
    });
  }
  load(false);
}

function showToday(container: HTMLElement): void {
  const day = input("day", { type: "date", value: mytDateString(new Date()) });
  bookingList(container, () => new URLSearchParams({ day: day.value }), [field("Hari", day)]);
}

function showBookings(container: HTMLElement): void {
  const status = select("status", [
    ["", "Semua status"],
    ...BOOKING_STATUSES.map((s): [string, string] => [s, BOOKING_STATUS_LABELS[s]]),
  ]);
  bookingList(container, () => {
    const params = new URLSearchParams();
    if (status.value) params.set("status", status.value);
    return params;
  }, [field("Status", status)]);
}

interface Detail {
  booking: BookingSummary & {
    status_reason: string | null;
    customer_email: string;
    pickup_location_id: string;
    return_location_id: string;
    return_slot_end: string;
    rental_sen: number;
    add_ons_sen: number;
    meetup_sen: number;
    deposit_sen: number;
    refund_due_sen: number | null;
    receipt_no: string | null;
    id_last4: string | null;
    reschedule_used: number;
  };
  events: {
    from_status: string | null;
    to_status: BookingStatus;
    actor_type: string;
    reason: string | null;
    at: string;
  }[];
  ledger: {
    id: string;
    type: LedgerEntryType;
    amount_sen: number;
    method: string;
    reference: string;
    note: string;
    reverses_id: string | null;
    created_at: string;
  }[];
  photos: { id: string; stage: string; created_at: string }[];
  depositBalanceSen: number;
  allowedTransitions: BookingStatus[];
  lateFeeSuggestionSen: number | null;
  cancellationPreview: { tier: string; refundSen: number } | null;
}

function checklistInputs(): HTMLElement {
  return el(
    "fieldset",
    { class: "booking__leg" },
    el("legend", {}, "Senarai semak"),
    ...CHECKLIST.map(([key, label]) =>
      el(
        "label",
        { class: "check" },
        el("input", { type: "checkbox", name: `check_${key}` }),
        el("span", {}, label),
      ),
    ),
  );
}

function checklistFrom(form: HTMLFormElement): Record<string, boolean> {
  const data = new FormData(form);
  return Object.fromEntries(CHECKLIST.map(([key]) => [key, data.get(`check_${key}`) === "on"]));
}

function accessoriesFrom(form: HTMLFormElement): string[] {
  return value(form, "accessories")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function photoUploader(
  bookingId: string,
  stage: "checkout" | "return",
  refresh: () => void,
): HTMLElement {
  const file = el("input", {
    type: "file",
    accept: "image/jpeg,image/png,image/webp",
    capture: "environment",
    multiple: true,
  });
  const status = message();
  file.addEventListener("change", () => {
    const files = [...(file.files ?? [])];
    setMessage(status, `Memuat naik ${files.length.toString()} gambar…`);
    void (async () => {
      for (const photo of files) {
        const result = await api(`/api/admin/bookings/${bookingId}/photos?stage=${stage}`, {
          method: "POST",
          body: photo,
          contentType: photo.type || "application/octet-stream",
        });
        if (!result.ok) {
          setMessage(status, result.error.message, "error");
          return;
        }
      }
      refresh();
    })();
  });
  return el(
    "div",
    { class: "card" },
    el("h3", {}, stage === "checkout" ? "Gambar semasa serahan" : "Gambar semasa pemulangan"),
    field("Pilih atau ambil gambar", file),
    status,
  );
}

function bookingActions(detail: Detail, refresh: () => void): Child[] {
  const { booking } = detail;
  const base = `/api/admin/bookings/${booking.id}`;
  const after = async (
    result: Promise<
      { ok: true } | { ok: false; error: { message: string; fields?: Record<string, string> } }
    >,
  ) => {
    const outcome = await result;
    if (!outcome.ok) return errorText(outcome);
    refresh();
    return null;
  };
  const actions: Child[] = [];
  const status = booking.status;

  for (const to of detail.allowedTransitions) {
    if (to !== "ready_for_pickup" && to !== "disputed") continue;
    actions.push(
      actionForm(
        `Tukar status: ${BOOKING_STATUS_LABELS[to]}`,
        [field("Sebab (pilihan)", input("reason", { maxlength: "500" }))],
        "Sahkan",
        (form) =>
          after(
            send("POST", `${base}/transition`, { from: status, to, reason: value(form, "reason") }),
          ),
      ),
    );
  }

  if (status === "ready_for_pickup") {
    actions.push(photoUploader(booking.id, "checkout", refresh));
    actions.push(
      actionForm(
        "Serah kamera",
        [
          field(
            "4 digit terakhir MyKad (sahaja)",
            input("idLast4", {
              inputmode: "numeric",
              pattern: "\\d{4}",
              maxlength: "4",
              required: true,
            }),
          ),
          checklistInputs(),
          field("Aksesori diserahkan (pisahkan dengan koma)", input("accessories")),
          field("Nota", input("note", { maxlength: "500" })),
        ],
        "Serah & mula sewaan",
        (form) =>
          after(
            send("POST", `${base}/handover`, {
              from: status,
              idLast4: value(form, "idLast4"),
              checklist: checklistFrom(form),
              accessories: accessoriesFrom(form),
              note: value(form, "note"),
            }),
          ),
      ),
    );
  }

  if (status === "active_rental" || status === "overdue") {
    actions.push(photoUploader(booking.id, "return", refresh));
    actions.push(
      actionForm(
        "Terima pemulangan",
        [
          field(
            "Masa dipulangkan (kosongkan = sekarang)",
            input("returnedAt", { type: "datetime-local" }),
          ),
          checklistInputs(),
          field("Aksesori dipulangkan (pisahkan dengan koma)", input("accessories")),
          field("Nota", input("note", { maxlength: "500" })),
        ],
        "Terima & periksa",
        (form) => {
          const local = value(form, "returnedAt");
          const returnedAt = local
            ? mytDateTime(local.slice(0, 10), local.slice(11, 16)).toISOString()
            : undefined;
          return after(
            send("POST", `${base}/return`, {
              from: status,
              ...(returnedAt ? { returnedAt } : {}),
              checklist: checklistFrom(form),
              accessories: accessoriesFrom(form),
              note: value(form, "note"),
            }),
          );
        },
      ),
    );
  }

  if (status === "return_inspection" || status === "disputed") {
    const suggestion = detail.lateFeeSuggestionSen ?? 0;
    actions.push(
      actionForm(
        `Selesaikan deposit (baki ${rm(detail.depositBalanceSen)})`,
        [
          el(
            "p",
            { class: "small muted" },
            `Cadangan caj lewat: ${rm(suggestion)}. Anda yang meluluskan jumlahnya.`,
          ),
          field(
            "Caj lewat (RM)",
            input("late", { value: (suggestion / 100).toFixed(2), inputmode: "decimal" }),
          ),
          field("Caj kerosakan (RM)", input("damage", { value: "0", inputmode: "decimal" })),
          field(
            "Kaedah pulangan deposit",
            select("method", [
              ["duitnow", "DuitNow"],
              ["cash", "Tunai"],
              ["gateway", "CHIP"],
            ]),
          ),
          field("Rujukan pemindahan", input("reference", { maxlength: "100" })),
          field("Nota", input("note", { maxlength: "500" })),
        ],
        "Selesai & pulangkan deposit",
        (form) => {
          const late = parseRm(value(form, "late"));
          const damage = parseRm(value(form, "damage"));
          if (late === null || damage === null) return Promise.resolve("Jumlah RM tidak sah.");
          return after(
            send("POST", `${base}/settle`, {
              from: status,
              lateFeeSen: late,
              damageSen: damage,
              refundMethod: value(form, "method"),
              refundReference: value(form, "reference"),
              note: value(form, "note"),
            }),
          );
        },
      ),
    );
  }

  if (status === "pending_payment" || status === "confirmed" || status === "ready_for_pickup") {
    const preview = detail.cancellationPreview;
    actions.push(
      actionForm(
        "Batalkan tempahan",
        [
          preview
            ? el(
                "p",
                { class: "small muted" },
                `Jika pelanggan membatalkan sekarang: ${preview.tier}, bayaran balik ${rm(preview.refundSen)}.`,
              )
            : null,
          field(
            "Dibatalkan oleh",
            select("initiator", [
              ["customer", "Pelanggan"],
              ["business", "Perniagaan (bayaran balik penuh)"],
              ["no_show", "Tidak hadir"],
            ]),
          ),
          field("Sebab", input("reason", { maxlength: "500" })),
        ],
        "Batalkan",
        (form) =>
          after(
            send("POST", `${base}/cancel`, {
              from: status,
              initiator: value(form, "initiator"),
              reason: value(form, "reason"),
            }),
          ),
      ),
    );
  }

  if (status === "refund_pending") {
    actions.push(
      actionForm(
        "Rekod bayaran balik yang telah dihantar",
        [
          field(
            "Jumlah dihantar (RM)",
            input("amount", {
              value: ((booking.refund_due_sen ?? 0) / 100).toFixed(2),
              inputmode: "decimal",
            }),
          ),
          field(
            "Kaedah",
            select("method", [
              ["duitnow", "DuitNow"],
              ["gateway", "CHIP"],
              ["cash", "Tunai"],
            ]),
          ),
          field("Rujukan", input("reference", { required: true, maxlength: "100" })),
          field("Nota", input("note", { maxlength: "500" })),
        ],
        "Rekod & tutup",
        (form) => {
          const amount = parseRm(value(form, "amount"));
          if (amount === null) return Promise.resolve("Jumlah RM tidak sah.");
          return after(
            send("POST", `${base}/refund`, {
              from: status,
              amountSen: amount,
              method: value(form, "method"),
              reference: value(form, "reference"),
              note: value(form, "note"),
            }),
          );
        },
      ),
    );
  }

  actions.push(
    actionForm(
      "Entri lejar manual",
      [
        el(
          "p",
          { class: "small muted" },
          "Untuk kutipan atau bayaran di luar aliran biasa. Bayaran balik / potongan ditulis negatif (cth. -20).",
        ),
        field(
          "Jenis",
          select(
            "type",
            (
              [
                "LATE_FEE",
                "DAMAGE_CHARGE",
                "REFUND",
                "GATEWAY_FEE",
                "DEPOSIT_REFUND",
                "DEPOSIT_DEDUCTION",
              ] as const
            ).map((type): [string, string] => [type, LEDGER_TYPE_LABELS[type]]),
          ),
        ),
        field("Jumlah (RM)", input("amount", { inputmode: "decimal", required: true })),
        field(
          "Kaedah",
          select("method", [
            ["cash", "Tunai"],
            ["duitnow", "DuitNow"],
            ["gateway", "CHIP"],
            ["deposit", "Dari deposit"],
          ]),
        ),
        field("Rujukan", input("reference", { maxlength: "100" })),
        field("Sebab", input("note", { required: true, minlength: "3", maxlength: "500" })),
      ],
      "Tambah entri",
      (form) => {
        const text = value(form, "amount").trim();
        const negative = text.startsWith("-");
        const sen = parseRm(negative ? text.slice(1) : text);
        if (sen === null) return Promise.resolve("Jumlah RM tidak sah.");
        return after(
          send("POST", `${base}/ledger`, {
            type: value(form, "type"),
            amountSen: negative ? -sen : sen,
            method: value(form, "method"),
            reference: value(form, "reference"),
            note: value(form, "note"),
          }),
        );
      },
    ),
  );
  return actions;
}

function showBooking(id: string, container: HTMLElement): void {
  container.replaceChildren(el("p", { class: "muted" }, "Memuatkan…"));
  const refresh = () => {
    showBooking(id, container);
  };
  void api<Detail>(`/api/admin/bookings/${id}`).then((result) => {
    if (!result.ok) {
      container.replaceChildren(el("p", {}, result.error.message));
      return;
    }
    const detail = result.value;
    const b = detail.booking;
    const whatsapp = whatsappUrl(
      b.customer_phone_e164,
      `Hai ${b.customer_name}, ini berkenaan tempahan ${b.ref_code}.`,
    );
    const reverse = (entryId: string) => {
      const note = window.prompt("Sebab pembalikan entri ini?");
      if (!note) return;
      void send("POST", `/api/admin/bookings/${id}/ledger`, { reversesId: entryId, note }).then(
        (outcome) => {
          if (outcome.ok) refresh();
          else window.alert(errorText(outcome));
        },
      );
    };
    container.replaceChildren(
      el(
        "section",
        { class: "card" },
        el(
          "div",
          { class: "ops-row" },
          el("h2", {}, b.ref_code),
          el(
            "span",
            { class: "status-badge", "data-status": b.status },
            BOOKING_STATUS_LABELS[b.status],
          ),
        ),
        b.status_reason ? el("p", { class: "small muted" }, `Sebab: ${b.status_reason}`) : null,
        el(
          "dl",
          { class: "lead__facts" },
          ...[
            ["Pelanggan", b.customer_name],
            ["Telefon", formatMyMobile(b.customer_phone_e164)],
            ["Emel", b.customer_email],
            ["Unit", b.unit_id],
            ["Ambil", `${formatMytDateTime(new Date(b.pickup_at))} · ${b.pickup_location_id}`],
            ["Pulang", `${formatMytDateTime(new Date(b.return_at))} · ${b.return_location_id}`],
            ["Jumlah", `${rm(b.total_payable_sen)} (deposit ${rm(b.deposit_sen)})`],
            ["Baki deposit", rm(detail.depositBalanceSen)],
            ["Resit", b.receipt_no ?? "—"],
            ["MyKad (4 digit)", b.id_last4 ?? "—"],
          ].map(([label, text]) =>
            el("div", {}, el("dt", {}, label ?? ""), el("dd", {}, text ?? "")),
          ),
        ),
        el(
          "a",
          { class: "button button--small", href: whatsapp, target: "_blank", rel: "noopener" },
          "WhatsApp pelanggan",
        ),
      ),
      el(
        "div",
        { class: "ops-actions" },
        ...bookingActions(detail, refresh).filter((c): c is Node | string => !!c),
      ),
      el("h3", {}, "Gambar"),
      detail.photos.length === 0
        ? el("p", { class: "muted small" }, "Tiada gambar.")
        : el(
            "div",
            { class: "ops-photos" },
            ...detail.photos.map((photo) =>
              el(
                "a",
                { href: `/api/admin/photos/${photo.id}`, target: "_blank" },
                el("img", {
                  src: `/api/admin/photos/${photo.id}`,
                  alt: `Gambar ${photo.stage}`,
                  loading: "lazy",
                }),
              ),
            ),
          ),
      el("h3", {}, "Lejar"),
      table(
        ["Masa", "Jenis", "Jumlah", "Kaedah", "Rujukan / nota", ""],
        detail.ledger.map((entry) => {
          const reversed = detail.ledger.some((other) => other.reverses_id === entry.id);
          const button =
            entry.reverses_id || reversed
              ? null
              : el(
                  "button",
                  { class: "button button--small button--ghost", type: "button" },
                  "Balikkan",
                );
          button?.addEventListener("click", () => {
            reverse(entry.id);
          });
          return [
            formatMytDateTime(new Date(entry.created_at)),
            `${LEDGER_TYPE_LABELS[entry.type]}${entry.reverses_id ? " (pembalikan)" : ""}`,
            rm(entry.amount_sen),
            entry.method,
            [entry.reference, entry.note].filter((t) => t !== "").join(" · "),
            button,
          ];
        }),
      ),
      el("h3", {}, "Sejarah status"),
      table(
        ["Masa", "Dari", "Ke", "Oleh", "Sebab"],
        detail.events.map((event) => [
          formatMytDateTime(new Date(event.at)),
          event.from_status ?? "—",
          BOOKING_STATUS_LABELS[event.to_status],
          event.actor_type,
          event.reason ?? "",
        ]),
      ),
    );
  });
}

// ── Calendar ────────────────────────────────────────────────────────────────────────────

function showCalendar(container: HTMLElement): void {
  const from = input("from", { type: "date", value: mytDateString(new Date()) });
  const body = el("div", {});
  const load = () => {
    const to = addDays(from.value, 27);
    void api<{
      locks: {
        unit_id: string;
        date: string;
        kind: string;
        ref_code: string | null;
        status: BookingStatus | null;
        reason: string | null;
      }[];
    }>(`/api/admin/calendar?from=${from.value}&to=${to}`).then((result) => {
      if (!result.ok) {
        body.replaceChildren(el("p", {}, result.error.message));
        return;
      }
      body.replaceChildren(
        result.value.locks.length === 0
          ? el("p", { class: "muted" }, "Semua unit kosong dalam 28 hari ini.")
          : table(
              ["Tarikh", "Unit", "Jenis", "Butiran"],
              result.value.locks.map((lock) => [
                formatMytDate(lock.date),
                lock.unit_id,
                el(
                  "span",
                  { class: "cal-cell", "data-kind": lock.kind },
                  lock.kind === "booking"
                    ? "Tempahan"
                    : lock.kind === "hold"
                      ? "Ditahan"
                      : "Penyelenggaraan",
                ),
                lock.ref_code
                  ? `${lock.ref_code} · ${lock.status ? BOOKING_STATUS_LABELS[lock.status] : ""}`
                  : (lock.reason ?? ""),
              ]),
            ),
      );
    });
  };
  from.addEventListener("change", load);
  container.replaceChildren(el("div", { class: "filters card" }, field("Dari", from)), body);
  load();
}

// ── Units and blocks ────────────────────────────────────────────────────────────────────

interface Unit {
  id: string;
  name: string;
  model: string;
  serial_number: string;
  status: "active" | "maintenance" | "retired";
  accessories: string[];
  sort_order: number;
}

const UNIT_STATUS: readonly [string, string][] = [
  ["active", "Aktif"],
  ["maintenance", "Penyelenggaraan"],
  ["retired", "Bersara"],
];

function showFleet(container: HTMLElement): void {
  const units = el("div", {});
  const blocks = el("div", {});
  const refresh = () => {
    showFleet(container);
  };
  void api<{ units: Unit[] }>("/api/admin/units").then((result) => {
    if (!result.ok) {
      units.replaceChildren(el("p", {}, result.error.message));
      return;
    }
    units.replaceChildren(
      ...result.value.units.map((unit) =>
        actionForm(
          `${unit.id} · ${unit.name}`,
          [
            field("Nama", input("name", { value: unit.name, required: true })),
            field("Model", input("model", { value: unit.model, required: true })),
            field("No. siri", input("serial", { value: unit.serial_number })),
            field("Status", select("status", UNIT_STATUS, unit.status)),
            field("Aksesori (koma)", input("accessories", { value: unit.accessories.join(", ") })),
          ],
          "Simpan unit",
          async (form) => {
            const outcome = await send("PUT", `/api/admin/units/${unit.id}`, {
              name: value(form, "name"),
              model: value(form, "model"),
              serialNumber: value(form, "serial"),
              status: value(form, "status"),
              accessories: accessoriesFrom(form),
              sortOrder: unit.sort_order,
            });
            return outcome.ok ? null : errorText(outcome);
          },
        ),
      ),
      actionForm(
        "Tambah unit",
        [
          field(
            "ID unit (cth. pocket4p-02)",
            input("id", { required: true, pattern: "[A-Za-z0-9-]{1,40}" }),
          ),
          field("Nama", input("name", { required: true })),
          field("Model", input("model", { value: "DJI Osmo Pocket 4P", required: true })),
          field("Status", select("status", UNIT_STATUS, "active")),
        ],
        "Tambah",
        async (form) => {
          const outcome = await send("POST", "/api/admin/units", {
            id: value(form, "id"),
            name: value(form, "name"),
            model: value(form, "model"),
            status: value(form, "status"),
          });
          if (outcome.ok) refresh();
          return outcome.ok ? null : errorText(outcome);
        },
      ),
    );
  });
  void api<{
    blocks: { id: string; unit_id: string; from_date: string; to_date: string; reason: string }[];
  }>("/api/admin/blocks").then((result) => {
    if (!result.ok) return;
    blocks.replaceChildren(
      table(
        ["Unit", "Dari", "Hingga", "Sebab", ""],
        result.value.blocks.map((block) => {
          const remove = el(
            "button",
            { class: "button button--small button--ghost", type: "button" },
            "Buang",
          );
          remove.addEventListener("click", () => {
            void api(`/api/admin/blocks/${block.id}`, { method: "DELETE" }).then(refresh);
          });
          return [
            block.unit_id,
            formatMytDate(block.from_date),
            formatMytDate(block.to_date),
            block.reason,
            remove,
          ];
        }),
      ),
      actionForm(
        "Sekat tarikh (penyelenggaraan)",
        [
          field("ID unit", input("unitId", { required: true })),
          field("Dari", input("from", { type: "date", required: true })),
          field("Hingga", input("to", { type: "date", required: true })),
          field("Sebab", input("reason", { maxlength: "200" })),
        ],
        "Sekat",
        async (form) => {
          const outcome = await send("POST", "/api/admin/blocks", {
            unitId: value(form, "unitId"),
            from: value(form, "from"),
            to: value(form, "to"),
            reason: value(form, "reason"),
          });
          if (outcome.ok) refresh();
          return outcome.ok ? null : errorText(outcome);
        },
      ),
    );
  });
  container.replaceChildren(
    el("h2", {}, "Unit"),
    units,
    el("h2", {}, "Blok penyelenggaraan"),
    blocks,
  );
}

// ── Customers ───────────────────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  name: string;
  phone_e164: string;
  email: string;
  tier: string;
  completed_count: number;
  blocked: number;
  notes: string;
}

function showCustomers(container: HTMLElement): void {
  const phone = input("phone", { type: "tel", placeholder: "012-345 6789" });
  const results = el("div", {});
  const search = el(
    "form",
    { class: "filters card" },
    field("Cari ikut telefon (kosong = terkini)", phone),
    el("button", { class: "button button--small", type: "submit" }, "Cari"),
  );
  const load = () => {
    const query = phone.value.trim() ? `?phone=${encodeURIComponent(phone.value.trim())}` : "";
    void api<{ customers: Customer[] }>(`/api/admin/customers${query}`).then((result) => {
      if (!result.ok) {
        results.replaceChildren(el("p", {}, errorText(result)));
        return;
      }
      results.replaceChildren(
        ...(result.value.customers.length === 0
          ? [el("p", { class: "muted" }, "Tiada pelanggan.")]
          : []),
        ...result.value.customers.map((customer) => {
          const notes = el("textarea", { name: "notes", rows: "2", maxlength: "2000" });
          notes.value = customer.notes;
          return actionForm(
            `${customer.name} · ${formatMyMobile(customer.phone_e164)} · ${customer.completed_count.toString()} selesai`,
            [
              el("p", { class: "small muted" }, customer.email),
              field(
                "Tahap",
                select(
                  "tier",
                  [
                    ["new", "Baharu"],
                    ["verified", "Disahkan"],
                    ["returning", "Kembali"],
                  ],
                  customer.tier,
                ),
              ),
              el(
                "label",
                { class: "check" },
                el("input", { type: "checkbox", name: "blocked", checked: customer.blocked === 1 }),
                el("span", {}, "Sekat daripada menempah"),
              ),
              field("Nota dalaman", notes),
            ],
            "Simpan",
            async (form) => {
              const outcome = await send("PUT", `/api/admin/customers/${customer.id}`, {
                tier: value(form, "tier"),
                blocked: new FormData(form).get("blocked") === "on",
                notes: value(form, "notes"),
              });
              return outcome.ok ? null : errorText(outcome);
            },
          );
        }),
      );
    });
  };
  search.addEventListener("submit", (event) => {
    event.preventDefault();
    load();
  });
  container.replaceChildren(search, results);
  load();
}

// ── Settings ────────────────────────────────────────────────────────────────────────────

const SETTING_HELP: Readonly<Record<string, string>> = {
  handoverSlots:
    "Slot serahan. daysOfWeek: 0 = Ahad … 6 = Sabtu. kinds: pickup/return. locationIds: ID lokasi.",
  peakPeriods: "Tempoh puncak (buffer lebih panjang): from/to yyyy-MM-dd.",
  holdMinutes: "Berapa minit tarikh ditahan sementara pelanggan membayar.",
  minLeadHours: "Tempahan minimum berapa jam sebelum ambil.",
  buffer: "Jam kosong selepas pemulangan: normalHours / peakHours.",
  retention: "Berapa hari gambar serahan disimpan selepas tempahan ditutup.",
};

function showSettings(container: HTMLElement): void {
  void api<{ settings: Record<string, unknown>; editable: string[] }>("/api/admin/settings").then(
    (result) => {
      if (!result.ok) {
        container.replaceChildren(el("p", {}, result.error.message));
        return;
      }
      const { settings, editable } = result.value;
      container.replaceChildren(
        el(
          "p",
          { class: "muted small" },
          "Harga, deposit, tambahan, lokasi dan polisi hanya boleh diubah melalui kemas kini sistem (ADR-020).",
        ),
        ...editable.map((key) => {
          const text = el("textarea", { name: "value", class: "ops-json", spellcheck: "false" });
          text.value = JSON.stringify(settings[key], null, 2);
          return actionForm(
            key,
            [
              el("p", { class: "small muted" }, SETTING_HELP[key] ?? ""),
              field("Nilai (JSON)", text),
            ],
            "Simpan",
            async (form) => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(value(form, "value"));
              } catch {
                return "JSON tidak sah.";
              }
              const outcome = await send("PUT", `/api/admin/settings/${key}`, { value: parsed });
              return outcome.ok ? null : errorText(outcome);
            },
          );
        }),
      );
    },
  );
}

// ── Audit log ───────────────────────────────────────────────────────────────────────────

function showAudit(container: HTMLElement): void {
  const body = el("div", {});
  const more = el(
    "button",
    { class: "button button--ghost", type: "button", hidden: true },
    "Muat lagi",
  );
  let next: string | null = null;
  const rows: Child[][] = [];
  const load = () => {
    void api<{
      entries: {
        at: string;
        actor_email: string;
        action: string;
        target_table: string;
        target_id: string;
        changed_fields: string;
      }[];
      next: string | null;
    }>(`/api/admin/audit-logs${next ? `?before=${encodeURIComponent(next)}` : ""}`).then(
      (result) => {
        if (!result.ok) {
          body.replaceChildren(el("p", {}, result.error.message));
          return;
        }
        rows.push(
          ...result.value.entries.map((entry) => [
            formatMytDateTime(new Date(entry.at)),
            entry.actor_email,
            entry.action,
            `${entry.target_table}/${entry.target_id}`,
            entry.changed_fields,
          ]),
        );
        body.replaceChildren(table(["Masa", "Oleh", "Tindakan", "Rekod", "Medan"], rows));
        next = result.value.next;
        more.hidden = next === null;
      },
    );
  };
  more.addEventListener("click", load);
  container.replaceChildren(body, more);
  load();
}

export function showOps(view: OpsView, container: HTMLElement): void {
  const views: Record<OpsView, (container: HTMLElement) => void> = {
    today: showToday,
    bookings: showBookings,
    calendar: showCalendar,
    fleet: showFleet,
    customers: showCustomers,
    settings: showSettings,
    audit: showAudit,
  };
  views[view](container);
}
