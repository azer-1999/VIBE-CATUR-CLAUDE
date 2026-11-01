'use strict';

/**
 * room.js: logika satu room catur dan manajer room.
 *
 * Server adalah satu-satunya sumber kebenaran:
 *   - posisi papan dan validasi langkah (chess.js),
 *   - giliran,
 *   - jam catur (dihitung dari Date.now() di server, bukan dari klien).
 * Klien hanya menampilkan state dan mengirim niat langkah (dari, ke, promosi).
 */

const crypto = require('crypto');
const { Chess } = require('chess.js');

// Kode room: huruf dan angka yang tidak ambigu (tanpa I, L, O, 0, 1)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

const ALLOWED_MINUTES = [1, 3, 5, 10, 15, 30];
const ALLOWED_INCREMENTS = [0, 1, 2, 3, 5, 10];
const DEFAULT_MINUTES = 10;
const DEFAULT_INCREMENT = 0;

const MAX_NAME_LENGTH = 20;
const SQUARE_RE = /^[a-h][1-8]$/;
const PROMOTIONS = ['q', 'r', 'b', 'n'];

const ABANDONED_AFTER_MS = 10 * 60 * 1000;   // room tanpa peserta terhubung dihapus setelah 10 menit
const FINISHED_IDLE_AFTER_MS = 30 * 60 * 1000;

const opposite = (color) => (color === 'w' ? 'b' : 'w');

/** Bersihkan nama pemain: buang karakter kontrol dan tanda < >, batasi panjang. */
function cleanName(name, fallback) {
  const s = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return s || fallback;
}

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

class Room {
  /**
   * @param {string} code
   * @param {{minutes?: number, increment?: number, baseMs?: number}} options
   *        baseMs hanya untuk pengujian (waktu awal dalam milidetik)
   */
  constructor(code, options = {}) {
    this.code = code;
    this.baseMs = options.baseMs != null ? options.baseMs : (options.minutes || DEFAULT_MINUTES) * 60 * 1000;
    this.incMs = (options.increment || DEFAULT_INCREMENT) * 1000;

    // Kursi pemain: { playerId, name, socketId, connected } atau null
    this.seats = { w: null, b: null };
    this.spectators = new Map();          // socketId -> nama
    this.onChange = () => {};             // diisi index.js; dipanggil saat state berubah karena timer
    this.timer = null;
    this.lastActivity = Date.now();

    this.newGame();
  }

  /* ------------------------------------------------------------------
     Siklus permainan
     ------------------------------------------------------------------ */

  /** Siapkan permainan baru (papan awal, jam penuh), belum berjalan. */
  newGame() {
    clearTimeout(this.timer);
    this.chess = new Chess();
    this.status = 'waiting';              // 'waiting' | 'playing' | 'finished'
    this.timeLeft = { w: this.baseMs, b: this.baseMs };
    this.turnStartedAt = null;            // kapan jam pemain yang sedang giliran mulai berjalan
    this.lastMove = null;                 // { from, to, san }
    this.result = null;                   // { winner: 'w' | 'b' | null, reason }
    this.drawOffer = null;                // 'w' | 'b' | null (siapa yang menawarkan)
    this.rematch = { w: false, b: false };
  }

  /** Mulai permainan: jam putih langsung berjalan. */
  start() {
    this.status = 'playing';
    this.turnStartedAt = Date.now();
    this.schedule();
  }

  /** Akhiri permainan dan bekukan jam. winner null berarti remis. */
  finish(winner, reason) {
    if (this.status === 'finished') return;
    this.timeLeft = this.remaining();     // hitung sebelum status berubah
    this.status = 'finished';
    this.turnStartedAt = null;
    this.drawOffer = null;
    this.result = { winner, reason };
    clearTimeout(this.timer);
  }

  /* ------------------------------------------------------------------
     Jam catur
     ------------------------------------------------------------------ */

