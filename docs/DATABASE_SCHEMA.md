# Skema Firestore

Firestore (Native mode), lokasi `asia-southeast1`. Semua koleksi berada di peringkat
atas. Dokumen ini ialah reka bentuk sasaran; lajur **Fasa** menunjukkan bila kod yang
menulis koleksi itu dibina.

**Status Fasa 1:** koleksi yang ada kod penulis: `availabilityLocks` (Fasa 0), `leads`,
`adminSessions`, `rateLimits` dan `auditLogs`. `settings/*` disahkan zod tetapi belum
ditulis (nilai datang daripada `DEFAULT_SETTINGS`). Koleksi lain dimuktamadkan dengan skema
zod pada fasanya.

## Peraturan umum

- **Firestore tidak mengesahkan apa-apa.** Tiada constraint, tiada unique index, tiada
  foreign key. Setiap dokumen disahkan oleh zod di Worker sebelum ditulis.
- Wang: integer sen, medan berakhiran `Sen`. Codec menolak nombor bukan integer.
- Masa: Firestore Timestamp (`Date` dalam kod). Hari kalendar: rentetan `yyyy-MM-dd` (MYT).
- `createdAt` / `updatedAt` ditulis oleh Worker dengan masa pelayan (`serverTimestamp()`).
- ID dokumen: auto-id, kecuali koleksi yang menggunakan **ID deterministik** sebagai
  kunci atau kunci idempotency.
- Tiada nilai sensitif (kunci API, private key) disimpan di Firestore.

## Koleksi

| Koleksi                                   | ID                  | Fasa  |
| ----------------------------------------- | ------------------- | ----- |
| `settings/{key}`                          | Nama kunci          | 1–2   |
| `leads/{leadId}`                          | auto                | 1     |
| `units/{unitId}`                          | slug, cth. `unit01` | 2     |
| `customers/{customerId}`                  | auto                | 2     |
| `bookings/{bookingId}`                    | auto                | 2     |
| `availabilityLocks/{unitId}_{yyyy-MM-dd}` | **deterministik**   | **0** |
| `bookingEvents/{eventId}`                 | auto                | 2     |
| `payments/{paymentId}`                    | auto                | 2     |
| `ledgerEntries/{entryId}`                 | auto                | 2     |
| `webhookEvents/{provider}_{eventKey}`     | **deterministik**   | 2     |
| `notificationsOutbox/{notificationId}`    | auto                | 2     |
| `receiptCounters/{year}`                  | tahun               | 2     |
| `auditLogs/{logId}`                       | auto                | **1** |
| `adminSessions/{sha256(token)}`           | **hash token**      | **1** |
| `rateLimits/{rule}_{hash}_{window}`       | **deterministik**   | **1** |

Tiada koleksi `admins`: status admin ialah custom claim `admin: true` pada akaun Firebase
Auth.

### `settings/{key}`

`{ value: map, updatedBy, updatedAt }`. `value` disahkan oleh
`settingsSchemas[key]` (`packages/shared/src/schemas.ts`).

| Kunci             | Bentuk `value`                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `pricing`         | `{ fixedPrices: [{ days, priceSen }], dailyRateSen }`                                               |
| `addOns`          | `{ items: [{ code, name, priceSen, maxQty, active, lensFilter }], lensFilterBase: { code, name } }` |
| `meetupLocations` | `{ locations: [{ id, name, feeSen, active }] }`                                                     |
| `handoverSlots`   | `{ slots: [{ id, label, daysOfWeek[], startTime, endTime, kinds[], locationIds[], active }] }`      |
| `depositTiers`    | `{ new, verified, returning }`                                                                      |
| `buffer`          | `{ normalHours, peakHours }`                                                                        |
| `peakPeriods`     | `{ periods: [{ from, to, label? }] }`                                                               |
| `holdMinutes`     | `{ minutes }`                                                                                       |
| `minLeadHours`    | `{ hours }`                                                                                         |
| `maxRentalDays`   | `{ days }`                                                                                          |
| `lateFee`         | `{ graceMinutes, blockHours, perBlockSen, capPer24hSen }`                                           |
| `cancellation`    | `{ fullRefundAboveHours, feeWindowFromHours, feeSen }`                                              |
| `policyVersions`  | `{ terms, privacy, rentalPolicy }`                                                                  |
| `businessInfo`    | `{ brandName, legalName, ssmNumber, address, phoneE164, whatsappE164, email }`                      |

