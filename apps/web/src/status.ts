import { BOOKING_STATUS_HELP, BOOKING_STATUS_LABELS } from "@lensarent/shared/bookingLabels";
import { formatRM } from "@lensarent/shared/money";
import type { BookingStatus } from "@lensarent/shared/stateMachine";
import { formatMytDateTime } from "@lensarent/shared/time";
import { isRefCode, isToken, recallBooking, rememberBooking } from "./bookingStore";
import { byId, el } from "./dom";

/**
 * /tempahan?ref=PK-XXXXXX — a booking's status, for the customer who holds its token
 * (from this browser's storage, or from the emailed link's #t= fragment).
 */
interface View {
  refCode: string;
  status: BookingStatus;
  pickupAt: string;
  pickupLocationId: string;
  returnAt: string;
  returnLocationId: string;
  rentalDays: number;
  breakdown: {
    rentalSen: number;
    addOnsSen: number;
    meetupSen: number;
    depositSen: number;
    totalPayableSen: number;
  };
  holdExpiresAt: string | null;
  checkoutUrl: string | null;
  receiptNo: string | null;
}

const PAYMENT_NOTES: Readonly<Record<string, string>> = {
  berjaya: "Bayaran anda sedang disahkan. Halaman ini akan dikemas kini sebentar lagi.",
  gagal: "Bayaran tidak berjaya. Anda boleh cuba sekali lagi sebelum masa tahanan tamat.",
  batal: "Bayaran dibatalkan. Anda boleh cuba sekali lagi sebelum masa tahanan tamat.",
};

const root = byId("status-app", HTMLElement);
const params = new URLSearchParams(window.location.search);
const ref = (params.get("ref") ?? "").toUpperCase();
const payment = params.get("bayaran") ?? "";

function rm(sen: number): string {
  return formatRM(sen).replace(/\.00$/, "");
}

function show(...nodes: (Node | null)[]): void {
  root?.replaceChildren(...nodes.filter((node): node is Node => node !== null));
}

function row(label: string, value: string): HTMLElement {
  return el("div", {}, el("dt", {}, label), el("dd", {}, value));
}

function render(view: View): void {
  const pending = view.status === "pending_payment";
  show(
    el(
      "p",
      { class: "status-badge", "data-status": view.status },
      BOOKING_STATUS_LABELS[view.status],
    ),
    el("p", {}, BOOKING_STATUS_HELP[view.status]),
    pending && PAYMENT_NOTES[payment]
      ? el("p", { class: "form-status" }, PAYMENT_NOTES[payment] ?? "")
      : null,
    el(
      "dl",
      { class: "calculator__result" },
      row("Rujukan", view.refCode),
      row("Ambil", formatMytDateTime(new Date(view.pickupAt))),
      row("Pulang", formatMytDateTime(new Date(view.returnAt))),
      row("Tempoh", `${view.rentalDays.toString()} hari`),
      row(
        "Sewa + tambahan",
        rm(view.breakdown.rentalSen + view.breakdown.addOnsSen + view.breakdown.meetupSen),
      ),
      row("Deposit (dipulangkan)", rm(view.breakdown.depositSen)),
      row("Jumlah", rm(view.breakdown.totalPayableSen)),
      view.receiptNo ? row("No. resit", view.receiptNo) : null,
      pending && view.holdExpiresAt
        ? row("Tahanan tamat", formatMytDateTime(new Date(view.holdExpiresAt)))
        : null,
    ),
    view.checkoutUrl
      ? el("a", { class: "button button--block", href: view.checkoutUrl }, "Teruskan bayaran")
      : null,
  );
}

let attempts = 0;
function load(token: string): void {
  void fetch(`/api/bookings/lookup?ref=${encodeURIComponent(ref)}`, {
    headers: { "x-booking-token": token },
  })
    .then(async (response) => (response.ok ? ((await response.json()) as View) : null))
    .catch(() => null)
    .then((view) => {
      if (!view) {
        show(
          el("p", {}, "Tempahan tidak dijumpai. Buka pautan dalam emel anda, atau hubungi kami."),
        );
        return;
      }
      render(view);
      // Just back from CHIP: the payment callback may take a few seconds to arrive.
      if (view.status === "pending_payment" && payment === "berjaya" && attempts < 20) {
        attempts++;
        window.setTimeout(() => {
          load(token);
        }, 3000);
      }
    });
}

function start(): void {
  if (!isRefCode(ref)) {
    show(el("p", {}, "Pautan tidak lengkap. Buka pautan dalam emel anda."));
    return;
  }
  // A token in the fragment (from an email) is saved, then removed from the address bar.
  const fragment = new URLSearchParams(window.location.hash.slice(1)).get("t") ?? "";
  if (isToken(fragment)) {
    rememberBooking(ref, fragment);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  const token = isToken(fragment) ? fragment : recallBooking(ref);
  if (!token) {
    show(el("p", {}, "Buka pautan dalam emel pengesahan anda untuk melihat tempahan ini."));
    return;
  }
  load(token);
}

start();
