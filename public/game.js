/* ================================================================
   UNO — CLIENT-SIDE GAME LOGIC
   ================================================================ */
const socket = io();

/* ── State ─────────────────────────────────────────────────────── */
const state = {
  roomCode: null,
  playerName: null,
  isHost: false,
  game: null,            // latest sanitised game state from server
  pendingWildId: null,   // card id waiting for color pick
  scoreboard: [],
  totalGames: 0,
};

/* ── DOM refs ──────────────────────────────────────────────────── */
const screens = {
  join:     document.getElementById('screen-join'),
  lobby:    document.getElementById('screen-lobby'),
  game:     document.getElementById('screen-game'),
  gameover: document.getElementById('screen-gameover'),
};

const $ = (id) => document.getElementById(id);

/* Random position helper — keeps element within visible screen bounds */
function randomizePosition(element, widthPx = 82, heightPx = 82) {
  const pad = 20;
  const maxX = window.innerWidth  - widthPx  - pad;
  const maxY = window.innerHeight - heightPx - pad;
  const x = pad + Math.random() * (maxX - pad);
  const y = pad + Math.random() * (maxY - pad * 4);  // avoid very bottom (hand area)
  element.style.left   = `${x}px`;
  element.style.top    = `${y}px`;
  element.style.right  = 'auto';
  element.style.bottom = 'auto';
}

const el = {
  playerName:   $('player-name'),
  roomCodeInput:$('room-code-input'),
  btnCreate:    $('btn-create'),
  btnJoin:      $('btn-join'),

  lobbyCode:    $('lobby-code'),
  playerList:   $('player-list'),
  lobbyActions: $('lobby-actions'),
  btnAddBot:    $('btn-add-bot'),
  btnStart:     $('btn-start'),
  lobbyStatus:  $('lobby-status'),

  opponents:    $('opponents'),
  drawPile:     $('draw-pile'),
  discardPile:  $('discard-pile'),
  currentColor: $('current-color'),
  gameMessage:  $('game-message'),
  dirIndicator: $('direction-indicator'),
  myHand:       $('my-hand'),
  turnIndicator:$('turn-indicator'),
  btnUno:       $('btn-uno'),
  catchArea:    $('catch-area'),
  colorPicker:  $('color-picker'),
  gameBoard:    $('game-board'),

  btnSettings:      $('btn-settings'),
  settingsPanel:    $('settings-panel'),
  toggleSuggestions: $('toggle-suggestions'),
  btnCloseSettings: $('btn-close-settings'),

  winnerName:   $('winner-name'),
  btnPlayAgain: $('btn-play-again'),
  btnBackLobby: $('btn-back-lobby'),
  confetti:     $('confetti'),
  toasts:       $('toast-container'),

  reactionLayer:       $('reaction-layer'),
  reactionBar:         $('reaction-bar'),

  lobbyScoreboard:     $('lobby-scoreboard'),
  lobbyScoreboardList: $('lobby-scoreboard-list'),
  gameScoreboard:      $('game-scoreboard'),
  gameScoreboardList:  $('game-scoreboard-list'),
  gameoverScoreboard:  $('gameover-scoreboard-list'),
  totalGamesLabel:     $('games-played-label'),
};

/* ── Helpers ───────────────────────────────────────────────────── */
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

const AVATAR_COLORS = ['#EF4444','#3B82F6','#22C55E','#FACC15','#8B5CF6','#EC4899'];
function avatarColor(i) { return AVATAR_COLORS[i % AVATAR_COLORS.length]; }

function toast(msg, ms = 3000) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  el.toasts.appendChild(t);
  setTimeout(() => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 300); }, ms);
}

/* ── Card display helpers ──────────────────────────────────────── */
function displayVal(card) {
  switch (card.value) {
    case 'skip':    return '⊘';
    case 'reverse': return '⟲';
    case 'draw2':   return '+2';
    case 'wild':    return '★';
    case 'wild4':   return '+4';
    default:        return card.value;
  }
}

function colorClass(card) {
  return card.color === 'wild' ? 'card-wild' : `card-${card.color}`;
}

function makeCard(card, extra = '') {
  const v = displayVal(card);
  const div = document.createElement('div');
  div.className = `card ${colorClass(card)} ${extra}`.trim();
  div.dataset.cardId = card.id;
  div.innerHTML =
    `<span class="card-corner card-corner-tl">${v}</span>` +
    `<span class="card-value">${v}</span>` +
    `<span class="card-corner card-corner-br">${v}</span>`;
  return div;
}