  /** Sisa waktu (ms) kedua pemain saat ini; jam pemain yang sedang giliran berkurang real time. */
  remaining() {
    const t = { w: this.timeLeft.w, b: this.timeLeft.b };
    if (this.status === 'playing' && this.turnStartedAt) {
      t[this.chess.turn()] -= Date.now() - this.turnStartedAt;
    }
    t.w = Math.max(0, t.w);
    t.b = Math.max(0, t.b);
    return t;
  }

  /** Pasang timer yang berbunyi tepat saat waktu pemain yang sedang giliran habis. */
  schedule() {
    clearTimeout(this.timer);
    if (this.status !== 'playing') return;
    const left = this.remaining()[this.chess.turn()];
    this.timer = setTimeout(() => this.checkTime(), left + 25);
  }

  /** Dipanggil oleh timer: nyatakan kalah bila waktu benar-benar habis. */
  checkTime() {
    if (this.status !== 'playing') return;
    const turn = this.chess.turn();
    if (this.remaining()[turn] <= 0) {
      this.timeoutLoss(turn);
      this.onChange();
    } else {
      this.schedule();                    // timer berbunyi sedikit lebih awal: jadwalkan ulang
    }
  }

  /** Pemain `color` kehabisan waktu. Remis bila lawan tidak mungkin skakmat. */
  timeoutLoss(color) {
    this.timeLeft[color] = 0;
    if (this.chess.isInsufficientMaterial()) this.finish(null, 'timeout-insufficient');
    else this.finish(opposite(color), 'timeout');
  }

  /* ------------------------------------------------------------------
     Peserta
     ------------------------------------------------------------------ */

  seatOf(playerId) {
    if (this.seats.w && this.seats.w.playerId === playerId) return 'w';
    if (this.seats.b && this.seats.b.playerId === playerId) return 'b';
    return null;
  }

  /** 'w' | 'b' | 'spectator' | null untuk sebuah socket. */
  roleOf(socketId) {
    if (this.seats.w && this.seats.w.socketId === socketId) return 'w';
    if (this.seats.b && this.seats.b.socketId === socketId) return 'b';
    if (this.spectators.has(socketId)) return 'spectator';
    return null;
  }

  /**
   * Masukkan peserta. Aturan kursi:
   *  - playerId yang sudah punya kursi mengambil kembali kursinya (reconnect),
   *  - pemain pertama jadi Putih, kedua jadi Hitam,
   *  - sisanya penonton.
   * @returns {{role: string, replaced: string|null}} replaced = socketId lama yang tergantikan
   */
  join({ playerId, name, socketId }) {
    this.touch();
    let role = this.seatOf(playerId);
    let replaced = null;

    if (role) {
      const seat = this.seats[role];
      if (seat.socketId && seat.socketId !== socketId) replaced = seat.socketId;
      seat.socketId = socketId;
      seat.connected = true;
      if (name) seat.name = cleanName(name, seat.name);
    } else {
      // Ada kursi kosong di room yang sudah selesai: mulai dari awal untuk pendatang baru
      if (this.status === 'finished' && (!this.seats.w || !this.seats.b)) this.newGame();

      if (!this.seats.w) role = 'w';
      else if (!this.seats.b) role = 'b';

      if (role) {
        this.seats[role] = {
          playerId,
          name: cleanName(name, role === 'w' ? 'Putih' : 'Hitam'),
          socketId,
          connected: true
        };
      } else {
        role = 'spectator';
        this.spectators.set(socketId, cleanName(name, 'Penonton'));
      }
    }

    if (this.status === 'waiting' && this.seats.w && this.seats.b) this.start();
    return { role, replaced };
  }

  /** Pemain menekan "Keluar". Keluar di tengah permainan dihitung menyerah. */
  leave(socketId) {
    const role = this.roleOf(socketId);
    if (role === 'spectator') {
      this.spectators.delete(socketId);
    } else if (role) {
      if (this.status === 'playing') this.finish(opposite(role), 'resign');
      this.seats[role] = null;
      this.rematch = { w: false, b: false };
    }
    this.touch();
    return role;
  }

