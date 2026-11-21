# VERIFY-REPORT-CSV-FIX — csv-reader-speed-01-run-20261121 (ronde perbaikan)

Tanggal: 21 Nov 2026 ~21:00 WIB. Builder: subagent FRESH (sesi ini).
Tugas: audit + perbaiki entry round 1 (commit 9b1ead4, submission 01a1fc5f) sekecil
apa pun kelemahannya, seperti ronde poles v4 news-image. JANGAN submit/push —
laporan ini untuk koordinator; slot ke-3 tetap cadangan.

## Ringkasan

- **Kebenaran v1: tidak ada cacat.** Semua uji kebenaran lolos pada v1
  (practice 6/6 vs `expected.json`, 170/170 edge case vs oracle).
  Kelemahan v1 semuanya soal **kecepatan**, bukan kebenaran.
- **Perbaikan: `solve.js` ditulis ulang (v2)** — field reader di-inline ke dalam
  record loop (tanpa function call + tanpa objek scratch per field), cek CR
  unquoted memakai cache CR, hitung line-break span quoted memakai indexOf
  native, normalisasi CR memakai satu regex replace.
- **Hasil ukur (paired, 25 ronde, set practice 6 kasus, ~10,6 MB): v2 lebih
  cepat dari v1 dengan median 1,14x (mean 1,20x), menang 22/25 ronde;
  v2 4,13x lebih cepat dari oracle (baseline csv-reader 1.0.0).**
- **Eksperimen v3 (batch split) DICOBA dan DITOLAK** — terukur LEBIH LAMBAT
  (0,63x), tidak dipakai.
- **Verifikasi: grade-local 6/6 passed, L1 regrade byte-identik, dua run
  manual byte-identik. Tidak ada regresi.**

## 1. Audit — yang diperiksa

Dibaca: `solve.js` (v1), `main.ts`, `RULES.txt`,
`~/workspace/custom-skills/makefun_bounties/SKILL.md`, `~/workspace/makefun/skill.md`,
`program/generator/subject/csv-cases.mjs` (distribusi kasus yang akan di-draw).

Fakta distribusi (dari generator + practice set):

- 6 kasus/set, 1,4–2,0 MB/kasus, 8–18 kolom, ~8–18 ribu record/kasus.
- Broken kinds jarang: short 1%, long 1%, stray CR 0,4%, quote junk 0,4%,
  blank line 0,3%. Unterminated quote di 50% file (20 record terakhir).
- **~85% baris mengandung quote** (phrase ber-koma/ber-quote + note multi-baris):
  fast path v1 (split per baris bersih) hanya kena ~15% baris. Slow path
  (field-by-field) yang dominan — di situlah waktu habis.
- Profil CPU v1 (`--cpu-prof`, 10x set): `run` 35,8%, `readUnquotedInto`
  25,5%, `readQuoted` 22,5%, GC 4,0%.

## 2. Kelemahan yang ditemukan (v1) + perbaikan (v2)

| # | Kelemahan | Perbaikan | Ukuran |
|---|-----------|-----------|--------|
| 1 | `readUnquotedInto`/`readQuoted` dipanggil per field (~1,1 jt kali/set) + objek scratch `F` dibaca/ditulis per field | Field reader di-inline penuh ke record loop; tidak ada call, tidak ada objek scratch | Bagian terbesar dari 1,14–1,41x (lihat §3) |
| 2 | Unquoted scan cek CR dengan `seg.indexOf('\r')` di tiap field | Cek memakai cache posisi CR berikutnya (`nc >= end` → satu compare, tanpa scan) | Termasuk di atas |
| 3 | Hitung line-break span quoted dengan loop char-by-char JS | Dua jalan indexOf native (LF, lalu CR-bukan-CRLF); CRLF tetap dihitung sekali | Termasuk di atas; longNote synth 1,33x |
| 4 | Normalisasi CR span quoted dua pass `replaceAll('\r\n')` + `replaceAll('\r')` | Satu pass regex `/\r\n?/g` → `'\n'` (hasil identik, dibuktikan edge test) | Termasuk di atas |
| 5 | Fast path jarang kena (~15% baris) | Tidak ada perbaikan fast path yang mungkin — slow path-nya yang dibuat cepat (butir 1–4) | — |
| 6 | (Eksperimen v3, DITOLAK) Batch unquoted run: satu slice + `split(',')` per run, batas run dicari lewat `indexOf(',"')` + cache | Dicoba sebagai prototipe di `/tmp` saja — **terukur lebih lambat**: median 0,63x vs v2, kalah 25/25 ronde. Penyebab: run rata-rata hanya ~4 field, ongkos `indexOf(',"')` + `split` + array interim lebih besar dari hematnya. **Tidak dipakai.** | — |
| 7 | Warmup `main.ts` (50x) & flag V8 | Diuji: warmup 50x vs 8x vs 0x total CPU proses dalam noise (±10%), tidak ada beda signifikan → **dipertahankan 50x** (jamin JIT teroptimasi di tiap container fresh). Flag tambahan (`--no-lazy` dkk.) tidak diuji lebih jauh karena parse cost trivial; `--no-incremental-marking` tetap. | Tidak ada perubahan |
| 8 | Kebenaran | **Tidak ada cacat ditemukan di v1.** Satu bug justru muncul di draf v2 saya sendiri (lihat §4) dan sudah diperbaiki sebelum verifikasi akhir. | — |

