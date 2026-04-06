const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── GAME STATE ──
const rooms = {};      // roomId → room object
const players = {};    // socketId → { name, roomId, avatar }
const queue = [];      // public matchmaking queue: [socketId]

const TURN_TIME = 60;  // seconds per turn

function makeRoom(id, isPrivate, password) {
  return {
    id,
    isPrivate,
    password: password || null,
    players: [],       // [{id, name, avatar, secret, ready}]
    phase: 'waiting',  // waiting | picking | playing | done
    turn: null,        // whose turn it is (socketId)
    timer: null,
    timeLeft: TURN_TIME,
    chat: [],
    guesses: {},       // {socketId: [{guess,bulls,cows}]}
    winner: null
  };
}

function evalNum(guess, secret) {
  let bulls = 0, cows = 0;
  for (let i = 0; i < guess.length; i++) {
    if (guess[i] === secret[i]) bulls++;
    else if (secret.includes(guess[i])) cows++;
  }
  return { bulls, cows };
}

function getRoomPublicState(room) {
  return {
    id: room.id,
    phase: room.phase,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      ready: p.ready,
      guessCount: (room.guesses[p.id] || []).length
    })),
    turn: room.turn,
    timeLeft: room.timeLeft,
    chat: room.chat,
    guesses: room.guesses,
    winner: room.winner
  };
}

function startTurnTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  clearInterval(room.timer);
  room.timeLeft = TURN_TIME;

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomId).emit('timer', room.timeLeft);

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      // Auto-skip: pass turn
      io.to(roomId).emit('chat_msg', {
        system: true,
        text: `⏰ Time's up! Turn passed.`
      });
      switchTurn(roomId);
    }
  }, 1000);
}

function switchTurn(roomId) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'playing') return;
  const ids = room.players.map(p => p.id);
  const idx = ids.indexOf(room.turn);
  room.turn = ids[(idx + 1) % ids.length];
  io.to(roomId).emit('turn_change', { turn: room.turn });
  startTurnTimer(roomId);
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.phase = 'playing';
  room.turn = room.players[0].id;
  room.guesses = {};
  room.players.forEach(p => { room.guesses[p.id] = [] });
  io.to(roomId).emit('game_start', getRoomPublicState(room));
  startTurnTimer(roomId);
}

