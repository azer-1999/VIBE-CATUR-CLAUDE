'use strict';

/**
 * index.js: server HTTP (Express) + Socket.io untuk catur multiplayer.
 *
 * Event dari klien (semua memakai acknowledgement/callback):
 *   room:create   { playerId, name, minutes, increment }  -> { ok, code, role }
 *   room:join     { playerId, name, code }                -> { ok, code, role }
 *   room:leave                                            -> { ok }
 *   game:move     { from, to, promotion? }                -> { ok, error? }
 *   game:resign                                           -> { ok, error? }
 *   game:draw-offer                                       -> { ok, error? }
 *   game:draw-respond { accept }                          -> { ok, error? }
 *   game:rematch                                          -> { ok, error? }
 *
 * Event dari server:
 *   room:state     state personal tiap peserta (lihat Room.stateFor)
 *   room:replaced  sesi ini digantikan oleh tab/perangkat lain dengan playerId yang sama
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./room');

const PLAYER_ID_RE = /^[\w-]{8,64}$/;

function createServer({ corsOrigin } = {}) {
  const manager = new RoomManager();
  const app = express();
  app.disable('x-powered-by');

  // Frontend statis (HTML/CSS/JS) dilayani dari folder /public
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/health', (req, res) => res.json({ ok: true, rooms: manager.rooms.size }));

  const server = http.createServer(app);
  const io = new Server(server, { cors: corsOrigin ? { origin: corsOrigin } : undefined });

  /** Kirim state personal ke setiap socket di room (tiap pemain punya peran dan langkah legal berbeda). */
  function broadcast(room) {
    const ids = io.sockets.adapter.rooms.get(room.code);
    if (!ids) return;
    for (const id of ids) io.to(id).emit('room:state', room.stateFor(id));
  }

  /** Daftarkan room ke Socket.io: timer jam bisa memicu broadcast sendiri. */
  function track(room) {
    room.onChange = () => broadcast(room);
    return room;
  }

  /** Masukkan socket ke room dan ambil alih kursi lama bila playerId sama. */
  function enter(socket, room, { playerId, name }) {
    if (socket.data.roomCode && socket.data.roomCode !== room.code) leaveCurrent(socket);

    const { role, replaced } = room.join({ playerId, name, socketId: socket.id });
    if (replaced) {
      const old = io.sockets.sockets.get(replaced);
      if (old) {
        old.leave(room.code);
        old.data.roomCode = null;
        old.emit('room:replaced');
      }
    }
    socket.join(room.code);
    socket.data.roomCode = room.code;
    broadcast(room);
    return role;
  }

  /** Keluar dari room aktif socket (bila ada). */
  function leaveCurrent(socket) {
    const room = manager.get(socket.data.roomCode);
    socket.data.roomCode = null;
    if (!room) return;
    room.leave(socket.id);
    socket.leave(room.code);
    broadcast(room);
  }

  io.on('connection', (socket) => {
    const reply = (ack, data) => { if (typeof ack === 'function') ack(data); };
    const ok = (ack, extra) => reply(ack, Object.assign({ ok: true }, extra));
    const fail = (ack, error) => reply(ack, { ok: false, error });
    const asObject = (v) => (v && typeof v === 'object' ? v : {});

    /** Ambil room aktif socket; kirim galat bila tidak ada. */
    const activeRoom = (ack) => {
      const room = manager.get(socket.data.roomCode);
      if (!room) { fail(ack, 'Anda tidak berada di dalam room.'); return null; }
      return room;
    };

    /** Jalankan aksi room yang mengembalikan {ok, error}, lalu siarkan state terbaru. */
    const act = (ack, fn) => {
      const room = activeRoom(ack);
      if (!room) return;
      const role = room.roleOf(socket.id);
      const res = fn(room, role) || { ok: true };
      broadcast(room);
      reply(ack, res);
    };

    socket.on('room:create', (payload, ack) => {
      const p = asObject(payload);
      if (!PLAYER_ID_RE.test(String(p.playerId))) return fail(ack, 'Identitas pemain tidak valid.');
      const room = manager.create({ minutes: p.minutes, increment: p.increment });
      if (!room) return fail(ack, 'Server sedang penuh. Coba lagi nanti.');
      track(room);
      const role = enter(socket, room, { playerId: String(p.playerId), name: p.name });
      ok(ack, { code: room.code, role });
    });

    socket.on('room:join', (payload, ack) => {
      const p = asObject(payload);
      if (!PLAYER_ID_RE.test(String(p.playerId))) return fail(ack, 'Identitas pemain tidak valid.');
      const room = manager.get(p.code);
      if (!room) return fail(ack, 'Room tidak ditemukan. Periksa kembali kodenya.');
      const role = enter(socket, room, { playerId: String(p.playerId), name: p.name });
      ok(ack, { code: room.code, role });
    });

    socket.on('room:leave', (payload, ack) => {
      leaveCurrent(socket);
      ok(ack);
    });

    socket.on('game:move', (payload, ack) => {
      act(ack, (room, role) => room.makeMove(role, asObject(payload)));
    });

    socket.on('game:resign', (payload, ack) => {
      act(ack, (room, role) => room.resign(role));
    });

    socket.on('game:draw-offer', (payload, ack) => {
      act(ack, (room, role) => room.offerDraw(role));
    });

    socket.on('game:draw-respond', (payload, ack) => {
      act(ack, (room, role) => room.respondDraw(role, !!asObject(payload).accept));
    });

    socket.on('game:rematch', (payload, ack) => {
      act(ack, (room, role) => room.requestRematch(role));
    });

    socket.on('disconnect', () => {
      const room = manager.get(socket.data.roomCode);
      if (!room) return;
      room.disconnect(socket.id);
      broadcast(room);
    });
  });

  // Bersihkan room yang ditinggalkan setiap menit
  const sweeper = setInterval(() => manager.sweep(), 60 * 1000);
  sweeper.unref();
  server.on('close', () => clearInterval(sweeper));

  return { app, server, io, manager };
}

// Jalankan langsung: `node server/index.js`
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createServer({ corsOrigin: process.env.CORS_ORIGIN });
  server.listen(port, () => {
    console.log('Catur Mabar berjalan di http://localhost:' + port);
  });
}

module.exports = { createServer };