Nilai awal: `packages/shared/src/defaultSettings.ts`. Tempoh retention (foto, data
pelanggan) akan ditambah sebagai kunci baharu pada Fasa 2/3.

### `availabilityLocks/{unitId}_{yyyy-MM-dd}`

Satu dokumen per unit per hari. **Kewujudan dokumen ialah kunci.**

| Medan           | Jenis                                | Nota                            |
| --------------- | ------------------------------------ | ------------------------------- |
| `unitId`        | string                               |                                 |
| `date`          | string `yyyy-MM-dd`                  | MYT                             |
| `kind`          | `hold` \| `booking` \| `maintenance` |                                 |
| `bookingId`     | string \| null                       | Pemilik bagi `hold` / `booking` |
| `blockId`       | string \| null                       | Pemilik bagi `maintenance`      |
| `holdExpiresAt` | Timestamp \| null                    | Hanya untuk `hold`              |
| `createdAt`     | Timestamp                            | Masa pelayan                    |

Berbeza daripada master prompt §4: tiada medan `active`. Kunci dilepaskan dengan
**memadam** dokumen (ADR-002). `blockId` ditambah supaya blok penyelenggaraan mempunyai
pemilik yang jelas.

### `units/{unitId}`

`name, model, serialNumber, status` (`active` / `maintenance` / `retired`),
`accessories: [{ code, name, serial?, replacementPriceSen }]`.

### `customers/{customerId}`

`phoneHash` (HMAC-SHA256 nombor E.164 dengan pepper), `name, phoneE164, email, tier`
(`new` / `verified` / `returning`), `completedCount, blocked, notes`.

Keunikan `phoneHash` dikuatkuasakan oleh Worker (query + create dalam transaction).

### `bookings/{bookingId}`

`refCode, lookupTokenHash, unitId, customerId, customerSnapshot, pickupSlotId, pickupAt,
pickupLocationId, returnSlotId, returnAt, returnSlotEnd, returnLocationId, rentalDays,
addOns, priceBreakdown` (`rentalSen, addOnsSen, meetupSen, discountSen, depositSen,
totalPayableSen`), `status, statusReason, holdExpiresAt, consent` (`termsVersion,
privacyVersion, at, ipHash`), `verification` (`idLast4, verifiedBy, verifiedAt`),
`handover, returnInspection, flags[]`.

- `refCode`: pendek, rawak, tanpa aksara mengelirukan (cth. `PK-7F3K9Q`).
- `lookupToken`: 32 byte rawak; hanya hash SHA-256 disimpan.
- **Tiada imej MyKad dan tiada nombor IC penuh** — hanya 4 digit akhir.

### `bookingEvents/{eventId}`

`bookingId, fromStatus, toStatus, actorId, actorType` (`system` / `admin` / `webhook`),
`reason, at`. Ditulis dalam commit yang sama dengan perubahan status.

### `payments/{paymentId}`

`bookingId, provider, providerRef, kind, expectedSen, paidSen, currency, status,
rawStatus, paidAt`. Keunikan `providerRef` disemak oleh Worker.

### `ledgerEntries/{entryId}`

`bookingId, type, amountSen` (bertanda), `method` (`gateway` / `duitnow` / `cash`),
`reference, note, createdBy, createdAt`.

**Append-only.** Worker hanya mencipta; tidak pernah mengemas kini atau memadam.
Pembetulan = entri reversal. Jenis: `RENTAL`, `ADD_ON`, `MEETUP_FEE`, `DISCOUNT`,
`DEPOSIT_IN`, `DEPOSIT_REFUND`, `DEPOSIT_DEDUCTION`, `LATE_FEE`, `DAMAGE_CHARGE`,
`CANCELLATION_FEE`, `REFUND`, `GATEWAY_FEE`.

