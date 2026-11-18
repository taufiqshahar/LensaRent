import type { LedgerEntryType } from "./ledger";
import type { BookingStatus } from "./stateMachine";

/**
 * Bahasa Melayu labels for the booking UI and the admin panel. Kept apart from the zod
 * schemas so browser bundles can import them without pulling zod in.
 */
export const BOOKING_STATUS_LABELS: Readonly<Record<BookingStatus, string>> = {
  pending_payment: "Menunggu bayaran",
  confirmed: "Disahkan",
  ready_for_pickup: "Sedia untuk diambil",
  active_rental: "Sedang disewa",
  overdue: "Lewat dipulangkan",
  return_inspection: "Pemeriksaan pemulangan",
  disputed: "Dalam pertikaian",
  refund_pending: "Menunggu bayaran balik",
  completed: "Selesai",
  refunded: "Dibayar balik",
  cancelled: "Dibatalkan",
};

/** What the customer should know or do next, per status. */
export const BOOKING_STATUS_HELP: Readonly<Record<BookingStatus, string>> = {
  pending_payment: "Tarikh anda ditahan sementara. Lengkapkan bayaran sebelum masa tamat.",
  confirmed: "Bayaran diterima. Kami akan menghubungi anda sebelum hari ambil.",
  ready_for_pickup: "Kamera sudah disediakan. Jumpa anda di lokasi dan slot yang dipilih.",
  active_rental: "Selamat merakam! Sila pulangkan dalam slot pulang yang dipilih.",
  overdue: "Slot pulang sudah lepas. Sila hubungi kami melalui WhatsApp segera.",
  return_inspection: "Kamera sedang diperiksa. Deposit akan dipulangkan selepas itu.",
  disputed: "Kami akan menghubungi anda tentang pemeriksaan kamera.",
  refund_pending: "Bayaran balik sedang diproses. Kami akan menghubungi anda.",
  completed: "Tempahan selesai. Terima kasih kerana menyewa dengan kami!",
  refunded: "Bayaran balik telah dihantar.",
  cancelled: "Tempahan ini telah dibatalkan.",
};

export const LEDGER_TYPE_LABELS: Readonly<Record<LedgerEntryType, string>> = {
  RENTAL: "Sewa",
  ADD_ON: "Tambahan",
  MEETUP_FEE: "Caj lokasi",
  DISCOUNT: "Diskaun",
  DEPOSIT_IN: "Deposit diterima",
  DEPOSIT_REFUND: "Deposit dipulangkan",
  DEPOSIT_DEDUCTION: "Potongan deposit",
  LATE_FEE: "Caj lewat",
  DAMAGE_CHARGE: "Caj kerosakan",
  CANCELLATION_FEE: "Caj pembatalan",
  REFUND: "Bayaran balik",
  GATEWAY_FEE: "Fi gerbang bayaran",
};