function canPlay(card, gs) {
  if (!gs.isMyTurn) return false;
  if (card.color === 'wild') return true;
  if (card.color === gs.currentColor) return true;
  if (gs.topCard && card.value === gs.topCard.value) return true;
  return false;
}

/* ================================================================
   SCOREBOARD
   ================================================================ */
function setScoreboard(scoreboard, totalGames) {
  if (scoreboard) state.scoreboard = scoreboard;
  if (totalGames != null) state.totalGames = totalGames;
}

function scoreRankRows(scoreboard, { compact = false, highlightWinner = null } = {}) {
  if (!scoreboard || !scoreboard.length) return '';
  return scoreboard.map((entry, rank) => {
    const medal = rank === 0 && entry.wins > 0 ? '🥇'
      : rank === 1 && entry.wins > 0 ? '🥈'
      : rank === 2 && entry.wins > 0 ? '🥉'
      : `${rank + 1}.`;
    const winLabel = entry.wins === 1 ? 'win' : 'wins';
    const isWinner = highlightWinner && entry.name === highlightWinner;
    const me = entry.name === state.playerName;
    return (
      `<div class="scoreboard-row${isWinner ? ' is-winner' : ''}${me ? ' is-me' : ''}${entry.present === false ? ' is-absent' : ''}">` +
        `<span class="score-rank">${compact ? rank + 1 : medal}</span>` +
        `<span class="score-name">${entry.name}${me ? ' (you)' : ''}</span>` +
        `<span class="score-wins">${entry.wins}${compact ? '' : ' ' + winLabel}</span>` +
      `</div>`
    );
  }).join('');
}

function renderLobbyScoreboard() {
  const hasWins = state.scoreboard.some(e => e.wins > 0);
  if (!hasWins) {
    el.lobbyScoreboard.style.display = 'none';
    return;
  }
  el.lobbyScoreboard.style.display = 'block';
  el.lobbyScoreboardList.innerHTML = scoreRankRows(state.scoreboard);
}

function renderGameScoreboard(gs) {
  const board = gs.scoreboard || state.scoreboard;
  const hasWins = board && board.some(e => e.wins > 0);
  if (!hasWins) {
    el.gameScoreboard.style.display = 'none';
    return;
  }
  // only current players, ordered by wins
  const present = board.filter(e => e.present !== false);
  el.gameScoreboard.style.display = 'flex';
  el.gameScoreboardList.innerHTML = scoreRankRows(present, { compact: true });
}

function renderGameoverScoreboard(gs, winnerName) {
  const board = gs.scoreboard || state.scoreboard;
  if (el.gameoverScoreboard) {
    el.gameoverScoreboard.innerHTML = scoreRankRows(board, { highlightWinner: winnerName });
  }
  if (el.totalGamesLabel) {
    const n = gs.totalGames != null ? gs.totalGames : state.totalGames;
    el.totalGamesLabel.textContent = n > 0 ? `· ${n} game${n === 1 ? '' : 's'}` : '';
  }
}

/* ================================================================
   LOBBY RENDERING
   ================================================================ */
function renderLobby(players) {
  el.playerList.innerHTML = '';
  players.forEach((p, i) => {
    const wins = (state.scoreboard.find(e => e.name === p.name) || {}).wins || 0;
    const item = document.createElement('div');
    item.className = 'player-item';
    const isBotPlayer = p.isBot || p.name.startsWith('Bot ');
    item.innerHTML =
      `<div class="player-avatar" style="background:${avatarColor(i)}">${isBotPlayer ? '🤖' : p.name[0].toUpperCase()}</div>` +
      `<span class="player-name-text">${p.name}</span>` +
      (wins > 0 ? `<span class="win-badge">${wins}W</span>` : '') +
      (isBotPlayer ? '<span class="bot-badge">BOT</span>' : '') +
      (i === 0 ? '<span class="host-badge">HOST</span>' : '') +
      (isBotPlayer && state.isHost ? `<button class="btn-remove-bot" data-bot-name="${p.name}" title="Remove bot">✕</button>` : '');
    el.playerList.appendChild(item);
  });

  // Bind remove-bot buttons
  el.playerList.querySelectorAll('.btn-remove-bot').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('remove-bot', { roomCode: state.roomCode, botName: btn.dataset.botName });
    });
  });

  renderLobbyScoreboard();
}

