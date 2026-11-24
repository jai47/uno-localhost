const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,       // Default heartbeat (stable)
  pingTimeout: 20000,        // Default timeout (stable)
  perMessageDeflate: false,  // Disable compression for lower latency
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
});
const PORT = process.env.PORT || 6969;

app.use(express.static('public', {
  maxAge: '1h',           // Cache static assets for 1 hour
  etag: true,
  lastModified: true,
}));

// ============================================================
//  CONSTANTS
// ============================================================
const COLORS = ['red', 'yellow', 'green', 'blue'];
const NUMBER_VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const ACTION_VALUES = ['skip', 'reverse', 'draw2'];

const REACTION_EMOJIS = ['😂', '😡', '😢', '🤬'];
const REACTION_COOLDOWN_MS = 700;
const reactionCooldowns = new Map(); // socketId → last reaction timestamp

// ============================================================
//  BOT CONSTANTS
// ============================================================
const BOT_NAMES = ['Bot 🤖', 'Bot 🧠', 'Bot 🎯', 'Bot 🔥', 'Bot 💀'];
const BOT_TURN_DELAY_MIN = 1200;  // ms
const BOT_TURN_DELAY_MAX = 2200;  // ms
const BOT_UNO_DELAY_MIN = 500;   // ms before bot calls UNO
const BOT_UNO_DELAY_MAX = 2000;  // ms before bot calls UNO
let botIdCounter = 0;

function generateBotId() {
  return `bot-${++botIdCounter}`;
}

function isBot(playerId) {
  return typeof playerId === 'string' && playerId.startsWith('bot-');
}

// ============================================================
//  ROOM & PLAYER STORAGE
// ============================================================
const rooms = new Map();          // roomCode → room object
const socketRooms = new Map();    // socketId  → { roomCode, playerName }
const disconnectTimers = new Map(); // `${roomCode}:${playerName}` → timeout handle