  /** Koneksi terputus: kursi dipertahankan agar bisa kembali (jam tetap berjalan). */
  disconnect(socketId) {
    const role = this.roleOf(socketId);
    if (role === 'spectator') this.spectators.delete(socketId);
    else if (role) {
      this.seats[role].connected = false;
      this.seats[role].socketId = null;
    }
    this.touch();
  }

  touch() { this.lastActivity = Date.now(); }

  hasConnectedPeople() {
    return this.spectators.size > 0 ||
      !!(this.seats.w && this.seats.w.connected) ||
      !!(this.seats.b && this.seats.b.connected);
  }

  /* ------------------------------------------------------------------
     Aksi pemain
     ------------------------------------------------------------------ */

  /**
   * Lakukan langkah. Memvalidasi: status game, peran, giliran, format input,
   * sisa waktu, dan legalitas langkah (chess.js).
   */
  makeMove(role, move) {
    if (this.status !== 'playing') return fail('Permainan belum berjalan atau sudah selesai.');
    if (role !== 'w' && role !== 'b') return fail('Penonton tidak bisa melangkah.');
    if (this.chess.turn() !== role) return fail('Bukan giliran Anda.');
    if (!move || !SQUARE_RE.test(move.from) || !SQUARE_RE.test(move.to)) return fail('Format langkah tidak valid.');

    let promotion;
    if (move.promotion != null) {
      promotion = String(move.promotion).toLowerCase();
      if (!PROMOTIONS.includes(promotion)) return fail('Bidak promosi tidak valid.');
    }

    // Jam: kurangi waktu giliran ini dulu. Bila sudah habis, langkah tidak sah.
    const now = Date.now();
    const left = this.timeLeft[role] - (now - this.turnStartedAt);
    if (left <= 0) {
      this.timeoutLoss(role);
      return fail('Waktu Anda habis.');
    }

    let made;
    try {
      made = this.chess.move({ from: move.from, to: move.to, promotion });
    } catch (e) {
      return fail('Langkah ilegal.');
    }
    if (!made) return fail('Langkah ilegal.');

    this.timeLeft[role] = left + this.incMs;   // tambahan waktu per langkah
    this.turnStartedAt = now;
    this.lastMove = { from: made.from, to: made.to, san: made.san };
    this.drawOffer = null;
    this.touch();
    this.afterMove(role);
    return OK;
  }

  /** Cek akhir permainan setelah langkah `mover`. */
  afterMove(mover) {
    const c = this.chess;
    if (c.isCheckmate()) this.finish(mover, 'checkmate');
    else if (c.isStalemate()) this.finish(null, 'stalemate');
    else if (c.isInsufficientMaterial()) this.finish(null, 'insufficient');
    else if (c.isThreefoldRepetition()) this.finish(null, 'threefold');
    else if (typeof c.isDrawByFiftyMoves === 'function' && c.isDrawByFiftyMoves()) this.finish(null, 'fifty-move');
    else if (c.isDraw()) this.finish(null, 'draw');
    else this.schedule();
  }

  resign(role) {
    if (this.status !== 'playing' || (role !== 'w' && role !== 'b')) return fail('Tidak bisa menyerah sekarang.');
    this.finish(opposite(role), 'resign');
    return OK;
  }

  offerDraw(role) {
    if (this.status !== 'playing' || (role !== 'w' && role !== 'b')) return fail('Tidak bisa menawarkan remis sekarang.');
    if (this.drawOffer === role) return fail('Tawaran remis sudah dikirim.');
    if (this.drawOffer === opposite(role)) {   // lawan sudah menawar: anggap diterima
      this.finish(null, 'agreement');
      return OK;
    }
    this.drawOffer = role;
    return OK;
  }

  respondDraw(role, accept) {
    if (this.status !== 'playing' || (role !== 'w' && role !== 'b')) return fail('Tidak ada tawaran remis.');
    if (this.drawOffer !== opposite(role)) return fail('Tidak ada tawaran remis dari lawan.');
    if (accept) this.finish(null, 'agreement');
    else this.drawOffer = null;
    return OK;
  }