/* ================================================================
   GAME RENDERING
   ================================================================ */
function render(gs) {
  state.game = gs;
  if (gs.scoreboard) setScoreboard(gs.scoreboard, gs.totalGames);
  renderOpponents(gs);
  renderDiscard(gs);
  renderColorDot(gs);
  renderHand(gs);
  renderDrawPile(gs);
  renderDirection(gs);
  renderTurnBanner(gs);
  renderUnoBtn(gs);
  renderCatchBtns(gs);
  renderMessage(gs);
  renderSettings(gs);
  renderTurnBg(gs);
  renderGameScoreboard(gs);
}

/* ── Opponents ─────────────────────────────────────────────────── */
function renderOpponents(gs) {
  el.opponents.innerHTML = '';
  gs.players.forEach((p, i) => {
    if (i === gs.myIndex) return;
    const div = document.createElement('div');
    div.className = `opponent-card${p.isCurrentPlayer ? ' active' : ''}`;
    const minis = Array(Math.min(p.cardCount, 12))
      .fill('<div class="mini-card"></div>').join('');
    div.innerHTML =
      `<div class="player-avatar" style="background:${avatarColor(i)};width:32px;height:32px;font-size:.75rem;">${p.name[0].toUpperCase()}</div>` +
      `<div class="opponent-info">` +
        `<div class="opponent-name">${p.name}</div>` +
        `<div class="mini-cards">${minis}</div>` +
      `</div>` +
      `<div class="card-count">${p.cardCount}</div>` +
      (p.calledUno && p.cardCount === 1 ? '<span class="opponent-uno-badge">UNO!</span>' : '');
    el.opponents.appendChild(div);
  });
}

/* ── Discard pile ──────────────────────────────────────────────── */
function renderDiscard(gs) {
  el.discardPile.innerHTML = '';
  if (!gs.topCard) return;
  const c = makeCard(gs.topCard);
  c.style.cursor = 'default';
  el.discardPile.appendChild(c);
  const lbl = document.createElement('span');
  lbl.className = 'pile-label';
  lbl.textContent = 'DISCARD';
  el.discardPile.appendChild(lbl);
}

/* ── Current colour dot ────────────────────────────────────────── */
const COLOR_MAP = {
  red:    'var(--uno-red)',
  blue:   'var(--uno-blue)',
  green:  'var(--uno-green)',
  yellow: 'var(--uno-yellow)',
};
function renderColorDot(gs) {
  const c = COLOR_MAP[gs.currentColor] || '#555';
  el.currentColor.style.background = c;
  el.currentColor.style.boxShadow = `0 0 18px ${c}`;
}

/* ── Player hand ───────────────────────────────────────────────── */
function renderHand(gs) {
  el.myHand.innerHTML = '';

  // Sort cards: by color then value
  const order = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  const sorted = [...gs.myCards].sort((a, b) => {
    if (order[a.color] !== order[b.color]) return order[a.color] - order[b.color];
    return a.value.localeCompare(b.value);
  });

  const showHints = gs.cardSuggestions;

  sorted.forEach(card => {
    const playable = canPlay(card, gs);
    let extraClass = '';
    if (showHints) {
      extraClass = playable ? 'playable' : 'not-playable';
    } else if (gs.isMyTurn) {
      extraClass = 'playable';  // all cards look the same, but clickable on your turn
    }
    const c = makeCard(card, extraClass);
    if (gs.isMyTurn) {
      c.addEventListener('click', () => onPlayCard(card));
    }
    el.myHand.appendChild(c);
  });
}

/* ── Draw pile ─────────────────────────────────────────────────── */
function renderDrawPile(gs) {
  el.drawPile.classList.toggle('can-draw', gs.isMyTurn);
  // Update label count
  const label = el.drawPile.querySelector('.pile-label');
  if (label) label.textContent = `DRAW · ${gs.drawPileCount}`;

  // Re-bind click
  const back = el.drawPile.querySelector('.card-back');
  const newBack = back.cloneNode(true);        // remove old listeners
  back.parentNode.replaceChild(newBack, back);
  if (gs.isMyTurn) {
    newBack.addEventListener('click', onDrawCard);
  }
}

