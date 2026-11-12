# Logik Tempahan & Inventori

Peraturan bisnes seperti yang dilaksanakan dalam `packages/shared` dan
`apps/worker/src/lib/availabilityLocks.ts`. Setiap nilai di bawah datang daripada dokumen
`settings/*`; tiada yang di-hardcode. Item bertanda ⚠️ menunggu pengesahan pemilik.

**Status:** peraturan dan kunci slot siap (Fasa 0). Aliran hold → bayar → sah tiba pada
Fasa 2.

## Wang dan masa

- Semua wang ialah **integer sen**. `sumSen` / `multiplySen` menolak float dan integer
  tidak selamat. Codec Firestore turut menolak nombor bukan integer.
- Semua masa ialah instant UTC; hari kalendar ialah rentetan `yyyy-MM-dd` dalam **MYT**
  (UTC+8, tiada DST). Hari bertukar pada 16:00 UTC.

## Tempoh sewa

`rentalDays = ceil((returnAt − pickupAt) / 24 jam)`, minimum 1.

| Tempoh                  | Hari dicaj |
| ----------------------- | ---------- |
| 1 jam – 24 jam          | 1          |
| 24 jam 1 minit – 48 jam | 2          |
| 7 × 24 jam              | 7          |

Semakan tempoh (`validateRentalPeriod`):

- pemulangan mesti selepas pickup;
- pickup sekurang-kurangnya `minLeadHours` (24) dari sekarang — tepat 24 jam diterima;
- `rentalDays ≤ maxRentalDays` (7).

## Harga

| Hari          | Harga          |
| ------------- | -------------- |
| 1             | RM69.00        |
| 2             | RM120.00       |
| 3             | RM170.00       |
| 4 dan ke atas | RM50.00 × hari |

`quote()` mengira dan memulangkan pecahan berikut. Harga daripada klien tidak pernah
dipercayai.

| Medan             | Kiraan                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| `rentalSen`       | Jadual di atas                                                            |
| `addOnsSen`       | Σ (harga add-on × kuantiti)                                               |
| `meetupSen`       | Yuran lokasi pickup + yuran lokasi pemulangan ⚠️                          |
| `discountSen`     | 0 pada MVP; tidak boleh melebihi caj sewa; tidak pernah menyentuh deposit |
| `depositSen`      | `depositTiers[tier]` — RM100 rata untuk semua tier                        |
| `totalPayableSen` | sewa + add-on + meetup − diskaun + deposit                                |

**Add-on.** Penapis CPL dan VND 2-32, RM5 setiap satu ⚠️ (sekali setiap tempahan,
maksimum 1 setiap jenis). Apabila mana-mana penapis lensa dipilih, Magnetic Filter Base
disertakan automatik dan percuma (`includedItems`); ia bukan item yang boleh dipilih.

**Deposit** ialah liabiliti, bukan hasil, dan sentiasa dipaparkan berasingan. Tier
pelanggan direkod untuk risiko dan laporan tetapi tidak mengubah amaun pada MVP.

Contoh: 3 hari + CPL + VND = RM170 + RM10 + deposit RM100 = **RM280.00**.

## Hari yang dikunci

Satu tempahan mengunci setiap hari kalendar (MYT) dari **hari pickup** hingga **hari
buffer selepas pemulangan berakhir**:

```
hari dikunci = tarikh(pickupAt) … tarikh(returnSlotEnd + buffer − 1 ms)
```

- `buffer` = 12 jam; 24 jam jika tarikh pemulangan jatuh dalam `peakPeriods` ⚠️.
- Unit bebas tepat pada saat buffer tamat, jadi buffer yang berakhir tepat tengah malam
  **tidak** mengunci hari berikutnya; satu minit selepas itu mengunci.

| Pickup       | Slot pulang tamat | Buffer tamat | Hari dikunci            |
| ------------ | ----------------- | ------------ | ----------------------- |
| Sabtu 09:00  | Ahad 10:00        | Ahad 22:00   | Sabtu, Ahad             |
| Jumaat 20:00 | Sabtu 22:00       | Ahad 10:00   | Jumaat, Sabtu, **Ahad** |
| Sabtu 09:00  | Ahad 12:00        | Isnin 00:00  | Sabtu, Ahad             |
| Sabtu 09:00  | Ahad 12:01        | Isnin 00:01  | Sabtu, Ahad, **Isnin**  |

### Nota bisnes: penggunaan unit

Kunci peringkat hari adalah ringkas dan selamat, tetapi kasar: satu unit melayan paling
banyak satu tempahan pada mana-mana hari kalendar. Sewaan 1 hari (RM69) dengan slot
pulang malam mengunci **3 hari**. Dengan satu unit, ini mengehadkan kira-kira 10–15
tempahan sebulan.

Pilihan untuk dinilai dengan data sebenar (Fasa 3), tanpa mengubah kod — semuanya
`settings`:

- slot pemulangan pagi/tengah hari supaya buffer tamat pada hari yang sama;
- memendekkan `buffer.normalHours`;
- harga yang menggalakkan sewaan lebih panjang.

## Anti double-booking

Lihat [DECISIONS.md, ADR-002](DECISIONS.md) untuk sebab dan bukti.

- Satu dokumen per unit per hari: `availabilityLocks/{unitId}_{yyyy-MM-dd}`. **Dokumen
  wujud = hari itu dikunci.**