### `webhookEvents/{provider}_{eventKey}`

`provider, eventKey, receivedAt, processedAt, result`. ID deterministik ialah kunci
idempotency: `create` kedua gagal dengan `ALREADY_EXISTS` → `already_processed`.

### `notificationsOutbox/{notificationId}`

`channel` (`email`), `template, toAddress, payload, status` (`pending` / `sent` /
`failed`), `attempts, lastError, sendAfter, sentAt`.

### `receiptCounters/{year}`

`lastNumber`. Dinaikkan dalam transaction untuk nombor resit berjujukan (`R-2026-00001`).

### `leads/{leadId}`

ID 20 aksara (format auto-id Firestore, dijana Worker). Skema: `leadDocumentSchema`
(`packages/shared/src/leads.ts`).

| Medan                    | Jenis          | Nota                                                                 |
| ------------------------ | -------------- | -------------------------------------------------------------------- |
| `name`                   | string         | 2–80 aksara                                                          |
| `phoneE164`              | string         | `+601…`                                                              |
| `phoneHash`              | string         | HMAC (`phone:`), untuk had kadar                                     |
| `desiredDate`            | string \| null | `yyyy-MM-dd` MYT; null = belum pasti                                 |
| `usage`                  | enum           | `vlog` `travel` `event` `content` `family` `other`                   |
| `source`                 | enum           | `tiktok` `instagram` `facebook` `whatsapp` `google` `friend` `other` |
| `status`                 | enum           | `new` → `contacted` / `converted` / `not_interested` / `spam`        |
| `notes`                  | string         | ≤ 2,000 aksara, admin sahaja                                         |
| `consent`                | map            | `{ privacyVersion, at }`                                             |
| `createdAt`, `updatedAt` | Timestamp      | Masa pelayan                                                         |

Tiada IP mentah. Satu-satunya index composite: `(status ASC, createdAt DESC)`.

### `auditLogs/{logId}`

`actorId, action, targetCollection, targetId, changedFields[], at`. Nama medan sahaja,
tanpa nilai PII. Tindakan Fasa 1: `admin.login`, `admin.logout`, `lead.update`.

### `adminSessions/{sha256(token)}`

`uid, email, createdAt, expiresAt` (mutlak, +8 jam), `idleExpiresAt` (+60 minit, dilanjutkan
setiap ≥ 5 minit aktiviti), `ipHash`. Token itu sendiri hanya wujud dalam cookie
HttpOnly; dokumen dipadam semasa log keluar, apabila tamat, atau oleh
`grant-admin --revoke`. TTL pada `expiresAt`.

### `rateLimits/{rule}_{hash}_{window}`

`count` (dinaikkan dengan `increment` atomik), `expiresAt` (hujung tetingkap). Kunci
sentiasa hash. TTL pada `expiresAt`. Lihat ADR-007.

## Cloud Storage

`handover/{bookingId}/{checkout|return}/{uuid}.jpg`, ≤ 8 MB, `image/*`. Tiada akses awam;
muat naik/turun melalui signed URL berumur pendek yang dijana Worker (Fasa 2).

## Index

`firebase/firestore.indexes.json`:

| Jenis     | Koleksi         | Medan                        |
| --------- | --------------- | ---------------------------- |
| Composite | `leads`         | `status ASC, createdAt DESC` |
| TTL       | `rateLimits`    | `expiresAt` (tanpa index)    |
| TTL       | `adminSessions` | `expiresAt`                  |

Fail disahkan dengan validator `firebase-tools`. ⚠️ Polisi TTL memadam dokumen dalam masa
kira-kira 24 jam selepas tamat, bukan serta-merta. Kod tidak bergantung pada pemadaman
itu: sesi dan kaunter tamat disemak dalam kod. ⚠️ Emulator **tidak** menguatkuasakan composite index — setiap
query baharu yang menggabungkan penapis dan susunan pada medan berbeza mesti disemak dan
index-nya ditambah sebelum deploy.