/* ── Direction ─────────────────────────────────────────────────── */
function renderDirection(gs) {
  el.dirIndicator.textContent = gs.direction === 1 ? '↻' : '↺';
  el.dirIndicator.classList.toggle('reversed', gs.direction === -1);
}

/* ── Turn banner ───────────────────────────────────────────────── */
function renderTurnBanner(gs) {
  if (gs.isMyTurn) {
    el.turnIndicator.textContent = '🎯  Your Turn';
    el.turnIndicator.className = 'turn-indicator my-turn';
  } else {
    const cur = gs.players[gs.currentPlayerIndex];
    el.turnIndicator.textContent = `⏳  ${cur.name}'s Turn`;
    el.turnIndicator.className = 'turn-indicator their-turn';
  }
}

/* ── UNO button ────────────────────────────────────────────────── */
function renderUnoBtn(gs) {
  const me = gs.players[gs.myIndex];
  const shouldShow = me.cardCount === 1 && !me.calledUno && gs.needsUnoCall === gs.myIndex;
  if (shouldShow && el.btnUno.style.display === 'none') {
    randomizePosition(el.btnUno, 82, 82);
  }
  el.btnUno.style.display = shouldShow ? 'block' : 'none';
}

/* ── Catch buttons ─────────────────────────────────────────────── */
function renderCatchBtns(gs) {
  el.catchArea.innerHTML = '';
  if (gs.needsUnoCall === null || gs.needsUnoCall === gs.myIndex) return;
  const target = gs.players[gs.needsUnoCall];
  if (target.calledUno || target.cardCount !== 1) return;

  const btn = document.createElement('button');
  btn.className = 'btn-catch';
  btn.textContent = `Catch ${target.name}! 🚨`;
  btn.addEventListener('click', () => {
    socket.emit('catch-uno', { roomCode: state.roomCode, targetIndex: gs.needsUnoCall });
  });
  el.catchArea.appendChild(btn);
  randomizePosition(el.catchArea, 160, 50);
}

/* ── Game message ──────────────────────────────────────────────── */
function renderMessage(gs) {
  const a = gs.lastAction;
  if (!a) { el.gameMessage.textContent = ''; return; }

  const msgs = {
    play:    () => `${a.playerName} played a card`,
    skip:    () => `${a.playerName} skipped ${a.skippedPlayer}! ⊘`,
    reverse: () => `${a.playerName} reversed direction! ⟲`,
    draw2:   () => `${a.targetPlayer} draws +2! 😬`,
    wild4:   () => `${a.targetPlayer} draws +4! Color → ${capitalize(a.chosenColor)} 🌈`,
    draw:    () => `${a.playerName} drew a card`,
    uno:     () => `${a.playerName} called UNO! 🎴`,
    caught:  () => `${a.caughtBy} caught ${a.playerName}! +2 penalty 😈`,
  };

  el.gameMessage.textContent = (msgs[a.type] || (() => ''))();
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

/* ── Settings panel (host only) ────────────────────────────────── */
function renderSettings(gs) {
  // Show gear icon only for host
  el.btnSettings.style.display = gs.isHost ? 'flex' : 'none';
  // Sync toggle state with server
  el.toggleSuggestions.checked = gs.cardSuggestions;
}

/* ── Turn background colour ────────────────────────────────────── */
function renderTurnBg(gs) {
  if (gs.isMyTurn) {
    el.gameBoard.classList.add('my-turn-bg');
    el.gameBoard.classList.remove('their-turn-bg');
  } else {
    el.gameBoard.classList.remove('my-turn-bg');
    el.gameBoard.classList.add('their-turn-bg');
  }
}

/* ── Settings event listeners ──────────────────────────────────── */
el.btnSettings.addEventListener('click', () => {
  const panel = el.settingsPanel;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
});
el.btnCloseSettings.addEventListener('click', () => {
  el.settingsPanel.style.display = 'none';
});
el.toggleSuggestions.addEventListener('change', () => {
  socket.emit('toggle-suggestions', {
    roomCode: state.roomCode,
    enabled: el.toggleSuggestions.checked,
  });
});

/* ================================================================
   GAME ACTIONS
   ================================================================ */
function onPlayCard(card) {
  if (card.color === 'wild' || card.value === 'wild' || card.value === 'wild4') {
    state.pendingWildId = card.id;
    el.colorPicker.style.display = 'flex';
    return;
  }
  socket.emit('play-card', { roomCode: state.roomCode, cardId: card.id });
}

function onDrawCard() {
  if (!state.game?.isMyTurn) return;
  socket.emit('draw-card', { roomCode: state.roomCode });
}

/* ── Color picker ──────────────────────────────────────────────── */
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const color = btn.dataset.color;
    el.colorPicker.style.display = 'none';
    socket.emit('play-card', {
      roomCode: state.roomCode,
      cardId: state.pendingWildId,
      chosenColor: color,
    });
    state.pendingWildId = null;
  });
});

