'use strict';

// Tes end-to-end: server sungguhan + tiga klien Socket.io. Jalankan: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server/index');

const listen = (server) => new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
const emit = (sock, event, payload) => new Promise((resolve) => sock.emit(event, payload, resolve));

/** Tunggu state berikutnya yang memenuhi syarat `pred`. Pasang SEBELUM memicu aksi. */
function nextState(sock, pred = () => true) {
  return new Promise((resolve) => {
    const handler = (s) => {
      if (pred(s)) { sock.off('room:state', handler); resolve(s); }
    };
    sock.on('room:state', handler);
  });
}

test('alur dua pemain + penonton sampai skakmat, via Socket.io', async () => {
  const { io, server } = createServer();
  const port = await listen(server);
  const url = 'http://127.0.0.1:' + port;
  const A = connect(url), B = connect(url), C = connect(url);

  try {
    // Pemain 1 membuat room dan jadi Putih
    const created = await emit(A, 'room:create', { playerId: 'player-aaaa-1', name: 'Ani', minutes: 10, increment: 0 });
    assert.equal(created.ok, true);
    assert.equal(created.role, 'w');
    assert.equal(created.code.length, 5);

    // Pemain 2 masuk dengan kode dan jadi Hitam; game langsung berjalan
    const bState = nextState(B, (s) => s.status === 'playing');
    const joinedB = await emit(B, 'room:join', { playerId: 'player-bbbb-2', name: 'Budi', code: created.code.toLowerCase() });
    assert.equal(joinedB.ok, true);
    assert.equal(joinedB.role, 'b');
    const started = await bState;
    assert.equal(started.players.w.name, 'Ani');
    assert.equal(started.players.b.name, 'Budi');

    // Pemain 3 hanya penonton
    const joinedC = await emit(C, 'room:join', { playerId: 'player-cccc-3', name: 'Cici', code: created.code });
    assert.equal(joinedC.role, 'spectator');

    // Room yang tidak ada
    const missing = await emit(C, 'room:join', { playerId: 'player-cccc-3', name: 'Cici', code: 'ZZZZZ' });
    assert.equal(missing.ok, false);

    // Validasi giliran: Hitam dan penonton tidak bisa melangkah lebih dulu
    assert.equal((await emit(B, 'game:move', { from: 'e7', to: 'e5' })).ok, false);
    assert.equal((await emit(C, 'game:move', { from: 'e2', to: 'e4' })).ok, false);

    // Fool's mate: 1.f3 e5 2.g4 Qh4#
    assert.equal((await emit(A, 'game:move', { from: 'f2', to: 'f3' })).ok, true);
    assert.equal((await emit(B, 'game:move', { from: 'e7', to: 'e5' })).ok, true);
    assert.equal((await emit(A, 'game:move', { from: 'g2', to: 'g4' })).ok, true);
    const finalForSpectator = nextState(C, (s) => s.status === 'finished');
    assert.equal((await emit(B, 'game:move', { from: 'd8', to: 'h4' })).ok, true);

    const final = await finalForSpectator;
    assert.deepEqual(final.result, { winner: 'b', reason: 'checkmate' });
    assert.equal(final.history.length, 4);
    assert.equal(final.you.role, 'spectator');
  } finally {
    A.close(); B.close(); C.close();
    await new Promise((resolve) => io.close(resolve));
  }
});
