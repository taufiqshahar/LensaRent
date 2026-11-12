import { draft } from "../render/drafts";
import {
  addOns,
  brand,
  cancellation,
  deposit,
  filterBase,
  lateFee,
  listBm,
  locationNames,
  maxDays,
  meetupFree,
  minLeadHours,
} from "./facts";

/**
 * Long-form site content in Bahasa Melayu. Anything the owner has not confirmed is wrapped
 * in `draft()` and blocks a production build until it is (see render/drafts.ts).
 */

export const areaLine = listBm(locationNames);

/**
 * Specifications from launch coverage (Newsshooter, RedShark News, T3), not yet checked
 * against DJI's official sheet. TO CONFIRM against https://www.dji.com/my/osmo-pocket-4p/specs
 * and the actual unit before launch.
 */
export const specs = draft("Spesifikasi Pocket 4P (sahkan dengan dji.com/my)", [
  {
    title: "Dua kamera",
    text: "Kamera utama sensor 1 inci (20 mm, f/2.0) dan kamera tele 1/1.28 inci (60 mm, f/1.8) dengan zum optik 3x.",
  },
  {
    title: "Video 4K yang lancar",
    text: "Rakaman sehingga 4K, dengan gerak perlahan sehingga 4K/240fps pada kamera utama.",
  },
  {
    title: "Gimbal 3 paksi",
    text: "Gambar kekal stabil walaupun anda berjalan, menaiki kenderaan atau merakam sambil bercakap.",
  },
  {
    title: "Warna untuk editing",
    text: "Mod D-Log 2 dengan julat dinamik yang luas, sesuai jika anda mahu mewarna semula video.",
  },
]);

/** TO CONFIRM: what is actually in the rental kit, ideally with photos. */
export const kit = draft("Senarai kit sewaan", [
  "Kamera DJI Osmo Pocket 4P",
  "Kabel pengecas USB-C",
  "Sarung pelindung",
]);

export const optionalKit = addOns.map((item) => item.name);

export const steps = [
  {
    title: "Semak tarikh",
    text: "Isi borang di bawah atau WhatsApp kami dengan tarikh yang anda mahu.",
  },
  {
    title: "Kami sahkan",
    text: "Kami semak ketersediaan dan maklumkan jumlah bayaran serta slot serahan melalui WhatsApp.",
  },
  draft("Langkah bayaran & pengesahan identiti (Fasa 1, manual)", {
    title: "Ambil kamera",
    text: `Jumpa kami di ${areaLine}. Bawa MyKad untuk pengesahan, buat bayaran sewa dan deposit ${deposit}, dan semak kit bersama kami.`,
  }),
  {
    title: "Pulangkan",
    text: `Pulangkan pada slot yang dipersetujui. Deposit ${deposit} dipulangkan selepas pemeriksaan unit.`,
  },
];

export const slotsNote =
  "Serahan dan pemulangan dibuat dalam slot masa tetap. Slot yang tersedia untuk tarikh anda akan dimaklumkan melalui WhatsApp.";

export const meetupNote = meetupFree
  ? `Serahan percuma di ${areaLine}.`
  : `Serahan di ${areaLine}. Caj lokasi dimaklumkan semasa pengesahan.`;

export interface Faq {
  question: string;
  answer: string;
}

export const faqs: Faq[] = [
  {
    question: "Berapakah harga sewa?",
    answer: `Rujuk jadual harga di atas. Harga dikira mengikut bilangan hari; setiap 24 jam yang dimulakan dikira sebagai satu hari. Sewaan paling lama ${maxDays.toString()} hari.`,
  },
  {
    question: "Adakah deposit dipulangkan?",
    answer: `Ya. Deposit ${deposit} bukan sebahagian daripada harga sewa. Ia dipulangkan sepenuhnya selepas unit dipulangkan dan diperiksa, kecuali jika ada caj lewat, kerosakan atau aksesori yang hilang.`,
  },
  {
    question: "Bagaimana deposit dipulangkan?",
    answer: "Deposit dipulangkan melalui DuitNow ke akaun anda selepas pemeriksaan unit selesai.",
  },
  {
    question: "Berapa awal saya perlu menempah?",
    answer: `Sekurang-kurangnya ${minLeadHours.toString()} jam sebelum masa ambil. Lebih awal lebih baik, terutamanya untuk hujung minggu dan musim cuti.`,
  },
  {
    question: "Di mana saya boleh mengambil kamera?",
    answer: `Di ${areaLine}, dalam slot masa yang dipersetujui. ${meetupNote}`,
  },
  {
    question: "Apakah dokumen yang perlu dibawa?",
    answer:
      "MyKad yang sah untuk pengesahan identiti. Kami hanya merekod empat digit terakhir nombor IC dalam sistem; kami tidak menyimpan salinan MyKad secara digital.",
  },
  {
    question: "Bagaimana jika saya perlu membatalkan tempahan?",
    answer: `Lebih ${cancellation.fullAbove.toString()} jam sebelum ambil: bayaran dipulangkan sepenuhnya (tolak caj gerbang pembayaran). Antara ${cancellation.feeFrom.toString()} hingga ${cancellation.fullAbove.toString()} jam: tukar tarikh sekali secara percuma, atau dapatkan bayaran balik tolak ${cancellation.fee}. Kurang ${cancellation.feeFrom.toString()} jam atau tidak hadir: ${cancellation.fee} dilucutkan, baki termasuk deposit dipulangkan.`,
  },
  {
    question: "Bagaimana jika saya lewat memulangkan kamera?",
    answer: `Ada tempoh ihsan ${lateFee.grace.toString()} minit. Selepas itu, caj ${lateFee.perBlock} dikenakan bagi setiap ${lateFee.blockHours.toString()} jam yang dimulakan, maksimum ${lateFee.cap} bagi setiap 24 jam.`,
  },
  {
    question: "Ada aksesori tambahan?",
    answer:
      optionalKit.length > 0
        ? `Ada: ${listBm(optionalKit)}. Jika anda memilih mana-mana penapis lensa, ${filterBase} disertakan secara percuma.`
        : "Tiada aksesori tambahan buat masa ini.",
  },
  {
    question: `Adakah ${brand} menghantar kamera?`,
    answer: `Buat masa ini tidak. Serahan dan pemulangan dibuat secara bersemuka di ${areaLine}.`,
  },
];