io.on('connection', (socket) => {
  console.log('connect:', socket.id);

  // ── JOIN / CREATE ──
  socket.on('set_player', ({ name, avatar }) => {
    players[socket.id] = { name: name || 'Cowpoke', avatar: avatar || '🤠', roomId: null };
    socket.emit('player_set', { id: socket.id });
  });

  // Public matchmaking
  socket.on('find_match', () => {
    const p = players[socket.id];
    if (!p) return;
    if (queue.includes(socket.id)) return;

    // Remove any dead entries from queue
    const liveQueue = queue.filter(id => io.sockets.sockets.has(id));
    queue.length = 0;
    liveQueue.forEach(id => queue.push(id));

    if (queue.length > 0) {
      const opponentId = queue.shift();
      const roomId = 'room_' + Date.now();
      const room = makeRoom(roomId, false, null);
      rooms[roomId] = room;

      [opponentId, socket.id].forEach(id => {
        const pl = players[id];
        if (!pl) return;
        pl.roomId = roomId;
        room.players.push({ id, name: pl.name, avatar: pl.avatar, secret: null, ready: false });
        room.guesses[id] = [];
        io.sockets.sockets.get(id)?.join(roomId);
      });

      io.to(roomId).emit('room_joined', { roomId, state: getRoomPublicState(room) });
      io.to(roomId).emit('phase_change', { phase: 'picking' });
      room.phase = 'picking';
    } else {
      queue.push(socket.id);
      socket.emit('in_queue', { msg: 'Looking for an opponent...' });
    }
  });

  // Private room
  socket.on('create_private', ({ password }) => {
    const roomId = 'priv_' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const room = makeRoom(roomId, true, password);
    rooms[roomId] = room;
    const p = players[socket.id];
    if (!p) return;
    p.roomId = roomId;
    room.players.push({ id: socket.id, name: p.name, avatar: p.avatar, secret: null, ready: false });
    socket.join(roomId);
    socket.emit('room_created', { roomId, state: getRoomPublicState(room) });
  });

  socket.on('join_private', ({ roomId, password }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('error_msg', 'Room not found.'); return; }
    if (room.password && room.password !== password) { socket.emit('error_msg', 'Wrong password!'); return; }
    if (room.players.length >= 2) { socket.emit('error_msg', 'Room is full!'); return; }
    if (room.phase !== 'waiting') { socket.emit('error_msg', 'Game already started.'); return; }

    const p = players[socket.id];
    if (!p) return;
    p.roomId = roomId;
    room.players.push({ id: socket.id, name: p.name, avatar: p.avatar, secret: null, ready: false });
    socket.join(roomId);
    room.phase = 'picking';
    io.to(roomId).emit('room_joined', { roomId, state: getRoomPublicState(room) });
    io.to(roomId).emit('phase_change', { phase: 'picking' });
  });

  // ── PICKING SECRET ──
  socket.on('set_secret', ({ secret }) => {
    const p = players[socket.id];
    if (!p || !p.roomId) return;
    const room = rooms[p.roomId];
    if (!room || room.phase !== 'picking') return;
    const rp = room.players.find(x => x.id === socket.id);
    if (!rp) return;
    // Validate secret
    if (!/^\d+$/.test(secret) || new Set(secret).size !== secret.length || secret[0] === '0') {
      socket.emit('error_msg', 'Invalid secret number!'); return;
    }
    rp.secret = secret;
    rp.ready = true;
    socket.emit('secret_confirmed');
    io.to(p.roomId).emit('player_ready', { id: socket.id, name: rp.name });

    if (room.players.every(x => x.ready)) {
      startGame(p.roomId);
    }
  });

  // ── GUESSING ──
  socket.on('make_guess', ({ guess }) => {
    const p = players[socket.id];
    if (!p || !p.roomId) return;
    const room = rooms[p.roomId];
    if (!room || room.phase !== 'playing') return;
    if (room.turn !== socket.id) { socket.emit('error_msg', 'Not your turn!'); return; }

    // Validate guess
    if (!/^\d+$/.test(guess) || new Set(guess).size !== guess.length || guess[0] === '0') {
      socket.emit('error_msg', 'Invalid guess!'); return;
    }

    const opponent = room.players.find(x => x.id !== socket.id);
    if (!opponent || !opponent.secret) return;
    if (guess.length !== opponent.secret.length) { socket.emit('error_msg', 'Wrong number of digits!'); return; }

    const { bulls, cows } = evalNum(guess, opponent.secret);
    const entry = { guess, bulls, cows, by: socket.id };
    room.guesses[socket.id].push(entry);

    io.to(p.roomId).emit('guess_result', { by: socket.id, guess, bulls, cows });

    if (bulls === opponent.secret.length) {
      // Winner!
      clearInterval(room.timer);
      room.phase = 'done';
      room.winner = socket.id;
      io.to(p.roomId).emit('game_over', {
        winner: socket.id,
        winnerName: p.name,
        secret: opponent.secret,
        guesses: room.guesses
      });
    } else {
      switchTurn(p.roomId);
    }
  });

  // ── CHAT ──
  socket.on('chat', ({ text }) => {
    const p = players[socket.id];
    if (!p || !p.roomId) return;
    const room = rooms[p.roomId];
    if (!room) return;
    const msg = {
      from: socket.id,
      name: p.name,
      avatar: p.avatar,
      text: text.slice(0, 200),
      system: false
    };
    room.chat.push(msg);
    io.to(p.roomId).emit('chat_msg', msg);
  });

  // ── REMATCH ──
  socket.on('request_rematch', () => {
    const p = players[socket.id];
    if (!p || !p.roomId) return;
    const room = rooms[p.roomId];
    if (!room || room.phase !== 'done') return;
    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(socket.id);
    io.to(p.roomId).emit('rematch_vote', { id: socket.id, count: room.rematchVotes.size });
    if (room.rematchVotes.size === 2) {
      room.rematchVotes = null;
      room.players.forEach(pl => { pl.secret = null; pl.ready = false; });
      room.phase = 'picking';
      room.winner = null;
      room.guesses = {};
      io.to(p.roomId).emit('phase_change', { phase: 'picking' });
    }
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p && p.roomId) {
      const room = rooms[p.roomId];
      if (room) {
        clearInterval(room.timer);
        io.to(p.roomId).emit('opponent_left', { name: p.name });
        // Clean up room
        setTimeout(() => { delete rooms[p.roomId] }, 5000);
      }
    }
    // Remove from queue
    const qi = queue.indexOf(socket.id);
    if (qi > -1) queue.splice(qi, 1);
    delete players[socket.id];
    console.log('disconnect:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🤠 Cowboy Robert server running on port ${PORT}`));