/* ── Confetti on win ───────────────────────────────────────────── */
function spawnConfetti() {
  const container = el.confetti;
  container.innerHTML = '';
  const colors = ['#EF4444','#3B82F6','#22C55E','#FACC15','#8B5CF6','#EC4899','#F97316'];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = `${Math.random() * 2}s`;
    piece.style.animationDuration = `${2 + Math.random() * 2}s`;
    piece.style.width = `${6 + Math.random() * 6}px`;
    piece.style.height = `${6 + Math.random() * 6}px`;
    container.appendChild(piece);
  }
}

/* ================================================================
   EMOJI REACTIONS
   ================================================================ */
const REACTION_EMOJIS = ['😂', '😡', '😢', '🤬'];
const REACTION_COOLDOWN_MS = 900;
let lastReactionAt = 0;

/** Rain a burst of one emoji upward from the bottom, behind the cards. */
function spawnReaction(emoji, count = 14) {
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('span');
    piece.className = 'reaction-float';
    piece.textContent = emoji;
    piece.style.left = `${Math.random() * 92}%`;
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
    piece.style.setProperty('--spin', `${(Math.random() - 0.5) * 90}deg`);
    piece.style.fontSize = `${1.4 + Math.random() * 1.4}rem`;
    const duration = 2.6 + Math.random() * 1.8;
    piece.style.animationDuration = `${duration}s`;
    piece.style.animationDelay = `${Math.random() * 0.7}s`;
    piece.addEventListener('animationend', () => piece.remove());
    el.reactionLayer.appendChild(piece);
  }
}

function sendReaction(emoji) {
  if (!REACTION_EMOJIS.includes(emoji)) return;
  const now = Date.now();
  if (now - lastReactionAt < REACTION_COOLDOWN_MS) return;
  lastReactionAt = now;
  socket.emit('reaction', { roomCode: state.roomCode, emoji });
}

el.reactionBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.reaction-btn');
  if (!btn) return;
  sendReaction(btn.dataset.emoji);
});

/* ================================================================
   BUTTON HANDLERS
   ================================================================ */
el.btnCreate.addEventListener('click', () => {
  const name = el.playerName.value.trim();
  if (!name) return toast('Enter your name first!');
  state.playerName = name;
  state.isHost = true;
  socket.emit('create-room', { playerName: name });
});

el.btnJoin.addEventListener('click', () => {
  const name = el.playerName.value.trim();
  const code = el.roomCodeInput.value.trim();
  if (!name) return toast('Enter your name first!');
  if (!code) return toast('Enter a room code!');
  state.playerName = name;
  socket.emit('join-room', { roomCode: code, playerName: name });
});

el.btnStart.addEventListener('click', () => {
  socket.emit('start-game', { roomCode: state.roomCode });
});

el.btnAddBot.addEventListener('click', () => {
  socket.emit('add-bot', { roomCode: state.roomCode });
});

el.btnUno.addEventListener('click', () => {
  socket.emit('call-uno', { roomCode: state.roomCode });
});

el.btnPlayAgain.addEventListener('click', () => {
  socket.emit('restart-game', { roomCode: state.roomCode });
});

el.btnBackLobby.addEventListener('click', () => location.reload());

// Enter-key shortcuts
el.playerName.addEventListener('keypress', e => { if (e.key === 'Enter') el.btnCreate.click(); });
el.roomCodeInput.addEventListener('keypress', e => { if (e.key === 'Enter') el.btnJoin.click(); });

/* ── Kill switch (press "k") ─────────────────────────────────── */
let killArmed = false;

function fleeHome() {
  // Hard blank — looks like a fresh / home tab
  window.location.replace('about:blank');
}