// ============================================================
//  DECK HELPERS
// ============================================================
function createDeck() {
  const deck = [];
  let id = 0;

  for (const color of COLORS) {
    deck.push({ id: id++, color, value: '0' });

    const others = [...NUMBER_VALUES.slice(1), ...ACTION_VALUES];
    for (const value of others) {
      deck.push({ id: id++, color, value });
      deck.push({ id: id++, color, value });
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({ id: id++, color: 'wild', value: 'wild' });
    deck.push({ id: id++, color: 'wild', value: 'wild4' });
  }

  return deck; // 108 cards
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
//  ROOM HELPERS
// ============================================================
function generateRoomCode() {
  let code;
  do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

function createRoom(hostId, hostName) {
  const code = generateRoomCode();
  const room = {
    code,
    players: [{ id: hostId, name: hostName, cards: [], calledUno: false }],
    deck: [],
    discardPile: [],
    currentPlayerIndex: 0,
    direction: 1,
    currentColor: null,
    started: false,
    host: hostId,
    winner: null,
    needsUnoCall: null,
    lastAction: null,
    cardSuggestions: true,
    scores: { [hostName]: 0 }, // name → wins (session scoreboard)
    totalGames: 0,
  };
  rooms.set(code, room);
  return room;
}

/** Sorted rank list for the room (wins desc). Includes current players + lingering names. */
function getScoreboard(room) {
  const names = new Set([
    ...Object.keys(room.scores || {}),
    ...room.players.map(p => p.name),
  ]);
  return [...names]
    .map(name => ({
      name,
      wins: room.scores[name] || 0,
      present: room.players.some(p => p.name === name),
    }))
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
}

function playerIndex(room, id) {
  return room.players.findIndex(p => p.id === id);
}

function drawCards(room, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) {
      if (room.discardPile.length <= 1) break;
      const top = room.discardPile.pop();
      room.deck = shuffle(room.discardPile);
      room.discardPile = [top];
    }
    drawn.push(room.deck.pop());
  }
  return drawn;
}

function nextIndex(room) {
  return (room.currentPlayerIndex + room.direction + room.players.length) % room.players.length;
}

function advanceTurn(room) {
  room.currentPlayerIndex = nextIndex(room);
}

// ============================================================
//  MOVE VALIDATION
// ============================================================
function isValidPlay(room, card) {
  if (card.color === 'wild') return true;
  if (card.color === room.currentColor) return true;
  const top = room.discardPile[room.discardPile.length - 1];
  if (top && card.value === top.value) return true;
  return false;
}

// ============================================================
//  SANITISED STATE (sent to each player)
// ============================================================
function sanitize(room, playerId) {
  const idx = playerIndex(room, playerId);
  const player = room.players[idx];
  return {
    roomCode: room.code,
    players: room.players.map((p, i) => ({
      name: p.name,
      cardCount: p.cards.length,
      isCurrentPlayer: i === room.currentPlayerIndex,
      calledUno: p.calledUno,
      index: i,
    })),
    myCards: player ? player.cards : [],
    myIndex: idx,
    topCard: room.discardPile.length ? room.discardPile[room.discardPile.length - 1] : null,
    currentColor: room.currentColor,
    currentPlayerIndex: room.currentPlayerIndex,
    direction: room.direction,
    isMyTurn: idx === room.currentPlayerIndex,
    drawPileCount: room.deck.length,
    winner: room.winner,
    isHost: playerId === room.host,
    started: room.started,
    needsUnoCall: room.needsUnoCall,
    lastAction: room.lastAction,
    cardSuggestions: room.cardSuggestions,
    scoreboard: getScoreboard(room),
    totalGames: room.totalGames || 0,
  };
}

function broadcastState(room) {
  for (const p of room.players) {
    if (!isBot(p.id)) {
      io.to(p.id).emit('game-update', sanitize(room, p.id));
    }
  }
  if (room.started && !room.winner) {
    // If it's now a bot's turn, schedule their play
    scheduleBotTurn(room);
    // If someone needs to call UNO, bots may try to catch them
    scheduleBotCatch(room);
  }
}

// ============================================================
//  START GAME
// ============================================================
function startGame(room) {
  room.deck = shuffle(createDeck());
  room.discardPile = [];
  room.currentPlayerIndex = 0;
  room.direction = 1;
  room.winner = null;
  room.started = true;
  room.needsUnoCall = null;
  room.lastAction = null;

  for (const p of room.players) {
    p.cards = drawCards(room, 7);
    p.calledUno = false;
  }

  // First card — keep drawing until it's not Wild Draw Four
  let first;
  do {
    first = room.deck.pop();
    if (first.value === 'wild4') {
      room.deck.unshift(first);
      room.deck = shuffle(room.deck);
    }
  } while (first.value === 'wild4');

  room.discardPile.push(first);
  room.currentColor = first.color === 'wild'
    ? COLORS[Math.floor(Math.random() * 4)]
    : first.color;

  // Apply first‑card effects
  if (first.value === 'skip') {
    room.lastAction = { type: 'skip', skippedPlayer: room.players[0].name };
    advanceTurn(room);
  } else if (first.value === 'reverse') {
    room.direction = room.players.length === 2 ? 1 : -1;
    if (room.players.length === 2) advanceTurn(room);
    room.lastAction = { type: 'reverse' };
  } else if (first.value === 'draw2') {
    const drawn = drawCards(room, 2);
    room.players[0].cards.push(...drawn);
    room.lastAction = { type: 'draw2', targetPlayer: room.players[0].name };
    advanceTurn(room);
  }
}

// ============================================================
//  BOT AI LOGIC
// ============================================================
const botTimers = new Map();     // roomCode → timeout handle (for turns)
const botCatchTimers = new Map(); // roomCode → timeout handle (for UNO catches)

/** Clean up all bot timers for a room */
function cleanupBotTimers(roomCode) {
  if (botTimers.has(roomCode)) {
    clearTimeout(botTimers.get(roomCode));
    botTimers.delete(roomCode);
  }
  if (botCatchTimers.has(roomCode)) {
    clearTimeout(botCatchTimers.get(roomCode));
    botCatchTimers.delete(roomCode);
  }
}

/** Emit a reaction emoji on behalf of a bot */
function botEmitReaction(room, botPlayer, emoji) {
  if (!room || !REACTION_EMOJIS.includes(emoji)) return;
  // Small random delay so it feels natural
  const delay = 300 + Math.random() * 800;
  setTimeout(() => {
    if (!rooms.has(room.code)) return; // room may have been cleaned up
    io.to(room.code).volatile.emit('reaction', { emoji, playerName: botPlayer.name });
  }, delay);
}

/** Schedule a bot to try catching someone who forgot to call UNO */
function scheduleBotCatch(room) {
  // Clear any existing catch timer
  if (botCatchTimers.has(room.code)) {
    clearTimeout(botCatchTimers.get(room.code));
    botCatchTimers.delete(room.code);
  }

  if (!room.started || room.winner) return;
  if (room.needsUnoCall === null) return;

  const targetIdx = room.needsUnoCall;
  const target = room.players[targetIdx];
  if (!target || target.calledUno || target.cards.length !== 1) return;

  // Find a bot that can catch (any bot that isn't the target)
  const catcherBot = room.players.find(p => isBot(p.id) && p !== target);
  if (!catcherBot) return;

  // Random delay 1-3 seconds
  const delay = 1000 + Math.random() * 2000;
  const timer = setTimeout(() => {
    botCatchTimers.delete(room.code);
    if (!rooms.has(room.code) || !room.started || room.winner) return;

    // Re-check conditions (player may have called UNO in the meantime)
    const t = room.players[targetIdx];
    if (!t || t.calledUno || t.cards.length !== 1 || room.needsUnoCall !== targetIdx) return;

    // Catch them!
    t.cards.push(...drawCards(room, 2));
    room.needsUnoCall = null;
    room.lastAction = { type: 'caught', playerName: t.name, caughtBy: catcherBot.name };
    broadcastState(room);
    io.to(room.code).emit('uno-caught', { playerName: t.name, caughtBy: catcherBot.name });

    // Bot reacts with 😂 for catching someone
    botEmitReaction(room, catcherBot, '😂');
  }, delay);
  botCatchTimers.set(room.code, timer);
}

function scheduleBotTurn(room) {
  // Clear any existing bot timer for this room
  if (botTimers.has(room.code)) {
    clearTimeout(botTimers.get(room.code));
    botTimers.delete(room.code);
  }

  const currentPlayer = room.players[room.currentPlayerIndex];
  if (!currentPlayer || !isBot(currentPlayer.id)) return;
  if (room.winner) return;

  const delay = BOT_TURN_DELAY_MIN + Math.random() * (BOT_TURN_DELAY_MAX - BOT_TURN_DELAY_MIN);
  const timer = setTimeout(() => botPlayTurn(room), delay);
  botTimers.set(room.code, timer);
}

function botPlayTurn(room) {
  botTimers.delete(room.code);
  if (!room.started || room.winner) return;

  const pIdx = room.currentPlayerIndex;
  const player = room.players[pIdx];
  if (!player || !isBot(player.id)) return;

  // Find playable cards
  const playable = player.cards.filter(c => isValidPlay(room, c));

  if (playable.length === 0) {
    // Draw a card
    const drawn = drawCards(room, 1);
    player.cards.push(...drawn);
    room.lastAction = { type: 'draw', playerName: player.name };
    advanceTurn(room);
    broadcastState(room);
    return;
  }

  // Bot strategy: pick the best card
  const card = botPickCard(playable, player, room);

  // Determine chosen color for wilds
  let chosenColor = null;
  if (card.color === 'wild') {
    chosenColor = botPickColor(player);
  }

  // Play the card
  const cIdx = player.cards.findIndex(c => c.id === card.id);
  player.cards.splice(cIdx, 1);
  room.discardPile.push(card);
  room.currentColor = card.color === 'wild' ? (chosenColor || 'red') : card.color;

  // Win check
  if (player.cards.length === 0) {
    room.winner = player.name;
    room.lastAction = { type: 'win', playerName: player.name };
    room.scores[player.name] = (room.scores[player.name] || 0) + 1;
    room.totalGames = (room.totalGames || 0) + 1;
    for (const p of room.players) {
      if (!isBot(p.id)) {
        io.to(p.id).emit('game-over', { winnerName: player.name, ...sanitize(room, p.id) });
      }
    }
    return;
  }

  // UNO check — bot calls UNO after a random delay (0.5s – 2.0s)
  if (player.cards.length === 1) {
    room.needsUnoCall = pIdx;
    player.calledUno = false;
    const unoDelay = BOT_UNO_DELAY_MIN + Math.random() * (BOT_UNO_DELAY_MAX - BOT_UNO_DELAY_MIN);
    setTimeout(() => {
      // Check if bot still has 1 card and hasn't been caught yet
      if (player.cards.length === 1 && room.needsUnoCall === pIdx && !player.calledUno) {
        player.calledUno = true;
        room.needsUnoCall = null;
        room.lastAction = { type: 'uno', playerName: player.name };
        broadcastState(room);
        for (const p of room.players) {
          if (!isBot(p.id)) {
            io.to(room.code).emit('uno-called', { playerName: player.name });
          }
        }
      }
    }, unoDelay);
  } else {
    room.needsUnoCall = null;
  }

  // Apply effects + bot reactions
  if (card.value === 'skip') {
    advanceTurn(room);
    const skipped = room.players[room.currentPlayerIndex];
    room.lastAction = { type: 'skip', playerName: player.name, skippedPlayer: skipped.name, card };
    advanceTurn(room);
    // 😂 for skipping someone
    botEmitReaction(room, player, '😂');
  } else if (card.value === 'reverse') {
    room.direction *= -1;
    room.lastAction = { type: 'reverse', playerName: player.name, card };
    if (room.players.length === 2) {
      advanceTurn(room);
      advanceTurn(room);
    } else {
      advanceTurn(room);
    }
    // 😂 for reversing
    botEmitReaction(room, player, '😂');
  } else if (card.value === 'draw2') {
    advanceTurn(room);
    const target = room.players[room.currentPlayerIndex];
    target.cards.push(...drawCards(room, 2));
    room.lastAction = { type: 'draw2', playerName: player.name, targetPlayer: target.name, card };
    advanceTurn(room);
    // 😂 for giving +2
    botEmitReaction(room, player, '😂');
    // If the target is a bot, they react with 😡
    if (isBot(target.id)) {
      botEmitReaction(room, target, '😡');
    }
  } else if (card.value === 'wild4') {
    advanceTurn(room);
    const target = room.players[room.currentPlayerIndex];
    target.cards.push(...drawCards(room, 4));
    room.lastAction = { type: 'wild4', playerName: player.name, targetPlayer: target.name, card, chosenColor: chosenColor || 'red' };
    advanceTurn(room);
    // 😂 for giving +4
    botEmitReaction(room, player, '😂');
    // If the target is a bot, they react with 😡
    if (isBot(target.id)) {
      botEmitReaction(room, target, '😡');
    }
  } else {
    room.lastAction = { type: 'play', playerName: player.name, card };
    advanceTurn(room);
  }

  broadcastState(room);
}

/** Bot card selection strategy */
function botPickCard(playable, player, room) {
  // Priority 1: Action cards that match (skip, reverse, draw2) — aggressive play
  const actions = playable.filter(c => ['skip', 'reverse', 'draw2'].includes(c.value) && c.color !== 'wild');
  if (actions.length > 0) return actions[Math.floor(Math.random() * actions.length)];

  // Priority 2: Wild Draw 4 if next player has few cards (aggressive)
  const nextIdx = (room.currentPlayerIndex + room.direction + room.players.length) % room.players.length;
  const nextPlayer = room.players[nextIdx];
  const wild4s = playable.filter(c => c.value === 'wild4');
  if (wild4s.length > 0 && nextPlayer && nextPlayer.cards.length <= 3) {
    return wild4s[0];
  }

  // Priority 3: Number cards matching current color
  const colorMatch = playable.filter(c => c.color === room.currentColor && c.color !== 'wild');
  if (colorMatch.length > 0) {
    // Prefer higher-value number cards
    const nums = colorMatch.filter(c => !['skip', 'reverse', 'draw2'].includes(c.value));
    if (nums.length > 0) {
      nums.sort((a, b) => parseInt(b.value) - parseInt(a.value));
      return nums[0];
    }
    return colorMatch[0];
  }

  // Priority 4: Number cards matching value
  const valueMatch = playable.filter(c => c.color !== 'wild');
  if (valueMatch.length > 0) return valueMatch[Math.floor(Math.random() * valueMatch.length)];

  // Priority 5: Wild cards (save for later ideally, but play if needed)
  const wilds = playable.filter(c => c.value === 'wild');
  if (wilds.length > 0) return wilds[0];

  // Priority 6: Wild+4
  return playable[0];
}

/** Pick the color the bot has the most of */
function botPickColor(player) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of player.cards) {
    if (counts[c.color] != null) counts[c.color]++;
  }
  let best = 'red';
  for (const color of COLORS) {
    if (counts[color] > counts[best]) best = color;
  }
  return best;
}