- `acquireDayLocks` mencipta semua hari dalam **satu commit atomik**, setiap satu dengan
  precondition "mesti belum wujud", bersama write pemanggil (dokumen `bookings`,
  `bookingEvents`). Mana-mana hari sudah diambil → seluruh commit ditolak, tiada apa-apa
  ditulis, dan hari yang bertembung dipulangkan.
- `releaseDayLocks` memadam kunci milik pemilik yang diberi sahaja, dalam transaction,
  bersama write pemanggil (contoh: status → `cancelled`).

| Jenis kunci (`kind`) | Pemilik     | Bila                                            |
| -------------------- | ----------- | ----------------------------------------------- |
| `hold`               | `bookingId` | Tempahan `pending_payment`; ada `holdExpiresAt` |
| `booking`            | `bookingId` | Tempahan disahkan                               |
| `maintenance`        | `blockId`   | Blok penyelenggaraan / blackout oleh admin      |

Blok penyelenggaraan menggunakan mekanisme yang sama, jadi ia tidak boleh menindih hari
yang sudah ditempah, dan sebaliknya.

**Jaminan yang diuji** (emulator, setiap CI):

- 20 permintaan serentak untuk hari bertindih × 50 pusingan → tepat 1 berjaya setiap
  pusingan; tiada kunci atau booking yatim.
- Kunci dilepaskan → tepat 1 daripada 10 yang menunggu mendapatnya.
- Pemilik lain tidak boleh melepaskan kunci orang.
- Dokumen kunci yang rosak dianggap "sudah diambil".

## State machine

Jadual penuh dalam `packages/shared/src/stateMachine.ts` (sama dengan master prompt §7).

```
pending_payment ─► confirmed ─► ready_for_pickup ─► active_rental ─► return_inspection ─► completed
      │                │               │                  │                 │
      ├─► cancelled    └───────┬───────┘                  ▼                 ▼
      │                        ▼                       overdue ────────► disputed ─► completed
      └──────────────► refund_pending ─► refunded
```

- `canTransition(from, to, actor)` ialah satu-satunya definisi; UI dan Worker
  menggunakannya. Diuji untuk kesemua 363 gabungan status × status × actor.
- Actor: `system` (cron), `admin`, `webhook`.
- Terminal: `completed`, `refunded`, `cancelled`.
- `→ completed` memerlukan baki deposit tepat 0 (`depositBalanceSen`).

Kesan peralihan terhadap kunci (dilaksana Fasa 2):

| Peralihan                                                      | Kunci                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pending_payment → confirmed`                                  | `hold` → `booking`, kosongkan `holdExpiresAt`                    |
| `→ cancelled` / `refund_pending` (sebelum pickup) / `refunded` | Dilepaskan (dipadam)                                             |
| `→ completed` awal                                             | Hari yang tidak lagi diperlukan dilepaskan                       |
| `→ overdue`                                                    | Kekal; tempahan seterusnya yang terjejas dilaporkan kepada admin |

## Deposit dan ledger

Entri ledger bertanda dan **append-only**; pembetulan ialah entri reversal baharu.

```
baki deposit = Σ amountSen bagi DEPOSIT_IN, DEPOSIT_REFUND, DEPOSIT_DEDUCTION
```

Contoh lewat pulang RM15 ditolak daripada deposit:

| Entri               | Amaun                     |
| ------------------- | ------------------------- |
| `DEPOSIT_IN`        | +10000                    |
| `LATE_FEE`          | +1500                     |
| `DEPOSIT_DEDUCTION` | −1500                     |
| `DEPOSIT_REFUND`    | −8500                     |
| **Baki deposit**    | **0** → boleh `completed` |

## Lewat pulang

- Tiada caj dalam grace 30 minit selepas `returnSlotEnd`. Selepas itu status → `overdue`.
- Kelewatan dikira dari `returnSlotEnd` ⚠️. RM15 bagi setiap blok 6 jam yang dimulakan,
  dihadkan RM69 bagi setiap 24 jam ⚠️.
- `lateFeeSen` hanya **cadangan**; admin mesti meluluskan sebelum ia menjadi entri
  `LATE_FEE`.

| Lewat                 | Caj  |
| --------------------- | ---- |
| ≤ 30 minit            | RM0  |
| 31 minit – 6 jam      | RM15 |
| 6 jam 1 saat – 12 jam | RM30 |
| 24 jam                | RM60 |
| 24 jam 1 minit        | RM75 |

## Pembatalan

`cancellationOutcome` mengira hasilnya; refund dihantar manual oleh admin dan direkod.

| Bila                                    | Hasil                                                      |
| --------------------------------------- | ---------------------------------------------------------- |
| Lebih 72 jam sebelum pickup             | Refund penuh tolak yuran gateway sebenar                   |
| 24 – 72 jam (kedua-dua hujung inklusif) | Satu kali tukar tarikh percuma, **atau** refund tolak RM30 |
| Kurang 24 jam, atau tidak hadir         | RM30 dilucutkan; baki termasuk deposit dipulangkan         |
| Dibatal oleh perniagaan                 | Refund 100%, tiada potongan                                |

Refund tidak pernah negatif: yuran dan potongan dihadkan kepada jumlah yang dibayar.
