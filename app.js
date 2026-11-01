/**
 * app.js: klien Catur Mabar (JavaScript vanilla, tanpa library selain Socket.io client).
 *
 * Alur singkat:
 *   1. Lobi: buat room atau masuk dengan kode.
 *   2. Server mengirim "room:state" setiap ada perubahan (langkah, jam, peserta).
 *   3. Klien hanya MENGGAMBAR state itu dan mengirim niat langkah ("game:move").
 *      Semua validasi (giliran, legalitas, waktu) dilakukan server.
 */
(() => {
  'use strict';

  /* =====================================================================
     1. KONSTANTA DAN UTILITAS
     ===================================================================== */
  const $ = (id) => document.getElementById(id);
  const FILES = 'abcdefgh';
  // Glyph "solid" dipakai untuk kedua warna; warna diatur lewat CSS.
  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const TEXT_VS = '︎';                       // paksa tampilan teks, bukan emoji
  const NAME = { w: 'Putih', b: 'Hitam' };
  const PROMO_NAME = { q: 'Ratu', r: 'Benteng', b: 'Gajah', n: 'Kuda' };
  const opposite = (c) => (c === 'w' ? 'b' : 'w');

  /** Penyimpanan aman: bisa melempar galat di mode privat. */
  const store = {
    getSession(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    setSession(k, v) {
      try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* abaikan */ }
    },
    getLocal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    setLocal(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* abaikan */ }  }
  };

  /**
   * Identitas pemain disimpan per TAB (sessionStorage), bukan per browser.
   * Akibatnya: refresh halaman mengembalikan kursi yang sama, tetapi dua tab di
   * satu komputer dihitung sebagai dua pemain berbeda (berguna untuk uji coba).
   */
  function getPlayerId() {
    let id = store.getSession('catur.pid');
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      store.setSession('catur.pid', id);
    }
    return id;
  }

  /* =====================================================================
     2. STATE KLIEN
     ===================================================================== */
  const socket = io();
  const playerId = getPlayerId();

  let state = null;                       // state terakhir dari server
  let role = null;                        // 'w' | 'b' | 'spectator'
  let roomCode = store.getSession('catur.room');
  let grid = [];                          // papan hasil parse FEN: grid[0] = rank 8
  let sync = { at: 0, w: 0, b: 0, running: null };   // acuan hitung mundur jam lokal
  let selected = null;                    // kotak bidak yang sedang dipilih
  let drag = null;                        // data drag aktif
  let resultDismissedKey = null;          // hasil game yang sudah ditutup pemain

  const boardEl = $('board');

  /* =====================================================================
     3. LOBI DAN KONEKSI
     ===================================================================== */
  $('name').value = store.getLocal('catur.name') || '';
  $('name').addEventListener('change', () => store.setLocal('catur.name', $('name').value.trim()));

  // Tautan undangan: ?room=KODE mengisi kolom kode otomatis
  const invited = new URLSearchParams(location.search).get('room');
  if (invited) $('code').value = invited.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

  const playerName = () => $('name').value.trim();
  const setLobbyError = (msg) => { $('lobby-error').textContent = msg || ''; };

  function showGame() { $('lobby').hidden = true; $('game').hidden = false; }
  function showLobby() {
    $('game').hidden = true;
    $('lobby').hidden = false;
    state = null; role = null; selected = null;
    cancelDrag();
    $('promo').hidden = true;
  }
  function forgetRoom() { roomCode = null; store.setSession('catur.room', null); }

  function onEntered(res) {
    if (!res || !res.ok) { setLobbyError((res && res.error) || 'Gagal masuk room.'); return; }
    roomCode = res.code;
    store.setSession('catur.room', roomCode);
    setLobbyError('');
    showGame();
  }

  function createRoom() {
    setLobbyError('');
    store.setLocal('catur.name', playerName());
    socket.emit('room:create', {
      playerId, name: playerName(),
      minutes: Number($('minutes').value), increment: Number($('increment').value)
    }, onEntered);
  }

  /** silent = true untuk masuk ulang otomatis (refresh atau koneksi pulih). */
  function joinRoom(code, silent) {
    if (!silent) { setLobbyError(''); store.setLocal('catur.name', playerName()); }
    socket.emit('room:join', { playerId, name: playerName(), code }, (res) => {
      if (res && res.ok) { onEntered(res); return; }
      if (silent) { forgetRoom(); showLobby(); }
      setLobbyError((res && res.error) || 'Gagal masuk room.');
    });
  }

  $('btn-create').addEventListener('click', createRoom);
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('code').value.trim().toUpperCase();
    if (code.length < 5) { setLobbyError('Masukkan kode room 5 karakter.'); return; }
    joinRoom(code, false);
  });

  socket.on('connect', () => {
    $('conn').textContent = 'Terhubung ke server.';
    if (roomCode) joinRoom(roomCode, true);        // ambil kembali kursi setelah refresh atau koneksi putus
  });
  socket.on('disconnect', () => {
    $('conn').textContent = 'Koneksi terputus. Mencoba menyambung kembali…';
    if (state) toast('Koneksi terputus. Mencoba menyambung kembali…');
  });
  socket.on('room:replaced', () => {
    forgetRoom(); showLobby();
    setLobbyError('Sesi ini dipindahkan ke tab atau perangkat lain.');
  });
  socket.on('room:state', onState);

  /* =====================================================================
     4. MENERIMA STATE DAN MENGGAMBAR
     ===================================================================== */
  function onState(s) {
    const fenChanged = !state || state.fen !== s.fen;
    state = s;
    role = s.you.role || 'spectator';
    grid = parseFen(s.fen);
    sync = { at: Date.now(), w: s.clock.w, b: s.clock.b, running: s.clock.running };
    if (fenChanged) { selected = null; cancelDrag(); }
    showGame();
    render();
  }

  function render() {
    renderBoard();
    renderBars();
    renderPanel();
    renderResult();
    updateClocks();
  }

  /** FEN -> array 8x8 berisi {color, type} atau null. grid[0] = rank 8. */
  function parseFen(fen) {
    return fen.split(' ')[0].split('/').map((row) => {
      const out = [];
      for (const ch of row) {
        if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) out.push(null);
        else out.push({ color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toLowerCase() });
      }
      return out;
    });
  }
  function pieceAt(sq) {
    const r = 8 - Number(sq[1]), c = FILES.indexOf(sq[0]);
    return grid[r] ? grid[r][c] : null;
  }

  /* ---------- Papan ---------- */

  /** Bangun ulang 64 kotak. Papan diputar (flip) agar warna Anda selalu di bawah. */
  function renderBoard() {
    const flipped = role === 'b';
    const last = state.lastMove;
    boardEl.textContent = '';

    for (let dr = 0; dr < 8; dr++) {
      for (let dc = 0; dc < 8; dc++) {
        const r = flipped ? 7 - dr : dr;
        const c = flipped ? 7 - dc : dc;
        const sq = FILES[c] + (8 - r);

        const el = document.createElement('div');
        el.className = 'sq ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
        el.dataset.sq = sq;
        if (last && (sq === last.from || sq === last.to)) el.classList.add('last');   // sorot kotak asal dan tujuan
        if (state.checkSquare === sq) el.classList.add('check');

        if (dc === 0) el.appendChild(coord('rank', String(8 - r)));
        if (dr === 7) el.appendChild(coord('file', FILES[c]));

        const p = grid[r][c];
        if (p) {
          const span = document.createElement('span');
          span.className = 'piece ' + p.color;
          span.textContent = GLYPH[p.type] + TEXT_VS;
          el.appendChild(span);
        }
        boardEl.appendChild(el);
      }
    }
    refreshHighlights();
  }

  function coord(kind, text) {
    const s = document.createElement('span');
    s.className = 'coord ' + kind;
    s.textContent = text;
    return s;
  }

  /** Kotak tujuan legal untuk bidak terpilih (hanya bila sedang giliran Anda). */
  function legalTargets() {
    if (!selected || !canMove()) return new Set();
    return new Set(state.legalMoves[selected] || []);
  }

  /** Perbarui sorotan pilihan dan titik tujuan TANPA membangun ulang papan (penting saat drag). */
  function refreshHighlights() {
    const targets = legalTargets();
    boardEl.querySelectorAll('.sq').forEach((el) => {
      const sq = el.dataset.sq;
      el.classList.toggle('sel', sq === selected);
      el.classList.toggle('target', targets.has(sq));
      el.classList.toggle('cap', targets.has(sq) && !!pieceAt(sq));
    });
  }

  function clearSelection() { selected = null; refreshHighlights(); }

  /** Boleh melangkah: game berjalan, Anda pemain, dan sedang giliran Anda. */
  function canMove() {
    return !!state && state.status === 'playing' && (role === 'w' || role === 'b') && state.turn === role;
  }

  /* ---------- Bar pemain dan jam ---------- */
  function renderBars() {
    const bottom = role === 'b' ? 'b' : 'w';
    fillBar($('bar-bottom'), bottom);
    fillBar($('bar-top'), opposite(bottom));
  }
  function fillBar(el, color) {
    const p = state.players[color];
    el.dataset.color = color;
    el.querySelector('.chip').className = 'chip ' + color;
    el.querySelector('.pname').textContent = (p ? p.name : 'Menunggu pemain…') + (role === color ? ' (Anda)' : '');
    el.querySelector('.pflag').textContent = p && !p.connected ? 'terputus' : '';
  }

  /** Waktu tersisa saat ini: nilai server dikurangi waktu lokal sejak state diterima. */
  function currentClocks() {
    const c = { w: sync.w, b: sync.b };
    if (sync.running) c[sync.running] = Math.max(0, c[sync.running] - (Date.now() - sync.at));
    return c;
  }
  function formatClock(ms) {
    ms = Math.max(0, ms);
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    return ms < 20000 ? m + ':' + ss + '.' + Math.floor((ms % 1000) / 100) : m + ':' + ss;
  }
  function updateClocks() {
    if (!state) return;
    const c = currentClocks();
    for (const bar of [$('bar-top'), $('bar-bottom')]) {
      const color = bar.dataset.color;
      if (!color) continue;
      bar.querySelector('.clock').textContent = formatClock(c[color]);
      bar.classList.toggle('active', sync.running === color);
      bar.classList.toggle('low', state.status === 'playing' && c[color] < 20000);
    }
  }
  setInterval(updateClocks, 100);

  /* ---------- Panel info ---------- */
  function resultText(res) {
    if (!res) return '';
    const w = res.winner, l = w ? opposite(w) : null;
    switch (res.reason) {
      case 'checkmate': return 'Skakmat! ' + NAME[w] + ' menang.';
      case 'timeout': return 'Waktu ' + NAME[l] + ' habis. ' + NAME[w] + ' menang.';
      case 'resign': return NAME[l] + ' menyerah. ' + NAME[w] + ' menang.';
      case 'stalemate': return 'Remis: stalemate (tidak ada langkah legal).';
      case 'insufficient': return 'Remis: bidak tidak cukup untuk skakmat.';
      case 'timeout-insufficient': return 'Waktu habis, tetapi lawan tidak punya bidak cukup untuk skakmat. Remis.';
      case 'threefold': return 'Remis: posisi berulang tiga kali.';
      case 'fifty-move': return 'Remis: aturan 50 langkah.';
      case 'agreement': return 'Remis atas kesepakatan.';
      default: return 'Remis.';
    }
  }
  function resultTitle(res) {
    if (!res || !res.winner) return 'Remis';
    if (role === 'w' || role === 'b') return res.winner === role ? 'Anda menang!' : 'Anda kalah';
    return 'Game Over';
  }

  function renderPanel() {
    const s = state;
    const isPlayer = role === 'w' || role === 'b';

    // Banner status dan baris info
    let cls, text, turnText, statusText;
    if (s.status === 'waiting') {
      cls = 'wait'; text = 'Menunggu lawan…'; turnText = '-'; statusText = 'Menunggu lawan…';
    } else if (s.status === 'finished') {
      cls = 'over'; text = 'Game Over. ' + resultText(s.result); turnText = '-'; statusText = 'Game Over';
    } else {
      const mine = s.turn === role;
      turnText = NAME[s.turn] + (mine ? ' (Anda)' : '');
      statusText = s.history.length === 0 ? 'Permainan dimulai' : (s.checkSquare ? 'Skak!' : 'Berjalan');
      cls = 'play';
      if (s.history.length === 0) text = 'Permainan dimulai. ' + (mine ? 'Giliran Anda.' : 'Giliran ' + NAME[s.turn] + '.');
      else if (isPlayer) text = (mine ? 'Giliran Anda' : 'Giliran lawan') + (s.checkSquare ? ' · Skak!' : '');
      else text = 'Giliran ' + NAME[s.turn] + (s.checkSquare ? ' · Skak!' : '');
    }
    const banner = $('banner');
    banner.className = 'banner ' + cls;
    banner.textContent = text;

    $('info-code').textContent = s.code;
    $('info-role').textContent = isPlayer ? NAME[role] : 'Penonton';
    $('info-turn').textContent = turnText;
    $('info-status').textContent = statusText;
    $('info-spec').textContent = String(s.spectators);

    renderMoves();
    renderActions();
  }

  /** Daftar langkah (notasi SAN) dalam pasangan putih-hitam. */
  function renderMoves() {
    const ol = $('moves');
    const h = state.history;
    ol.textContent = '';
    if (!h.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Belum ada langkah.';
      ol.appendChild(li);
      return;
    }
    const add = (text, cls) => {
      const li = document.createElement('li');
      li.textContent = text;
      if (cls) li.className = cls;
      ol.appendChild(li);
    };
    for (let i = 0; i < h.length; i += 2) {
      add((i / 2 + 1) + '.', 'n');
      add(h[i], i === h.length - 1 ? 'cur' : '');
      add(h[i + 1] || '', i + 1 === h.length - 1 ? 'cur' : '');
    }
    ol.scrollTop = ol.scrollHeight;
  }

  function renderActions() {
    const s = state;
    const isPlayer = role === 'w' || role === 'b';
    const playing = s.status === 'playing';

    $('btn-resign').hidden = !(isPlayer && playing);
    $('btn-draw').hidden = !(isPlayer && playing);
    $('btn-draw').disabled = s.drawOffer === role;
    $('btn-draw').textContent = s.drawOffer === role ? 'Tawaran terkirim' : 'Tawar Remis';
    $('draw-prompt').hidden = !(isPlayer && playing && s.drawOffer === opposite(role));

    const canRematch = isPlayer && s.status === 'finished' && !!s.players.w && !!s.players.b;
    const rematchBtn = $('btn-rematch');
    rematchBtn.hidden = !canRematch;
    setRematchLabel(rematchBtn);
  }

  function setRematchLabel(btn) {
    if (!state || !(role === 'w' || role === 'b')) return;
    const mine = state.rematch[role], theirs = state.rematch[opposite(role)];
    btn.disabled = !!mine;
    btn.textContent = mine ? 'Menunggu lawan…' : (theirs ? 'Rematch (lawan siap)' : 'Rematch');
  }

  /** Kartu hasil di atas papan saat game selesai. */
  function renderResult() {
    const el = $('result');
    if (state.status !== 'finished') { el.hidden = true; resultDismissedKey = null; return; }
    const key = state.history.length + ':' + JSON.stringify(state.result);
    if (resultDismissedKey === key) { el.hidden = true; return; }
    el.hidden = false;
    $('result-title').textContent = resultTitle(state.result);
    $('result-text').textContent = resultText(state.result);
    const canRematch = (role === 'w' || role === 'b') && !!state.players.w && !!state.players.b;
    $('res-rematch').hidden = !canRematch;
    setRematchLabel($('res-rematch'));
  }

  /* =====================================================================
     5. INTERAKSI PAPAN: klik-untuk-pindah dan drag-and-drop
        Memakai Pointer Events, jadi satu kode untuk mouse, layar sentuh, dan pena.
     ===================================================================== */

  boardEl.addEventListener('pointerdown', (e) => {
    if (!canMove() || drag) return;
    const sqEl = e.target.closest ? e.target.closest('.sq') : null;
    if (!sqEl) return;
    const sq = sqEl.dataset.sq;
    const piece = pieceAt(sq);

    // (a) Bidak sudah dipilih dan kotak ini tujuan legal: pindahkan (klik-untuk-pindah)
    if (selected && legalTargets().has(sq)) {
      e.preventDefault();
      const from = selected;
      clearSelection();
      attemptMove(from, sq);
      return;
    }

    // (b) Menekan bidak sendiri yang punya langkah legal: pilih dan siap di-drag
    if (piece && piece.color === role && state.legalMoves[sq]) {
      e.preventDefault();
      const wasSelected = selected === sq;
      selected = sq;
      refreshHighlights();
      try { boardEl.setPointerCapture(e.pointerId); } catch (err) { /* abaikan */ }
      drag = { from: sq, pid: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, moved: false, ghost: null, wasSelected };
      return;
    }

    // (c) Selain itu: batalkan pilihan
    clearSelection();
  });

  /** Titik acuan drop. Di layar sentuh bidak diangkat di atas jari agar tidak tertutup. */
  function dragPoint(e) {
    const lift = drag && drag.type === 'touch' ? (boardEl.clientWidth / 8) * 0.9 : 0;
    return { x: e.clientX, y: e.clientY - lift };
  }

  function startGhost() {
    const src = boardEl.querySelector('[data-sq="' + drag.from + '"] .piece');
    if (!src) return;
    const ghost = src.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.style.fontSize = getComputedStyle(src).fontSize;
    $('game').appendChild(ghost);
    src.classList.add('dragging');
    drag.ghost = ghost;
  }

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;   // abaikan getaran kecil
      drag.moved = true;
      startGhost();
    }
    if (drag.ghost) {
      const p = dragPoint(e);
      drag.ghost.style.left = p.x + 'px';
      drag.ghost.style.top = p.y + 'px';
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    cancelDrag();

    if (d.moved) {
      // Cari kotak di bawah titik drop
      const p = (d.type === 'touch') ? { x: e.clientX, y: e.clientY - (boardEl.clientWidth / 8) * 0.9 } : { x: e.clientX, y: e.clientY };
      const el = document.elementFromPoint(p.x, p.y);
      const sqEl = el && el.closest ? el.closest('.sq') : null;
      const to = sqEl && sqEl.dataset.sq;
      if (to && to !== d.from && legalTargets().has(to)) {
        clearSelection();
        attemptMove(d.from, to);
      }
      return;                       // dilepas di tempat tidak sah: bidak kembali ke kotak asal
    }
    if (d.wasSelected) clearSelection();   // klik ulang bidak terpilih = batal pilih
  });
  window.addEventListener('pointercancel', () => cancelDrag());

  /** Hentikan drag: buang bidak bayangan dan pulihkan bidak asal. */
  function cancelDrag() {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    const src = boardEl.querySelector('.piece.dragging');
    if (src) src.classList.remove('dragging');
    drag = null;
  }

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { cancelDrag(); clearSelection(); } });

  /** Kirim langkah ke server. Pion yang sampai baris terakhir menampilkan pilihan promosi dulu. */
  async function attemptMove(from, to) {
    const piece = pieceAt(from);
    let promotion;
    if (piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1')) {
      promotion = await askPromotion(piece.color);
      if (!promotion) return;                      // dibatalkan
    }
    socket.emit('game:move', { from, to, promotion }, (res) => {
      if (!res || !res.ok) toast((res && res.error) || 'Langkah ditolak.');
    });
  }

  function askPromotion(color) {
    return new Promise((resolve) => {
      const box = $('promo-choices');
      const modal = $('promo');
      box.textContent = '';
      const close = (value) => { modal.hidden = true; modal.onclick = null; resolve(value); };
      ['q', 'r', 'b', 'n'].forEach((t) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = color;
        b.textContent = GLYPH[t] + TEXT_VS;
        b.setAttribute('aria-label', PROMO_NAME[t]);
        b.addEventListener('click', () => close(t));
        box.appendChild(b);
      });
      modal.onclick = (e) => { if (e.target === modal) close(null); };   // klik di luar kartu = batal
      modal.hidden = false;
    });
  }

  /* =====================================================================
     6. TOMBOL AKSI
     ===================================================================== */

  /** Tombol dua langkah (pengganti confirm(), yang sering diblokir): ketuk dua kali dalam 3 detik. */
  function twoStep(btn, armedLabel, action) {
    let timer = null, original = btn.textContent;
    btn.addEventListener('click', () => {
      if (timer) { clearTimeout(timer); timer = null; btn.textContent = original; action(); return; }
      original = btn.textContent;
      btn.textContent = armedLabel;
      timer = setTimeout(() => { timer = null; btn.textContent = original; }, 3000);
    });
  }

  const sendAction = (event, payload) => socket.emit(event, payload || {}, (res) => {
    if (res && !res.ok && res.error) toast(res.error);
  });

  twoStep($('btn-resign'), 'Yakin menyerah?', () => sendAction('game:resign'));
  $('btn-draw').addEventListener('click', () => { sendAction('game:draw-offer'); toast('Tawaran remis dikirim.'); });
  $('btn-draw-yes').addEventListener('click', () => sendAction('game:draw-respond', { accept: true }));
  $('btn-draw-no').addEventListener('click', () => sendAction('game:draw-respond', { accept: false }));
  $('btn-rematch').addEventListener('click', () => sendAction('game:rematch'));
  $('res-rematch').addEventListener('click', () => sendAction('game:rematch'));
  $('res-close').addEventListener('click', () => {
    resultDismissedKey = state.history.length + ':' + JSON.stringify(state.result);
    $('result').hidden = true;
  });

  // Keluar di tengah permainan dihitung menyerah, jadi minta konfirmasi dua langkah
  (function setupLeave() {
    const btn = $('btn-leave');
    const leave = () => { socket.emit('room:leave', {}, () => {}); forgetRoom(); showLobby(); };
    let timer = null;
    btn.addEventListener('click', () => {
      const midGame = state && state.status === 'playing' && (role === 'w' || role === 'b');
      if (!midGame) { leave(); return; }
      if (timer) { clearTimeout(timer); timer = null; btn.textContent = 'Keluar'; leave(); return; }
      btn.textContent = 'Keluar = menyerah. Ketuk lagi';
      timer = setTimeout(() => { timer = null; btn.textContent = 'Keluar'; }, 3000);
    });
  })();

  $('btn-copy').addEventListener('click', async () => {
    if (!state) return;
    const link = location.origin + location.pathname + '?room=' + state.code;
    try {
      await navigator.clipboard.writeText(link);
      toast('Tautan undangan disalin.');
    } catch (e) {
      // Cadangan untuk browser yang menolak Clipboard API
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (err) { /* abaikan */ }
      ta.remove();
      toast(copied ? 'Tautan undangan disalin.' : 'Salin manual: ' + link);
    }
  });

  /* =====================================================================
     7. TOAST
     ===================================================================== */
  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
})();