`main.ts` **tidak diubah**. `solve.js` ditulis baru di sesi ini (bukan copy-paste
dari reference vendor — reference hanya dipakai sebagai oracle black-box lewat
script test; tidak pernah dibaca kodenya; tidak ada baris yang dicopy dari
output tool lain). Struktur algoritmanya sama dengan v1 (sudah terbukti benar),
implementasinya baru: inline loop, cache CR di unquoted scan, indexOf-walk
untuk line-break, regex untuk normalisasi CR.

## 3. Angka sebelum vs sesudah (run() saja, set practice, paired A/B)

| Metrik | v1 (sebelum) | v2 (sesudah) | Rasio |
|--------|--------------|--------------|-------|
| Set penuh, median 25 ronde berpasangan | 221,3 ms | 195,7 ms | **1,14x** (median rasio per ronde; mean 1,20x; v2 menang 22/25 ronde) |
| Set penuh, median run A/B kedua (15 ronde) | 300,1 ms | 212,8 ms | **1,41x** |
| vs oracle (baseline) per set, median | oracle 879,2 ms | v2 212,8 ms | **v2 4,13x lebih cepat dari oracle** |
| Per kasus, rasio median berpasangan | — | g-0001 1,42x; g-0002 1,38x; g-0003 1,60x; g-0004 1,68x; g-0005 1,05x; g-0006 0,73x (median) / 1,02x (mean) | v2 menang/seri di 5/6 kasus; g-0006 dalam noise |
| Synth multi-line note (10 baris/note) | — | — | 1,33x |

Catatan noise: VM berbagi 1,5 CPU dengan build lain; spread antar-ronde sampai
2x. Karena itu semua rasio di atas diambil berpasangan (v1 lalu v2 dalam ronde
yang sama) dan dilaporkan median — bukan dari blok terpisah.

Biaya lain (sama untuk semua entry, bukan pembeda): JSON.parse cases ~100–280 ms,
JSON.stringify answers ~185–300 ms, warmup 50x ~0,3 ms (steady; 23 ms di run
pertama saat JIT compile — itulah gunanya warmup).

## 4. Bug yang ditemukan & diperbaiki selama ronde ini (di draf v2)

Draf pertama v2 menyatukan fall-through junk-after-quote dan unterminated-quote
ke satu scan unquoted, sehingga `quote_junk` ikut terbit untuk unterminated
quote. Edge test menangkapnya (16/170 gagal, semua pola unterminated +
2 kasus practice g-0002/g-0004). Perbaikan: flag `junkAfter` terpisah — hanya
quote yang benar-benar menutup + ada karakter setelahnya yang menghasilkan
`quote_junk`; unterminated tetap hanya `unterminated_quote` (+ `stray_cr` bila
ada). Setelah perbaikan: 170/170 + 6/6.

## 5. Verifikasi kebenaran (v2 final)

| Uji | Hasil |
|-----|-------|
| Practice vs `practice/reference/expected.json` | **6/6 identik** |
| Practice vs oracle vendor (black-box) | **6/6 identik** |
| Edge case buatan (170 kasus: quote di field, `""`, newline di field, malformed, delimiter aneh, CR stray, BOM, baris kosong, file besar 100 KB/field, unicode/emoji, CRLF campur, short/long row, error line/row, unterminated, junk+CR, dsb.) | **170/170 identik vs oracle** |
| Fuzz acak vs oracle (4.000 input acak, alfabet `a b c , " \n \r sp x 1 é` + BOM) | **4.000/4.000 identik** |
| Kasus fresh dari generator kit (`csv-cases.mjs`, 12 kasus, RNG sendiri) | **12/12 identik vs oracle** |
| `grade-local --driver process` | **6/6 passed** (`cases_passed: 6, passed: 1`); L1 regrade reproduced byte for byte; `result_sha256` sama dengan v1 (d5a93f7c…, output identik) |
| Dua run `main.ts` manual | **byte-identik** (sha256 `bb5b6cc5c523edf0b18a20cd1f577b0d461b3ae021fd3ab2c9b4e4a5f01002ed`) |
| Ukuran repo | ~17 KB total (batas 1 MiB) — aman |
| `main.ts` | tidak diubah (warmup + `--no-incremental-marking` tetap) |

## 6. File yang diubah

- `solve.js` — ditulis ulang (v2, 12.169 byte; v1 11.177 byte). Satu-satunya
  file kode yang berubah.
- `VERIFY-REPORT-CSV-FIX.md` — laporan ini (baru).
- Tidak diubah: `main.ts`, `package.json`, `README.md`, `LICENSE`.

## 7. Yang BELUM / catatan untuk koordinator

- **JANGAN SUBMIT/PUSH dari sesi ini** (sesuai tugas). Commit lokal saja.
- Authorship: v2 ditulis fresh di sesi ini (subagent ini) + sesi parent;
  bundle transcripts saat submit harus mencakup sesi ini agar
  `thinking_reproduces` terhitung. v2 berbagi struktur algoritma dengan v1
  (kode round-1 yang juga ditulis agen ini) — bukan copy dari vendor/tool.
  Cek `thinking_reproduces` ulang lewat `check` sebelum submit round 2.
- Slot: 1/3 terpakai (round 1). Round 2 yang diperbaiki ini memakai slot ke-2;
  slot ke-3 tetap cadangan sesuai perintah syarif.
- Sisa risiko kecil: g-0006 (header=false, 17.193 baris, quote paling sedikit)
  dalam noise (median 0,73x / mean 1,02x); secara agregat v2 tetap menang
  22/25 ronde. Tidak ada optimasi lanjutan yang terukur menguntungkan setelah
  v2 (v3 ditolak, warmup/flag netral).