function activateKillSwitch() {
  if (killArmed) return;
  killArmed = true;

  // Wait for server ack so the message actually reaches other players
  // before this tab tears down the WebSocket (race that broke multiplayer kill).
  socket.timeout(800).emit('kill-switch', () => {
    fleeHome();
  });

  // Fallback if ack never arrives (disconnect, lag, old client)
  setTimeout(fleeHome, 500);
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'k' && e.key !== 'K') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  e.preventDefault();
  e.stopPropagation();
  activateKillSwitch();
}, true);

/* ================================================================
   SOCKET EVENTS
   ================================================================ */

// ── Room created (host) ────────────────────────────────────────
socket.on('room-created', ({ roomCode, players, scoreboard, totalGames }) => {
  state.roomCode = roomCode;
  setScoreboard(scoreboard || [], totalGames || 0);
  el.lobbyCode.textContent = roomCode;
  renderLobby(players);
  el.lobbyActions.style.display = 'flex';
  el.lobbyStatus.style.display = 'none';
  showScreen('lobby');
});

// ── Room joined (joining player) ───────────────────────────────
socket.on('room-joined', ({ roomCode, players, scoreboard, totalGames }) => {
  state.roomCode = roomCode;
  setScoreboard(scoreboard || [], totalGames || 0);
  el.lobbyCode.textContent = roomCode;
  renderLobby(players);
  el.lobbyActions.style.display = 'none';
  el.lobbyStatus.style.display = 'block';
  showScreen('lobby');
});

// ── Someone joined ─────────────────────────────────────────────
socket.on('player-joined', ({ playerName, players, scoreboard, totalGames }) => {
  if (scoreboard) setScoreboard(scoreboard, totalGames);
  renderLobby(players);
  toast(`${playerName} joined! 🎉`);
});

// ── Bot added ──────────────────────────────────────────────────
socket.on('bot-added', ({ botName, players, scoreboard, totalGames }) => {
  if (scoreboard) setScoreboard(scoreboard, totalGames);
  renderLobby(players);
  toast(`${botName} added! 🤖`);
});

// ── Bot removed ────────────────────────────────────────────────
socket.on('bot-removed', ({ botName, players, scoreboard, totalGames }) => {
  if (scoreboard) setScoreboard(scoreboard, totalGames);
  renderLobby(players);
  toast(`${botName} removed 👋`);
});

// ── Someone left ───────────────────────────────────────────────
socket.on('player-left', ({ playerName, players }) => {
  renderLobby(players);
  toast(`${playerName} left 👋`);
  // Also re-render game if in progress
  if (state.game) render(state.game);
});

// ── Game started ───────────────────────────────────────────────
socket.on('game-started', (gs) => {
  if (gs.scoreboard) setScoreboard(gs.scoreboard, gs.totalGames);
  showScreen('game');
  render(gs);
  toast('Game started! 🎴', 2500);
});

// ── Game update ────────────────────────────────────────────────
socket.on('game-update', (gs) => render(gs));

// ── Game over ──────────────────────────────────────────────────
socket.on('game-over', ({ winnerName, ...gs }) => {
  if (gs.scoreboard) setScoreboard(gs.scoreboard, gs.totalGames);
  el.winnerName.textContent = winnerName;
  el.btnPlayAgain.style.display = gs.isHost ? 'block' : 'none';
  // Never let a rendering hiccup trap players on the game board
  try { renderGameoverScoreboard(gs, winnerName); } catch (err) { console.error(err); }
  showScreen('gameover');
  spawnConfetti();
});

// ── Reaction from any player (including yourself) ──────────────
socket.on('reaction', ({ emoji }) => spawnReaction(emoji));

// ── UNO called ─────────────────────────────────────────────────
socket.on('uno-called', ({ playerName }) => toast(`${playerName} called UNO! 🎴`));

// ── UNO caught ─────────────────────────────────────────────────
socket.on('uno-caught', ({ playerName, caughtBy }) =>
  toast(`${caughtBy} caught ${playerName}! +2 penalty 😈`));

// ── Player left mid-game ───────────────────────────────────────
socket.on('player-left-ended', ({ message }) => {
  toast(message, 5000);
  setTimeout(() => location.reload(), 4000);
});

// ── Kill switch (from any player, including self via io.emit) ──
socket.on('kill-switch', () => {
  if (killArmed) return; // initiator is already fleeing via ack
  killArmed = true;
  fleeHome();
});

// ── Errors ─────────────────────────────────────────────────────
socket.on('error-msg', ({ message }) => toast(message));

socket.on('disconnect', () => toast('Disconnected from server! 🔌', 5000));
