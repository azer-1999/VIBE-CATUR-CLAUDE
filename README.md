# Catur Mabar

Game catur multiplayer realtime untuk dua pemain (plus penonton), dengan room berkode, jam catur, dan papan yang otomatis berputar sesuai warna Anda.

- **Backend:** Node.js, Express, Socket.io, dan [chess.js](https://github.com/jhlywa/chess.js) untuk aturan catur.
- **Frontend:** HTML, CSS, dan JavaScript vanilla. Tanpa library frontend; klien Socket.io disajikan otomatis oleh server.

## Struktur

```
catur-mabar/
├── package.json
├── server/
│   ├── index.js        # Express + Socket.io: event, siaran state, pembersihan room
│   └── room.js         # Room (aturan, giliran, jam, kursi) dan RoomManager
├── public/
│   ├── index.html      # Lobi + layar permainan
│   ├── style.css       # Tampilan responsif
│   └── app.js          # Klien: render papan, drag/klik, jam, panel info
└── test/
    ├── room.test.js    # Tes logika Room
    └── socket.test.js  # Tes end-to-end dengan Socket.io
```

## Instalasi dan menjalankan

Syarat: **Node.js 18 atau lebih baru**.

```bash
cd catur-mabar
npm install
npm start
```

Buka <http://localhost:3000>. Port bisa diganti dengan `PORT=8080 npm start`.

Untuk mencoba sendirian, buka **dua tab** (atau satu tab biasa dan satu tab penyamaran). Identitas pemain disimpan per tab, jadi tiap tab dihitung sebagai pemain berbeda.

Untuk bermain dari HP di jaringan Wi-Fi yang sama, buka `http://<IP-komputer-Anda>:3000`.

Perintah lain:

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` | Jalankan dengan auto-restart saat file berubah |
| `npm test` | Jalankan tes (Node 18+) |

## Cara bermain

1. Isi nama, lalu pilih **Buat Room Baru** (atur waktu dan tambahan per langkah) atau **Masuk ke Room** dengan kode 5 karakter.
2. Pemain pertama menjadi Putih, pemain kedua menjadi Hitam. Pemain ketiga dan seterusnya masuk sebagai penonton.
3. Bagikan kode atau tombol **Salin tautan** (tautan berisi `?room=KODE` sehingga kolom kode terisi otomatis).
4. Gerakkan bidak dengan drag-and-drop atau ketuk bidak lalu ketuk kotak tujuan. Titik menunjukkan langkah legal, cincin menunjukkan bidak yang bisa dimakan.
5. Pion yang sampai baris terakhir menampilkan pilihan promosi (ratu, benteng, gajah, kuda).

## Aturan dan perilaku server

- **Server yang menentukan segalanya.** Posisi, giliran, legalitas langkah, dan jam dihitung di server. Klien hanya mengirim `{from, to, promotion}`.
- **Aturan catur lengkap** lewat chess.js: semua gerakan bidak, rokade, en passant, promosi, skak, skakmat, stalemate, bidak tidak cukup, posisi berulang tiga kali, dan aturan 50 langkah.
- **Jam:** jam Putih mulai berjalan saat pemain kedua masuk. Jam pemain yang sedang giliran berkurang tiap detik. Bila habis, pemain itu kalah (*Lose on time*), kecuali lawannya tidak punya bidak cukup untuk skakmat (hasilnya remis). Tambahan waktu per langkah (increment) bersifat opsional.
- **Sambung ulang:** refresh halaman atau koneksi putus tidak menghilangkan kursi. Klien masuk ulang otomatis dengan identitas yang sama. Selama pemain terputus, jamnya tetap berjalan.
- **Fitur tambahan:** menyerah, tawar remis, rematch (warna ditukar), penonton, dan penyorotan kotak asal, tujuan, serta raja yang di-skak.
- Keluar di tengah permainan dihitung menyerah. Room yang ditinggalkan semua peserta dihapus otomatis setelah 10 menit.

## Protokol Socket.io

Semua event dari klien memakai callback (acknowledgement) berbentuk `{ ok, error? }`.

| Event klien → server | Data | Keterangan |
| --- | --- | --- |
| `room:create` | `{ playerId, name, minutes, increment }` | Balasan: `{ ok, code, role }` |
| `room:join` | `{ playerId, name, code }` | Balasan: `{ ok, code, role }` (`role`: `w`, `b`, atau `spectator`) |
| `room:leave` | | Keluar dari room |
| `game:move` | `{ from, to, promotion? }` | Contoh: `{ from: "e2", to: "e4" }` |
| `game:resign` | | Menyerah |
| `game:draw-offer` | | Tawar remis |
| `game:draw-respond` | `{ accept }` | Terima atau tolak tawaran |
| `game:rematch` | | Minta rematch |

| Event server → klien | Keterangan |
| --- | --- |
| `room:state` | Snapshot lengkap, dikirim ke tiap peserta setelah setiap perubahan. Berisi `fen`, `turn`, `players`, `clock`, `lastMove`, `history`, `checkSquare`, `result`, `you.role`, dan `legalMoves` (hanya untuk pemain yang sedang giliran). |
| `room:replaced` | Sesi ini diambil alih tab atau perangkat lain dengan identitas yang sama. |

Jam dikirim sebagai sisa waktu (ms) saat state dikirim beserta `running` (warna yang jamnya berjalan). Klien menghitung mundur secara lokal, lalu disinkronkan lagi pada state berikutnya.

## Catatan pengembangan

- **State ada di memori.** Restart server menghapus semua room. Untuk produksi dengan lebih dari satu instance, gunakan penyimpanan bersama (misalnya Redis dan `@socket.io/redis-adapter`).
- **Frontend di domain terpisah:** jalankan server dengan `CORS_ORIGIN=https://domain-frontend` dan ubah `io()` di `public/app.js` menjadi `io("https://domain-backend")`.
- **Bidak** memakai glyph Unicode agar tidak butuh gambar. Bila tampilannya kurang rapi di perangkat tertentu, ganti isi elemen `.piece` di `renderBoard()` dengan gambar SVG.
- **Latensi:** langkah baru tampil setelah dikonfirmasi server (tanpa prediksi di klien), sehingga selalu konsisten dengan keadaan sebenarnya.
