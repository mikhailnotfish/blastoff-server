const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

// ── CONFIG ────────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'CHANGE_THIS_PASSWORD';  // <-- change before deploying!
const MAX_NAME_LEN   = 20;
const TICK_MS        = 50;  // position broadcast interval (20/s)

// Max cash per second any rocket can earn (Boosted Sky Dragon = 2.75/tick * 60 = 165/s)
// We allow a generous 300/s to cover rank multipliers
const MAX_CASH_PER_SEC = 300;

// ── STATE ─────────────────────────────────────────────────────────────────────
const players = {};   // id -> { id, name, x, y, z, rotY, rank, rocketTier, isAdmin }
const acState = {};   // id -> { cashLastCheck, timeLastCheck, warnings }

// ── HELPERS ───────────────────────────────────────────────────────────────────
function sanitiseName(n){
  return String(n).substring(0, MAX_NAME_LEN).replace(/[<>&"']/g,'').trim() || 'Player';
}

function broadcastPlayerList(){
  const list = Object.values(players).map(p => ({
    id: p.id, name: p.name, rank: p.rank,
    rocketTier: p.rocketTier, isAdmin: p.isAdmin
  }));
  io.emit('playerList', list);
}

// ── CONNECTIONS ───────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  players[socket.id] = {
    id: socket.id, name: 'Player',
    x: 0, y: 1, z: 5, rotY: 0,
    rank: 0, rocketTier: 0, isAdmin: false,
    cash: 0, gems: 0
  };
  acState[socket.id] = {
    cashLastCheck: 0, timeLastCheck: Date.now(), warnings: 0
  };

  // Tell new player their ID + all existing players
  socket.emit('welcome', {
    yourId: socket.id,
    players: Object.values(players).filter(p => p.id !== socket.id)
  });

  // Tell everyone else a new player joined
  socket.broadcast.emit('playerJoined', players[socket.id]);
  broadcastPlayerList();

  // ── SET NAME ────────────────────────────────────────────────────────────────
  socket.on('setName', raw => {
    if (!players[socket.id]) return;
    players[socket.id].name = sanitiseName(raw);
    io.emit('playerUpdated', { id: socket.id, name: players[socket.id].name });
    broadcastPlayerList();
  });

  // ── POSITION UPDATE ─────────────────────────────────────────────────────────
  socket.on('move', data => {
    if (!players[socket.id]) return;
    const p = players[socket.id];
    // Clamp altitude to reasonable world bounds
    const y = Math.min(Math.max(data.y ?? p.y, -10), 4500);
    p.x = typeof data.x === 'number' ? data.x : p.x;
    p.y = y;
    p.z = typeof data.z === 'number' ? data.z : p.z;
    p.rotY = typeof data.rotY === 'number' ? data.rotY : p.rotY;
    socket.broadcast.emit('playerMoved', { id: socket.id, x: p.x, y: p.y, z: p.z, rotY: p.rotY });
  });

  // ── ANTI-CHEAT: cash report ──────────────────────────────────────────────────
  // Client reports cash every 5s. Server checks rate of increase.
  socket.on('cashReport', clientCash => {
    if (!players[socket.id]) return;
    const ac = acState[socket.id];
    const now = Date.now();
    const elapsed = (now - ac.timeLastCheck) / 1000; // seconds
    if (elapsed < 1) return; // too frequent

    const increase = clientCash - ac.cashLastCheck;
    const ratePerSec = increase / elapsed;

    if (ratePerSec > MAX_CASH_PER_SEC && increase > 500) {
      ac.warnings++;
      console.log(`[AC] ${players[socket.id].name} suspicious cash rate: ${ratePerSec.toFixed(0)}/s (warning ${ac.warnings})`);
      socket.emit('acWarning', { type: 'cash', rate: ratePerSec });
      if (ac.warnings >= 3) {
        console.log(`[AC] Auto-kicking ${players[socket.id].name} for cash cheating`);
        socket.emit('kicked', 'Kicked: anti-cheat triggered.');
        socket.disconnect();
        return;
      }
    }

    ac.cashLastCheck  = clientCash;
    ac.timeLastCheck  = now;
    players[socket.id].cash = clientCash;
  });

  // ── ADMIN LOGIN ──────────────────────────────────────────────────────────────
  socket.on('adminLogin', password => {
    if (password === ADMIN_PASSWORD) {
      players[socket.id].isAdmin = true;
      socket.emit('adminGranted');
      console.log(`[ADMIN] ${players[socket.id].name} (${socket.id}) logged in as admin`);
      broadcastPlayerList();
    } else {
      socket.emit('adminDenied');
      console.log(`[ADMIN] Failed login attempt from ${socket.id}`);
    }
  });

  // ── ADMIN COMMANDS ───────────────────────────────────────────────────────────
  socket.on('adminCmd', data => {
    const sender = players[socket.id];
    if (!sender?.isAdmin) {
      console.log(`[ADMIN] Unauthorised command attempt from ${socket.id}`);
      return;
    }

    const { action, targetId } = data;
    const target = io.sockets.sockets.get(targetId);
    const targetPlayer = players[targetId];

    if (!target || !targetPlayer) {
      socket.emit('adminError', 'Player not found or already disconnected.');
      return;
    }

    if (action === 'kick') {
      console.log(`[ADMIN] ${sender.name} kicked ${targetPlayer.name}`);
      target.emit('kicked', `You were kicked by an admin.`);
      target.disconnect();
      socket.emit('adminSuccess', `Kicked ${targetPlayer.name}`);
    }

    if (action === 'fling') {
      console.log(`[ADMIN] ${sender.name} flung ${targetPlayer.name}`);
      target.emit('flung', { vx:(Math.random()-0.5)*30, vy:40, vz:(Math.random()-0.5)*30 });
      socket.emit('adminSuccess', `Flung ${targetPlayer.name}`);
    }
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    if (players[socket.id]) {
      io.emit('playerLeft', socket.id);
      delete players[socket.id];
      delete acState[socket.id];
      broadcastPlayerList();
    }
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Blast Off server running on port ${PORT}`));
