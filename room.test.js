'use strict';

// Tes logika Room (tanpa jaringan). Jalankan: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, RoomManager } = require('../server/room');

const join = (room, id, name) => room.join({ playerId: id, name, socketId: 's-' + id });

/** Room dengan dua pemain (p1 = Putih, p2 = Hitam) dan permainan sudah berjalan. */
function startedRoom(options) {
  const room = new Room('ABCDE', options || { minutes: 10 });
  join(room, 'p1', 'Ani');
  join(room, 'p2', 'Budi');
  return room;
}

test('pemain pertama jadi Putih, kedua Hitam, ketiga penonton', () => {
  const room = new Room('ABCDE', { minutes: 10 });
  assert.equal(join(room, 'p1').role, 'w');
  assert.equal(room.status, 'waiting');
  assert.equal(join(room, 'p2').role, 'b');
  assert.equal(room.status, 'playing');
  assert.equal(join(room, 'p3').role, 'spectator');
  assert.equal(room.spectators.size, 1);
});

test('giliran divalidasi: Hitam tidak bisa melangkah saat giliran Putih', () => {
  const room = startedRoom();
  assert.equal(room.makeMove('b', { from: 'e7', to: 'e5' }).ok, false);
  assert.equal(room.makeMove('w', { from: 'e2', to: 'e4' }).ok, true);
  assert.equal(room.makeMove('w', { from: 'd2', to: 'd4' }).ok, false);   // Putih dua kali berturut-turut
  assert.equal(room.makeMove('b', { from: 'e7', to: 'e5' }).ok, true);
});

test('langkah ilegal dan input aneh ditolak', () => {
  const room = startedRoom();
  assert.equal(room.makeMove('w', { from: 'e2', to: 'e5' }).ok, false);   // pion tidak boleh lompat 3 kotak
  assert.equal(room.makeMove('w', { from: 'b1', to: 'b3' }).ok, false);   // kuda tidak bergerak lurus
  assert.equal(room.makeMove('w', { from: 'z9', to: 'e4' }).ok, false);   // kotak tidak ada
  assert.equal(room.makeMove('w', null).ok, false);
  assert.equal(room.makeMove('spectator', { from: 'e2', to: 'e4' }).ok, false);
});

test('penonton tidak punya langkah legal; hanya pemain yang sedang giliran yang punya', () => {
  const room = startedRoom();
  join(room, 'p3', 'Cici');
  assert.ok(room.stateFor('s-p1').legalMoves.e2.includes('e4'));
  assert.deepEqual(room.stateFor('s-p2').legalMoves, {});
  assert.deepEqual(room.stateFor('s-p3').legalMoves, {});
  assert.equal(room.stateFor('s-p3').you.role, 'spectator');
});

test('skakmat (fool\'s mate): Hitam menang', () => {
  const room = startedRoom();
  assert.equal(room.makeMove('w', { from: 'f2', to: 'f3' }).ok, true);
  assert.equal(room.makeMove('b', { from: 'e7', to: 'e5' }).ok, true);
  assert.equal(room.makeMove('w', { from: 'g2', to: 'g4' }).ok, true);
  assert.equal(room.makeMove('b', { from: 'd8', to: 'h4' }).ok, true);
  assert.equal(room.status, 'finished');
  assert.deepEqual(room.result, { winner: 'b', reason: 'checkmate' });
  assert.equal(room.makeMove('w', { from: 'a2', to: 'a3' }).ok, false);   // game sudah selesai
});

test('promosi pion membutuhkan pilihan bidak', () => {
  const room = startedRoom();
  // Posisi khusus: pion putih di a7 siap promosi ke a8 (raja di tempat yang aman)
  room.chess.load('7k/P7/8/8/8/8/8/K7 w - - 0 1');
  assert.equal(room.makeMove('w', { from: 'a7', to: 'a8', promotion: 'x' }).ok, false);
  assert.equal(room.makeMove('w', { from: 'a7', to: 'a8', promotion: 'q' }).ok, true);
  assert.equal(room.chess.get('a8').type, 'q');
});

test('waktu habis: pemain yang gilirannya kalah (Lose on time)', async () => {
  const room = new Room('TIMES', { baseMs: 60 });
  const done = new Promise((resolve) => { room.onChange = resolve; });
  join(room, 'p1');
  join(room, 'p2');                       // game mulai, jam Putih berjalan
  await done;
  assert.equal(room.status, 'finished');
  assert.deepEqual(room.result, { winner: 'b', reason: 'timeout' });
  assert.equal(room.remaining().w, 0);
});

test('jam: giliran berpindah dan tambahan waktu per langkah diberikan', () => {
  const room = startedRoom({ minutes: 1, increment: 5 });
  assert.equal(room.stateFor('s-p1').clock.running, 'w');
  assert.equal(room.makeMove('w', { from: 'e2', to: 'e4' }).ok, true);
  const st = room.stateFor('s-p1');
  assert.equal(st.clock.running, 'b');
  assert.ok(st.clock.w > 60 * 1000, 'Putih mendapat +5 detik setelah melangkah');
  assert.equal(st.lastMove.from, 'e2');
  assert.equal(st.lastMove.to, 'e4');
});

test('menyerah dan remis atas kesepakatan', () => {
  const a = startedRoom();
  assert.equal(a.resign('w').ok, true);
  assert.deepEqual(a.result, { winner: 'b', reason: 'resign' });

  const b = startedRoom();
  assert.equal(b.offerDraw('w').ok, true);
  assert.equal(b.respondDraw('w', true).ok, false);        // tidak bisa menerima tawaran sendiri
  assert.equal(b.respondDraw('b', true).ok, true);
  assert.deepEqual(b.result, { winner: null, reason: 'agreement' });
});

test('rematch menukar warna bila kedua pemain setuju', () => {
  const room = startedRoom();
  room.resign('w');
  assert.equal(room.requestRematch('w').ok, true);
  assert.equal(room.status, 'finished');                    // menunggu persetujuan lawan
  assert.equal(room.requestRematch('b').ok, true);
  assert.equal(room.status, 'playing');
  assert.equal(room.seats.w.playerId, 'p2');
  assert.equal(room.seats.b.playerId, 'p1');
});

test('reconnect: playerId yang sama mengambil kembali kursinya', () => {
  const room = startedRoom();
  room.disconnect('s-p1');
  assert.equal(room.stateFor('s-p2').players.w.connected, false);
  const back = room.join({ playerId: 'p1', name: 'Ani', socketId: 'socket-baru' });
  assert.equal(back.role, 'w');
  assert.equal(room.stateFor('socket-baru').players.w.connected, true);
});

test('RoomManager: kode unik, opsi waktu divalidasi, kode dinormalkan', () => {
  const m = new RoomManager();
  const room = m.create({ minutes: 999, increment: -5 });
  assert.match(room.code, /^[A-HJKMNP-Z2-9]{5}$/);
  assert.equal(room.baseMs, 10 * 60 * 1000);                // nilai tidak sah diganti bawaan
  assert.equal(room.incMs, 0);
  assert.equal(m.get(' ' + room.code.toLowerCase() + '!'), room);
  assert.equal(m.get('ZZZZZ'), null);
});