  /** Rematch: bila kedua pemain setuju, warna ditukar dan permainan baru langsung mulai. */
  requestRematch(role) {
    if (this.status !== 'finished' || (role !== 'w' && role !== 'b')) return fail('Rematch belum bisa diminta.');
    if (!this.seats.w || !this.seats.b) return fail('Lawan sudah keluar.');
    this.rematch[role] = true;
    if (this.rematch.w && this.rematch.b) {
      const w = this.seats.w;
      this.seats.w = this.seats.b;
      this.seats.b = w;
      this.newGame();
      this.start();
    }
    return OK;
  }

  /* ------------------------------------------------------------------
     Snapshot state untuk dikirim ke klien
     ------------------------------------------------------------------ */

  /** Peta kotak asal -> daftar kotak tujuan yang legal untuk pemain yang sedang giliran. */
  legalMoves() {
    const map = {};
    for (const m of this.chess.moves({ verbose: true })) {
      if (!map[m.from]) map[m.from] = [];
      if (!map[m.from].includes(m.to)) map[m.from].push(m.to);
    }
    return map;
  }

  /** Kotak raja yang sedang di-skak (atau null). */
  checkSquare() {
    if (!this.chess.inCheck()) return null;
    const turn = this.chess.turn();
    const board = this.chess.board();          // board[0] = rank 8
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && p.type === 'k' && p.color === turn) return 'abcdefgh'[c] + (8 - r);
      }
    }
    return null;
  }

  /** State personal untuk satu socket (peran, dan langkah legal bila gilirannya). */
  stateFor(socketId) {
    const role = this.roleOf(socketId);
    const turn = this.chess.turn();
    const clocks = this.remaining();
    const pub = (seat) => (seat ? { name: seat.name, connected: seat.connected } : null);

    return {
      code: this.code,
      status: this.status,
      fen: this.chess.fen(),
      turn,
      players: { w: pub(this.seats.w), b: pub(this.seats.b) },
      spectators: this.spectators.size,
      clock: {
        w: clocks.w,
        b: clocks.b,
        running: this.status === 'playing' ? turn : null,
        base: this.baseMs,
        inc: this.incMs
      },
      lastMove: this.lastMove,
      history: this.chess.history(),
      checkSquare: this.checkSquare(),
      result: this.result,
      drawOffer: this.drawOffer,
      rematch: this.rematch,
      you: { role },
      legalMoves: this.status === 'playing' && role === turn ? this.legalMoves() : {}
    };
  }
}

/* ======================================================================
   RoomManager: kumpulan room di memori
   ====================================================================== */
class RoomManager {
  constructor({ maxRooms = 2000 } = {}) {
    this.rooms = new Map();
    this.maxRooms = maxRooms;
  }

  /** Normalkan input kode dari pengguna: huruf besar, hanya A-Z dan 0-9. */
  static normalizeCode(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  }

  generateCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  /** Buat room baru; opsi waktu yang tidak diizinkan diganti nilai bawaan. */
  create({ minutes, increment } = {}) {
    if (this.rooms.size >= this.maxRooms) return null;
    const code = this.generateCode();
    if (!code) return null;
    const m = ALLOWED_MINUTES.includes(Number(minutes)) ? Number(minutes) : DEFAULT_MINUTES;
    const inc = ALLOWED_INCREMENTS.includes(Number(increment)) ? Number(increment) : DEFAULT_INCREMENT;
    const room = new Room(code, { minutes: m, increment: inc });
    this.rooms.set(code, room);
    return room;
  }

  get(code) { return this.rooms.get(RoomManager.normalizeCode(code)) || null; }

  /** Hapus room yang ditinggalkan. Dipanggil berkala oleh index.js. */
  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastActivity;
      const abandoned = !room.hasConnectedPeople() && idle > ABANDONED_AFTER_MS;
      const staleFinished = room.status === 'finished' && idle > FINISHED_IDLE_AFTER_MS && !room.hasConnectedPeople();
      if (abandoned || staleFinished) {
        clearTimeout(room.timer);
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = { Room, RoomManager, ALLOWED_MINUTES, ALLOWED_INCREMENTS, opposite };