// ============================================================
//  SOCKET.IO EVENTS
// ============================================================
io.on('connection', (socket) => {
  console.log(`⚡ Connected: ${socket.id}`);

  // ── Create Room ──────────────────────────────────────────
  socket.on('create-room', ({ playerName }) => {
    const room = createRoom(socket.id, playerName);
    socket.join(room.code);
    socketRooms.set(socket.id, { roomCode: room.code, playerName });
    socket.emit('room-created', {
      roomCode: room.code,
      players: room.players.map(p => ({ name: p.name, isBot: !!p.isBot })),
      scoreboard: getScoreboard(room),
      totalGames: room.totalGames,
    });
  });

  // ── Join Room ────────────────────────────────────────────
  socket.on('join-room', ({ roomCode, playerName }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const name = (playerName || '').trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('error-msg', { message: 'Room not found!' });

    // Check if this player is rejoining an existing room (e.g. reconnect or page refresh)
    const existingPlayer = room.players.find(p => p.name === name);
    if (existingPlayer) {
      const disconnectKey = `${code}:${name}`;
      if (disconnectTimers.has(disconnectKey)) {
        clearTimeout(disconnectTimers.get(disconnectKey));
        disconnectTimers.delete(disconnectKey);
      }

      existingPlayer.id = socket.id;
      existingPlayer.connected = true;
      socket.join(code);
      socketRooms.set(socket.id, { roomCode: code, playerName: name });

      const playerList = room.players.map(p => ({ name: p.name, isBot: !!p.isBot, connected: p.connected !== false }));
      const scoreboard = getScoreboard(room);

      if (room.started) {
        socket.emit('game-started', sanitize(room, socket.id));
        socket.to(code).emit('player-reconnected', { playerName: name });
        broadcastState(room);
      } else {
        socket.emit('room-joined', { roomCode: code, players: playerList, scoreboard, totalGames: room.totalGames });
        socket.to(code).emit('player-reconnected', { playerName: name });
        broadcastState(room);
      }
      return;
    }

    if (room.started) return socket.emit('error-msg', { message: 'Game already in progress!' });
    if (room.players.length >= 6) return socket.emit('error-msg', { message: 'Room is full! (max 6)' });

    room.players.push({ id: socket.id, name, cards: [], calledUno: false, connected: true });
    if (room.scores[name] == null) room.scores[name] = 0;
    socket.join(code);
    socketRooms.set(socket.id, { roomCode: code, playerName: name });

    const playerList = room.players.map(p => ({ name: p.name, isBot: !!p.isBot }));
    const scoreboard = getScoreboard(room);
    socket.emit('room-joined', { roomCode: code, players: playerList, scoreboard, totalGames: room.totalGames });
    socket.to(code).emit('player-joined', { playerName: name, players: playerList, scoreboard, totalGames: room.totalGames });
  });

  // ── Start Game ───────────────────────────────────────────
  socket.on('start-game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (socket.id !== room.host)
      return socket.emit('error-msg', { message: 'Only the host can start!' });
    if (room.players.length < 2)
      return socket.emit('error-msg', { message: 'Need at least 2 players!' });

    startGame(room);
    for (const p of room.players) {
      if (!isBot(p.id)) {
        io.to(p.id).emit('game-started', sanitize(room, p.id));
      }
    }
    // Kick off bot turn if bot goes first
    scheduleBotTurn(room);
  });

  // ── Play Card ────────────────────────────────────────────
  socket.on('play-card', ({ roomCode, cardId, chosenColor }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.started) return;

    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1 || pIdx !== room.currentPlayerIndex)
      return socket.emit('error-msg', { message: "It's not your turn!" });

    const player = room.players[pIdx];
    const cIdx = player.cards.findIndex(c => c.id === cardId);
    if (cIdx === -1) return socket.emit('error-msg', { message: "Card not in hand!" });

    const card = player.cards[cIdx];
    if (!isValidPlay(room, card))
      return socket.emit('error-msg', { message: 'Invalid move!' });

    // Play the card
    player.cards.splice(cIdx, 1);
    room.discardPile.push(card);
    room.currentColor = card.color === 'wild' ? (chosenColor || 'red') : card.color;

    // Win check
    if (player.cards.length === 0) {
      room.winner = player.name;
      room.lastAction = { type: 'win', playerName: player.name };
      room.scores[player.name] = (room.scores[player.name] || 0) + 1;
      room.totalGames = (room.totalGames || 0) + 1;
      for (const p of room.players) {
        if (!isBot(p.id)) {
          io.to(p.id).emit('game-over', { winnerName: player.name, ...sanitize(room, p.id) });
        }
      }
      return;
    }

    // UNO check (1 card remaining)
    if (player.cards.length === 1) {
      room.needsUnoCall = pIdx;
      player.calledUno = false;
    } else {
      room.needsUnoCall = null;
    }

    // Apply effects
    if (card.value === 'skip') {
      advanceTurn(room);
      const skipped = room.players[room.currentPlayerIndex];
      room.lastAction = { type: 'skip', playerName: player.name, skippedPlayer: skipped.name, card };
      advanceTurn(room);
    } else if (card.value === 'reverse') {
      room.direction *= -1;
      room.lastAction = { type: 'reverse', playerName: player.name, card };
      if (room.players.length === 2) {
        advanceTurn(room);   // acts as skip in 2‑player
        advanceTurn(room);
      } else {
        advanceTurn(room);
      }
    } else if (card.value === 'draw2') {
      advanceTurn(room);
      const target = room.players[room.currentPlayerIndex];
      target.cards.push(...drawCards(room, 2));
      room.lastAction = { type: 'draw2', playerName: player.name, targetPlayer: target.name, card };
      advanceTurn(room);
      // Bot reacts with 😡 when receiving +2
      if (isBot(target.id)) botEmitReaction(room, target, '😡');
    } else if (card.value === 'wild4') {
      advanceTurn(room);
      const target = room.players[room.currentPlayerIndex];
      target.cards.push(...drawCards(room, 4));
      room.lastAction = { type: 'wild4', playerName: player.name, targetPlayer: target.name, card, chosenColor: chosenColor || 'red' };
      advanceTurn(room);
      // Bot reacts with 😡 when receiving +4
      if (isBot(target.id)) botEmitReaction(room, target, '😡');
    } else {
      room.lastAction = { type: 'play', playerName: player.name, card };
      advanceTurn(room);
    }

    broadcastState(room);
  });

  // ── Draw Card ────────────────────────────────────────────
  socket.on('draw-card', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.started) return;

    const pIdx = playerIndex(room, socket.id);
    if (pIdx !== room.currentPlayerIndex)
      return socket.emit('error-msg', { message: "It's not your turn!" });

    const player = room.players[pIdx];
    const drawn = drawCards(room, 1);
    player.cards.push(...drawn);
    room.lastAction = { type: 'draw', playerName: player.name };
    advanceTurn(room);
    broadcastState(room);
  });

  // ── Call UNO ─────────────────────────────────────────────
  socket.on('call-uno', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.started) return;
    const pIdx = playerIndex(room, socket.id);
    if (pIdx === -1) return;

    const player = room.players[pIdx];
    if (player.cards.length === 1) {
      player.calledUno = true;
      room.needsUnoCall = null;
      room.lastAction = { type: 'uno', playerName: player.name };
      broadcastState(room);
      io.to(roomCode).emit('uno-called', { playerName: player.name });
    }
  });

  // ── Catch UNO ────────────────────────────────────────────
  socket.on('catch-uno', ({ roomCode, targetIndex }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.started) return;

    const target = room.players[targetIndex];
    if (!target) return;
    if (target.cards.length === 1 && !target.calledUno && room.needsUnoCall === targetIndex) {
      target.cards.push(...drawCards(room, 2));
      room.needsUnoCall = null;
      const catcherIdx = playerIndex(room, socket.id);
      const catcher = room.players[catcherIdx];
      room.lastAction = { type: 'caught', playerName: target.name, caughtBy: catcher.name };
      broadcastState(room);
      io.to(roomCode).emit('uno-caught', { playerName: target.name, caughtBy: catcher.name });
      // Bot reacts with 😡 when caught
      if (isBot(target.id)) botEmitReaction(room, target, '😡');
    }
  });

  // ── Restart ──────────────────────────────────────────────
  socket.on('restart-game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.host) return;
    startGame(room);
    for (const p of room.players) {
      if (!isBot(p.id)) {
        io.to(p.id).emit('game-started', sanitize(room, p.id));
      }
    }
    scheduleBotTurn(room);
  });

  // ── Toggle Card Suggestions ─────────────────────────────
  socket.on('toggle-suggestions', ({ roomCode, enabled }) => {
    const room = rooms.get(roomCode);
    if (!room || socket.id !== room.host) return;
    room.cardSuggestions = !!enabled;
    broadcastState(room);
  });

  // ── Emoji Reaction ───────────────────────────────────────
  socket.on('reaction', ({ roomCode, emoji }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (!REACTION_EMOJIS.includes(emoji)) return;
    if (playerIndex(room, socket.id) === -1) return;

    const now = Date.now();
    const last = reactionCooldowns.get(socket.id) || 0;
    if (now - last < REACTION_COOLDOWN_MS) return;
    reactionCooldowns.set(socket.id, now);

    const player = room.players[playerIndex(room, socket.id)];
    io.to(roomCode).volatile.emit('reaction', { emoji, playerName: player.name });
  });

  // ── Add Bot (host only) ─────────────────────────────────
  socket.on('add-bot', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (socket.id !== room.host)
      return socket.emit('error-msg', { message: 'Only the host can add bots!' });
    if (room.started)
      return socket.emit('error-msg', { message: 'Cannot add bots during a game!' });
    if (room.players.length >= 6)
      return socket.emit('error-msg', { message: 'Room is full! (max 6)' });

    // Pick a bot name not already in use
    const usedNames = new Set(room.players.map(p => p.name));
    const botName = BOT_NAMES.find(n => !usedNames.has(n));
    if (!botName)
      return socket.emit('error-msg', { message: 'Max bots reached!' });

    const botId = generateBotId();
    room.players.push({ id: botId, name: botName, cards: [], calledUno: false, isBot: true });
    if (room.scores[botName] == null) room.scores[botName] = 0;

    const playerList = room.players.map(p => ({ name: p.name, isBot: !!p.isBot }));
    const scoreboard = getScoreboard(room);
    // Notify all real players in the room
    for (const p of room.players) {
      if (!isBot(p.id)) {
        io.to(p.id).emit('bot-added', { botName, players: playerList, scoreboard, totalGames: room.totalGames });
      }
    }
  });

  // ── Remove Bot (host only) ──────────────────────────────
  socket.on('remove-bot', ({ roomCode, botName }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (socket.id !== room.host)
      return socket.emit('error-msg', { message: 'Only the host can remove bots!' });
    if (room.started)
      return socket.emit('error-msg', { message: 'Cannot remove bots during a game!' });

    const botIdx = room.players.findIndex(p => p.name === botName && p.isBot);
    if (botIdx === -1) return;

    room.players.splice(botIdx, 1);
    const playerList = room.players.map(p => ({ name: p.name, isBot: !!p.isBot }));
    const scoreboard = getScoreboard(room);
    for (const p of room.players) {
      if (!isBot(p.id)) {
        io.to(p.id).emit('bot-removed', { botName, players: playerList, scoreboard, totalGames: room.totalGames });
      }
    }
  });

  // ── Kill switch (manager / emergency bail-out) ─────────
  // Blast every connected client so the whole room/office bails.
  socket.on('kill-switch', (ack) => {
    console.log(`🚨 Kill switch by ${socket.id}`);
    io.emit('kill-switch');
    if (typeof ack === 'function') ack();
  });

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`💤 Disconnected: ${socket.id} (${reason})`);
    reactionCooldowns.delete(socket.id);
    const info = socketRooms.get(socket.id);
    if (!info) return;

    const { roomCode, playerName } = info;
    socketRooms.delete(socket.id);

    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.find(p => p.name === playerName);
    if (!player) return;

    player.connected = false;

    // 25-second grace period for reconnection so transient drops/refreshes don't terminate games
    const disconnectKey = `${roomCode}:${playerName}`;
    if (disconnectTimers.has(disconnectKey)) {
      clearTimeout(disconnectTimers.get(disconnectKey));
    }

    io.to(roomCode).emit('player-disconnected-temp', { playerName });

    const timer = setTimeout(() => {
      disconnectTimers.delete(disconnectKey);
      if (!rooms.has(roomCode)) return;

      const pIdx = room.players.findIndex(p => p.name === playerName && p.connected === false);
      if (pIdx === -1) return; // Player reconnected in the meantime!

      room.players.splice(pIdx, 1);

      if (room.players.length === 0) {
        cleanupBotTimers(roomCode);
        rooms.delete(roomCode);
        return;
      }

      // If only bots remain, clean up the room
      const hasHumans = room.players.some(p => !isBot(p.id));
      if (!hasHumans) {
        cleanupBotTimers(roomCode);
        rooms.delete(roomCode);
        return;
      }

      // Transfer host to a real player (not a bot)
      if (player.id === room.host) {
        const newHost = room.players.find(p => !isBot(p.id) && p.connected !== false) || room.players.find(p => !isBot(p.id));
        room.host = newHost ? newHost.id : room.players[0].id;
      }

      if (room.started) {
        if (room.currentPlayerIndex >= room.players.length) room.currentPlayerIndex = 0;
        if (room.players.filter(p => !isBot(p.id)).length < 1) {
          // No human players left
          room.started = false;
          cleanupBotTimers(roomCode);
          rooms.delete(roomCode);
          return;
        }
        if (room.players.length < 2) {
          room.started = false;
          room.winner = room.players[0]?.name || null;
          io.to(roomCode).emit('player-left-ended', {
            playerName,
            message: `${playerName} disconnected and timed out. Not enough players.`,
          });
          return;
        }
        broadcastState(room);
      }

      io.to(roomCode).emit('player-left', {
        playerName,
        players: room.players.map(p => ({ name: p.name, isBot: !!p.isBot })),
      });
    }, 25000);

    disconnectTimers.set(disconnectKey, timer);
  });
});

// ============================================================
//  LOCAL IP DETECTION & START
// ============================================================
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('🎴  UNO Game Server is running!');
  console.log('');
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Network:  http://${ip}:${PORT}`);
  console.log('');
  console.log('   Share the Network URL with players on your WiFi!');
  console.log('');
});
