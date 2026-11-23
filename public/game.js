/* ================================================================
   UNO — CLIENT-SIDE GAME LOGIC & SOUND ENGINE
   ================================================================ */
const socket = io({
  transports: ['websocket'],   // Skip polling → direct WebSocket for lower latency
  upgrade: false,              // Don't fall back to polling
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionAttempts: 10,
});

/* ── State ─────────────────────────────────────────────────────── */
const state = {
  roomCode: null,
  playerName: null,
  isHost: false,
  game: null,            // latest sanitised game state from server
  pendingWildId: null,   // card id waiting for color pick
  scoreboard: [],
  totalGames: 0,
  soundEnabled: localStorage.getItem('uno_sound') !== 'false',
  wasMyTurn: false,
  actionStack: [],       // stacked action messages above turn box (max 2-3)
  pomodoro: {
    active: false,
    mode: 'focus',       // 'focus' | 'break'
    durationMinutes: 25,
    rewardGamesTotal: 1,
    rewardGamesPlayed: 0,
    remainingSeconds: 25 * 60,
    totalSeconds: 25 * 60,
    isRunning: false,
    taskName: '',
    timerHandle: null,
    targetEndTime: null,
  },
};

/* ── DOM refs ──────────────────────────────────────────────────── */
const screens = {
  join: document.getElementById('screen-join'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
  gameover: document.getElementById('screen-gameover'),
};

const $ = (id) => document.getElementById(id);

const el = {
  playerName: $('player-name'),
  roomCodeInput: $('room-code-input'),
  btnCreate: $('btn-create'),
  btnJoin: $('btn-join'),

  lobbyCode: $('lobby-code'),
  btnCopyCode: $('btn-copy-code'),
  copyText: $('copy-text'),
  copyIcon: $('copy-icon'),
  lobbyPlayerCount: $('lobby-player-count'),
  playerList: $('player-list'),
  lobbyActions: $('lobby-actions'),
  btnAddBot: $('btn-add-bot'),
  btnStart: $('btn-start'),
  lobbyStatus: $('lobby-status'),

  hudRoomCode: $('hud-room-code'),
  opponents: $('opponents'),
  drawPile: $('draw-pile'),
  drawPileLabel: $('draw-pile-label'),
  discardPile: $('discard-pile'),
  currentColor: $('current-color'),
  currentColorLabel: $('current-color-label'),
  gameMessage: $('game-message'),
  actionMessageStack: $('action-message-stack'),
  dirIndicator: $('direction-indicator'),
  dirLabel: $('dir-label'),

  // Hand & Horizontal Scroll
  myHand: $('my-hand'),
  handCardCount: $('hand-card-count'),
  handScrollPrev: $('hand-scroll-prev'),
  handScrollNext: $('hand-scroll-next'),
  handMaskLeft: $('hand-mask-left'),
  handMaskRight: $('hand-mask-right'),

  turnIndicator: $('turn-indicator'),
  btnUno: $('btn-uno'),
  catchArea: $('catch-area'),
  colorPicker: $('color-picker'),
  gameBoard: $('game-board'),

  btnSettings: $('btn-settings'),
  settingsPanel: $('settings-panel'),
  toggleSuggestions: $('toggle-suggestions'),
  btnCloseSettings: $('btn-close-settings'),

  btnSoundToggle: $('btn-sound-toggle'),
  soundIcon: $('sound-icon'),

  // Pomodoro Study & Play Mode
  btnPomodoroToggle: $('btn-pomodoro-toggle'),
  pomodoroModal: $('pomodoro-modal'),
  btnClosePomodoro: $('btn-close-pomodoro'),
  pomodoroMiniPill: $('pomodoro-mini-pill'),
  pomoMiniText: $('pomo-mini-text'),
  btnJoinPomoBanner: $('btn-join-pomo-banner'),
  pomoPhaseBadge: $('pomo-phase-badge'),
  pomoSub: $('pomo-sub'),
  pomoCircleProgress: $('pomo-circle-progress'),
  pomoTimeDisplay: $('pomo-time-display'),
  pomoStatusLabel: $('pomo-status-label'),
  pomoTaskInput: $('pomo-task-input'),
  btnPomoStart: $('btn-pomo-start'),
  pomoStartText: $('pomo-start-text'),
  btnPomoReset: $('btn-pomo-reset'),
  pomoGameOverBox: $('pomo-gameover-box'),
  pomoGameOverStatus: $('pomo-gameover-status'),
  btnPomoRestartCycle: $('btn-pomo-restart-cycle'),
  pomoQuote: $('pomo-quote'),

  // Join Screen Focus Lock
  joinNormalControls: $('join-normal-controls'),
  joinFocusLock: $('join-focus-lock'),
  lockCountdown: $('lock-countdown'),
  lockTaskName: $('lock-task-name'),
  btnLockOpenTimer: $('btn-lock-open-timer'),
  btnLockCancel: $('btn-lock-cancel'),

  winnerName: $('winner-name'),
  btnPlayAgain: $('btn-play-again'),
  btnBackLobby: $('btn-back-lobby'),
  confetti: $('confetti'),
  toasts: $('toast-container'),

  reactionLayer: $('reaction-layer'),
  reactionBar: $('reaction-bar'),

  lobbyScoreboard: $('lobby-scoreboard'),
  lobbyScoreboardList: $('lobby-scoreboard-list'),
  gameScoreboard: $('game-scoreboard'),
  gameScoreboardList: $('game-scoreboard-list'),
  gameoverScoreboard: $('gameover-scoreboard-list'),
  totalGamesLabel: $('games-played-label'),
};

/* ================================================================
   ZERO-DEPENDENCY WEB AUDIO SOUND ENGINE
   ================================================================ */
class SoundEngine {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx && typeof AudioContext !== 'undefined') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playBeep(freq, type = 'sine', duration = 0.12, gainVal = 0.12) {
    if (!state.soundEnabled) return;
    try {
      this.init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (_) { }
  }

  cardPlay() {
    if (!state.soundEnabled) return;
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(140, now + 0.1);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(now + 0.1);
    } catch (_) { }
  }

  cardDraw() {
    if (!state.soundEnabled) return;
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(420, now + 0.12);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(now + 0.12);
    } catch (_) { }
  }

  yourTurn() {
    if (!state.soundEnabled) return;
    this.playBeep(587.33, 'sine', 0.15, 0.15); // D5
    setTimeout(() => this.playBeep(880.00, 'sine', 0.25, 0.18), 100); // A5
  }

  unoAlert() {
    if (!state.soundEnabled) return;
    this.playBeep(440, 'square', 0.1, 0.16);
    setTimeout(() => this.playBeep(660, 'square', 0.1, 0.16), 110);
    setTimeout(() => this.playBeep(880, 'square', 0.22, 0.2), 220);
  }

  winFanfare() {
    if (!state.soundEnabled) return;
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, idx) => {
      setTimeout(() => this.playBeep(freq, 'triangle', 0.35, 0.2), idx * 140);
    });
  }

  pomodoroComplete() {
    if (!state.soundEnabled) return;
    const notes = [440, 554.37, 659.25, 880];
    notes.forEach((freq, idx) => {
      setTimeout(() => this.playBeep(freq, 'sine', 0.45, 0.2), idx * 130);
    });
  }

  buttonClick() {
    this.playBeep(600, 'sine', 0.05, 0.08);
  }
}

const sound = new SoundEngine();

// Sound toggle button click
function updateSoundIcon() {
  if (el.soundIcon) {
    el.soundIcon.textContent = state.soundEnabled ? '🔊' : '🔇';
  }
}
updateSoundIcon();

if (el.btnSoundToggle) {
  el.btnSoundToggle.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('uno_sound', state.soundEnabled ? 'true' : 'false');
    updateSoundIcon();
    toast(state.soundEnabled ? 'Sound Enabled 🔊' : 'Sound Muted 🔇', 1500);
  });
}

// User gesture unlock for audio
window.addEventListener('click', () => sound.init(), { once: true });
window.addEventListener('keydown', () => sound.init(), { once: true });

/* ── Helpers ───────────────────────────────────────────────────── */
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  if (screens[name]) screens[name].classList.add('active');
}

const AVATAR_COLORS = ['#EF4444', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];
function avatarColor(i) { return AVATAR_COLORS[i % AVATAR_COLORS.length]; }

function toast(msg, ms = 3000) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  el.toasts.appendChild(t);
  setTimeout(() => {
    t.classList.add('toast-out');
    setTimeout(() => t.remove(), 320);
  }, ms);
}

/* Random position helper — keeps element within visible screen bounds */
function randomizePosition(element, widthPx = 86, heightPx = 86) {
  const pad = 24;
  const maxX = window.innerWidth - widthPx - pad;
  const maxY = window.innerHeight - heightPx - pad;
  const x = Math.max(pad, Math.min(maxX, pad + Math.random() * (maxX - pad)));
  const y = Math.max(pad, Math.min(maxY - pad * 5, pad + Math.random() * (maxY - pad * 5)));
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
  element.style.right = 'auto';
  element.style.bottom = 'auto';
}

/* ── Card display helpers ──────────────────────────────────────── */
function displayVal(card) {
  switch (card.value) {
    case 'skip': return '⊘';
    case 'reverse': return '⟲';
    case 'draw2': return '+2';
    case 'wild': return '★';
    case 'wild4': return '+4';
    default: return card.value;
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
   LOBBY RENDERING & COPY CODE
   ================================================================ */
function renderLobby(players) {
  el.playerList.innerHTML = '';
  if (el.lobbyPlayerCount) {
    el.lobbyPlayerCount.textContent = `${players.length}/10`;
  }

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
      sound.buttonClick();
      socket.emit('remove-bot', { roomCode: state.roomCode, botName: btn.dataset.botName });
    });
  });

  renderLobbyScoreboard();
}

// Copy Code Button
if (el.btnCopyCode) {
  el.btnCopyCode.addEventListener('click', async () => {
    sound.buttonClick();
    if (!state.roomCode) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(state.roomCode);
      } else {
        const inp = document.createElement('input');
        inp.value = state.roomCode;
        document.body.appendChild(inp);
        inp.select();
        document.execCommand('copy');
        inp.remove();
      }
      el.copyText.textContent = 'Copied! ✓';
      toast(`Room code ${state.roomCode} copied to clipboard! 📋`);
      setTimeout(() => {
        if (el.copyText) el.copyText.textContent = 'Copy';
      }, 2000);
    } catch (_) {
      toast(`Room code: ${state.roomCode}`);
    }
  });
}

/* ================================================================
   GAME RENDERING
   ================================================================ */
function render(gs) {
  state.game = gs;
  if (gs.scoreboard) setScoreboard(gs.scoreboard, gs.totalGames);

  if (el.hudRoomCode) el.hudRoomCode.textContent = gs.roomCode || state.roomCode || 'UNO';

  // Sound chime when turn switches to you
  if (gs.isMyTurn && !state.wasMyTurn) {
    sound.yourTurn();
  }
  state.wasMyTurn = gs.isMyTurn;

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
    const minis = Array(Math.min(p.cardCount, 10))
      .fill('<div class="mini-card"></div>').join('');
    div.innerHTML =
      `<div class="player-avatar" style="background:${avatarColor(i)};">${p.name.startsWith('Bot ') ? '🤖' : p.name[0].toUpperCase()}</div>` +
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
let lastTopCardId = null;
let currentDiscardRotation = -2;

function renderDiscard(gs) {
  el.discardPile.innerHTML = '';
  if (!gs.topCard) return;

  // New card gets a subtle randomized tilt angle for realism
  if (gs.topCard.id !== lastTopCardId) {
    lastTopCardId = gs.topCard.id;
    currentDiscardRotation = (Math.random() * 8 - 4).toFixed(1);
  }

  const c = makeCard(gs.topCard);
  c.style.transform = `rotate(${currentDiscardRotation}deg)`;
  c.style.cursor = 'default';
  el.discardPile.appendChild(c);

  const lbl = document.createElement('span');
  lbl.className = 'pile-label';
  lbl.textContent = 'DISCARD';
  el.discardPile.appendChild(lbl);
}

/* ── Current color hub ─────────────────────────────────────────── */
const COLOR_MAP = {
  red: 'var(--uno-red)',
  blue: 'var(--uno-blue)',
  green: 'var(--uno-green)',
  yellow: 'var(--uno-yellow)',
};

function renderColorDot(gs) {
  const c = COLOR_MAP[gs.currentColor] || '#666';
  el.currentColor.style.background = c;
  el.currentColor.style.boxShadow = `0 0 24px ${c}`;
  if (el.currentColorLabel) {
    el.currentColorLabel.textContent = gs.currentColor ? gs.currentColor.toUpperCase() : 'COLOR';
    el.currentColorLabel.style.color = c;
  }
}

/* ================================================================
   PLAYER HAND & HORIZONTAL SCROLL MANAGEMENT
   ================================================================ */
function updateHandScrollIndicators() {
  const hand = el.myHand;
  if (!hand) return;
  const canScrollLeft = hand.scrollLeft > 8;
  const canScrollRight = hand.scrollLeft < hand.scrollWidth - hand.clientWidth - 8;

  if (el.handScrollPrev) el.handScrollPrev.classList.toggle('visible', canScrollLeft);
  if (el.handScrollNext) el.handScrollNext.classList.toggle('visible', canScrollRight);
  if (el.handMaskLeft) el.handMaskLeft.classList.toggle('visible', canScrollLeft);
  if (el.handMaskRight) el.handMaskRight.classList.toggle('visible', canScrollRight);
}

let prevCardCount = 0;

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
      extraClass = 'playable';
    }
    const c = makeCard(card, extraClass);
    if (gs.isMyTurn && (playable || !showHints)) {
      c.addEventListener('click', (e) => {
        // Prevent accidental card play if user was dragging to scroll
        if (isDraggingHand) return;
        onPlayCard(card);
      });
    }
    el.myHand.appendChild(c);
  });

  // Update hand badges
  if (el.handCardCount) {
    const count = gs.myCards.length;
    el.handCardCount.textContent = `🃏 ${count} ${count === 1 ? 'Card' : 'Cards'}`;
  }

  // Auto-scroll when new cards are drawn so player can see them immediately
  if (gs.myCards.length > prevCardCount && prevCardCount > 0) {
    setTimeout(() => {
      if (el.myHand) {
        el.myHand.scrollTo({ left: el.myHand.scrollWidth, behavior: 'smooth' });
        updateHandScrollIndicators();
      }
    }, 80);
  }
  prevCardCount = gs.myCards.length;

  // Update scroll buttons and indicators
  requestAnimationFrame(updateHandScrollIndicators);
}

/* ── Mouse Wheel & Drag Scrolling for Hand ─────────────────────── */
let isDraggingHand = false;
let handDragStartX = 0;
let handDragScrollLeft = 0;
let handDragDist = 0;

if (el.myHand) {
  // Convert vertical wheel to horizontal scroll over cards
  el.myHand.addEventListener('wheel', (e) => {
    if (e.deltaY !== 0 && el.myHand.scrollWidth > el.myHand.clientWidth) {
      e.preventDefault();
      el.myHand.scrollLeft += e.deltaY * 0.9;
      updateHandScrollIndicators();
    }
  }, { passive: false });

  // Update indicators on scroll
  el.myHand.addEventListener('scroll', updateHandScrollIndicators, { passive: true });

  // Mouse Drag to scroll hand
  el.myHand.addEventListener('mousedown', (e) => {
    isDraggingHand = false;
    handDragDist = 0;
    handDragStartX = e.pageX - el.myHand.offsetLeft;
    handDragScrollLeft = el.myHand.scrollLeft;
    const onMouseMove = (ev) => {
      const x = ev.pageX - el.myHand.offsetLeft;
      const walk = (x - handDragStartX);
      handDragDist = Math.abs(walk);
      if (handDragDist > 6) {
        isDraggingHand = true;
        el.myHand.scrollLeft = handDragScrollLeft - walk;
        updateHandScrollIndicators();
      }
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setTimeout(() => { isDraggingHand = false; }, 50);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
}

// Chevron Scroll Buttons
if (el.handScrollPrev) {
  el.handScrollPrev.addEventListener('click', () => {
    sound.buttonClick();
    el.myHand.scrollBy({ left: -260, behavior: 'smooth' });
    setTimeout(updateHandScrollIndicators, 300);
  });
}
if (el.handScrollNext) {
  el.handScrollNext.addEventListener('click', () => {
    sound.buttonClick();
    el.myHand.scrollBy({ left: 260, behavior: 'smooth' });
    setTimeout(updateHandScrollIndicators, 300);
  });
}

window.addEventListener('resize', () => {
  requestAnimationFrame(updateHandScrollIndicators);
});

/* ── Draw pile ─────────────────────────────────────────────────── */
function renderDrawPile(gs) {
  el.drawPile.classList.toggle('can-draw', gs.isMyTurn);
  if (el.drawPileLabel) {
    el.drawPileLabel.textContent = `DRAW · ${gs.drawPileCount}`;
  }

  // Re-bind click
  const back = el.drawPile.querySelector('.card-back');
  if (back) {
    const newBack = back.cloneNode(true);
    back.parentNode.replaceChild(newBack, back);
    if (gs.isMyTurn) {
      newBack.addEventListener('click', onDrawCard);
    }
  }
}

/* ── Direction ─────────────────────────────────────────────────── */
function renderDirection(gs) {
  const sym = el.dirIndicator.querySelector('.dir-symbol') || el.dirIndicator;
  sym.textContent = gs.direction === 1 ? '↻' : '↺';
  el.dirIndicator.classList.toggle('reversed', gs.direction === -1);
  if (el.dirLabel) {
    el.dirLabel.textContent = gs.direction === 1 ? 'Clockwise' : 'Counter-Clockwise';
  }
}

/* ── Turn banner ───────────────────────────────────────────────── */
function renderTurnBanner(gs) {
  if (gs.isMyTurn) {
    el.turnIndicator.textContent = '✨ YOUR TURN — Play or Draw';
    el.turnIndicator.className = 'turn-indicator my-turn';
  } else {
    const cur = gs.players[gs.currentPlayerIndex];
    el.turnIndicator.textContent = `⏳ Waiting for ${cur ? cur.name : 'Opponent'}...`;
    el.turnIndicator.className = 'turn-indicator their-turn';
  }
}

/* ── UNO button ────────────────────────────────────────────────── */
function renderUnoBtn(gs) {
  const me = gs.players[gs.myIndex];
  const shouldShow = me && me.cardCount === 1 && !me.calledUno && gs.needsUnoCall === gs.myIndex;
  if (shouldShow && el.btnUno.style.display === 'none') {
    randomizePosition(el.btnUno, 86, 86);
    sound.unoAlert();
  }
  el.btnUno.style.display = shouldShow ? 'flex' : 'none';
}

/* ── Catch buttons ─────────────────────────────────────────────── */
function renderCatchBtns(gs) {
  el.catchArea.innerHTML = '';
  if (gs.needsUnoCall === null || gs.needsUnoCall === gs.myIndex) return;
  const target = gs.players[gs.needsUnoCall];
  if (!target || target.calledUno || target.cardCount !== 1) return;

  const btn = document.createElement('button');
  btn.className = 'btn-catch';
  btn.textContent = `Catch ${target.name}! 🚨`;
  btn.addEventListener('click', () => {
    sound.buttonClick();
    socket.emit('catch-uno', { roomCode: state.roomCode, targetIndex: gs.needsUnoCall });
  });
  el.catchArea.appendChild(btn);
  randomizePosition(el.catchArea, 160, 50);
}

/* ── Game message & Action Stack (Fading stacked messages above turn box) ──── */
let lastActionSig = null;
let actionMsgId = 0;

function renderMessage(gs) {
  const a = gs.lastAction;
  if (!a) return;

  const msgs = {
    play: () => `${a.playerName} played a card`,
    skip: () => `${a.playerName} skipped ${a.skippedPlayer}! ⊘`,
    reverse: () => `${a.playerName} reversed direction! ⟲`,
    draw2: () => `${a.targetPlayer} draws +2! 😬`,
    wild4: () => `${a.targetPlayer} draws +4! Color → ${capitalize(a.chosenColor)} 🌈`,
    draw: () => `${a.playerName} drew a card`,
    uno: () => `${a.playerName} called UNO! 🎴`,
    caught: () => `${a.caughtBy} caught ${a.playerName}! +2 penalty 😈`,
  };

  const textFn = msgs[a.type];
  if (!textFn) return;
  const text = textFn();
  if (!text) return;

  if (el.gameMessage) el.gameMessage.textContent = text;

  // Create unique signature to avoid duplicate pushes
  const sig = `${a.type}:${a.playerName || ''}:${a.targetPlayer || ''}:${a.skippedPlayer || ''}:${a.chosenColor || ''}:${gs.drawPileCount}:${gs.currentPlayerIndex}:${gs.topCard?.id || ''}`;
  if (sig === lastActionSig) return;
  lastActionSig = sig;

  // Add new message to stack
  const id = ++actionMsgId;
  state.actionStack.push({ id, text });

  // Keep max 2-3 items in the stack (user specified max height 2 or 3)
  while (state.actionStack.length > 3) {
    state.actionStack.shift();
  }

  renderActionMessageStack();

  // Expire message after 5 seconds so it gracefully fades away when game is idle
  setTimeout(() => {
    const idx = state.actionStack.findIndex(m => m.id === id);
    if (idx !== -1) {
      state.actionStack.splice(idx, 1);
      renderActionMessageStack();
    }
  }, 5000);
}

function renderActionMessageStack() {
  if (!el.actionMessageStack) return;
  el.actionMessageStack.innerHTML = '';

  const total = state.actionStack.length;
  // Render in order: oldest at top (idx 0), newest at bottom (idx total - 1, closest to turn box)
  state.actionStack.forEach((msg, idx) => {
    const distFromNewest = (total - 1) - idx; // 0 = newest, 1 = 1 step older, 2 = oldest
    const chip = document.createElement('div');
    chip.className = 'action-msg-chip';

    if (distFromNewest === 0) {
      chip.classList.add('tier-active');
    } else if (distFromNewest === 1) {
      chip.classList.add('tier-faded');
    } else {
      chip.classList.add('tier-fading-out');
    }

    chip.textContent = msg.text;
    el.actionMessageStack.appendChild(chip);
  });
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

/* ── Settings panel (host only) ────────────────────────────────── */
function renderSettings(gs) {
  el.btnSettings.style.display = gs.isHost ? 'flex' : 'none';
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
  sound.buttonClick();
  const panel = el.settingsPanel;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
});
el.btnCloseSettings.addEventListener('click', () => {
  sound.buttonClick();
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
  sound.cardPlay();
  if (card.color === 'wild' || card.value === 'wild' || card.value === 'wild4') {
    state.pendingWildId = card.id;
    el.colorPicker.style.display = 'flex';
    return;
  }
  socket.emit('play-card', { roomCode: state.roomCode, cardId: card.id });
}

function onDrawCard() {
  if (!state.game?.isMyTurn) return;
  sound.cardDraw();
  socket.emit('draw-card', { roomCode: state.roomCode });
}

/* ── Color picker ──────────────────────────────────────────────── */
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    sound.buttonClick();
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
  const colors = ['#EF4444', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#F97316'];
  for (let i = 0; i < 70; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = `${Math.random() * 2}s`;
    piece.style.animationDuration = `${2.2 + Math.random() * 2.2}s`;
    piece.style.width = `${7 + Math.random() * 7}px`;
    piece.style.height = `${7 + Math.random() * 7}px`;
    container.appendChild(piece);
  }
}

/* ================================================================
   EMOJI REACTIONS
   ================================================================ */
const REACTION_EMOJIS = ['😂', '😡', '😢', '🤬'];
const REACTION_COOLDOWN_MS = 900;
let lastReactionAt = 0;

function spawnReaction(emoji, count = 14) {
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('span');
    piece.className = 'reaction-float';
    piece.textContent = emoji;
    piece.style.left = `${Math.random() * 92}%`;
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
    piece.style.setProperty('--spin', `${(Math.random() - 0.5) * 90}deg`);
    piece.style.fontSize = `${1.5 + Math.random() * 1.5}rem`;
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
  if (isPomodoroLocked()) {
    sound.buttonClick();
    openPomodoroModal();
    toast('🔒 Study Focus in progress! Finish timer to unlock UNO!');
    return;
  }
  sound.buttonClick();
  const name = el.playerName.value.trim();
  if (!name) return toast('Enter your name first! 👤');
  state.playerName = name;
  state.isHost = true;
  socket.emit('create-room', { playerName: name });
});

el.btnJoin.addEventListener('click', () => {
  if (isPomodoroLocked()) {
    sound.buttonClick();
    openPomodoroModal();
    toast('🔒 Study Focus in progress! Finish timer to unlock UNO!');
    return;
  }
  sound.buttonClick();
  const name = el.playerName.value.trim();
  const code = el.roomCodeInput.value.trim();
  if (!name) return toast('Enter your name first! 👤');
  if (!code) return toast('Enter a room code! 🔑');
  state.playerName = name;
  socket.emit('join-room', { roomCode: code, playerName: name });
});

el.btnStart.addEventListener('click', () => {
  if (isPomodoroLocked()) {
    sound.buttonClick();
    openPomodoroModal();
    toast('🔒 Study Focus in progress! Finish timer to play!');
    return;
  }
  sound.buttonClick();
  socket.emit('start-game', { roomCode: state.roomCode });
});

el.btnAddBot.addEventListener('click', () => {
  if (isPomodoroLocked()) {
    sound.buttonClick();
    toast('🔒 Study Focus in progress!');
    return;
  }
  sound.buttonClick();
  socket.emit('add-bot', { roomCode: state.roomCode });
});

el.btnUno.addEventListener('click', () => {
  sound.unoAlert();
  socket.emit('call-uno', { roomCode: state.roomCode });
});

el.btnPlayAgain.addEventListener('click', () => {
  sound.buttonClick();
  socket.emit('restart-game', { roomCode: state.roomCode });
});

el.btnBackLobby.addEventListener('click', () => {
  sound.buttonClick();
  location.reload();
});

// Enter-key shortcuts
el.playerName.addEventListener('keypress', e => { if (e.key === 'Enter') el.btnCreate.click(); });
el.roomCodeInput.addEventListener('keypress', e => { if (e.key === 'Enter') el.btnJoin.click(); });

/* ── Kill switch (press "k") ─────────────────────────────────── */
let killArmed = false;

function fleeHome() {
  window.location.replace('about:blank');
}

function activateKillSwitch() {
  if (killArmed) return;
  killArmed = true;

  socket.timeout(800).emit('kill-switch', () => {
    fleeHome();
  });

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
  if (state.game) render(state.game);
});

// ── Game started ───────────────────────────────────────────────
socket.on('game-started', (gs) => {
  if (gs.scoreboard) setScoreboard(gs.scoreboard, gs.totalGames);
  state.actionStack = [];
  lastActionSig = null;
  renderActionMessageStack();
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
  try { renderGameoverScoreboard(gs, winnerName); } catch (err) { console.error(err); }

  // Check and advance Pomodoro study & play cycle
  handlePomodoroGameOver();

  showScreen('gameover');
  sound.winFanfare();
  spawnConfetti();
});

// ── Reaction from any player ───────────────────────────────────
socket.on('reaction', ({ emoji }) => spawnReaction(emoji));

// ── UNO called ─────────────────────────────────────────────────
socket.on('uno-called', ({ playerName }) => {
  sound.unoAlert();
  toast(`${playerName} called UNO! 🎴`);
});

// ── UNO caught ─────────────────────────────────────────────────
socket.on('uno-caught', ({ playerName, caughtBy }) =>
  toast(`${caughtBy} caught ${playerName}! +2 penalty 😈`));

// ── Player left mid-game ───────────────────────────────────────
socket.on('player-left-ended', ({ message }) => {
  toast(message, 5000);
  setTimeout(() => location.reload(), 4000);
});

// ── Kill switch ────────────────────────────────────────────────
socket.on('kill-switch', () => {
  if (killArmed) return;
  killArmed = true;
  fleeHome();
});

// ── Errors ─────────────────────────────────────────────────────
socket.on('error-msg', ({ message }) => toast(message));

socket.on('disconnect', () => toast('Disconnected from server! 🔌', 5000));

/* ================================================================
   POMODORO STUDY & PLAY CONTROLLER
   ================================================================ */
const POMO_QUOTES = [
  "Focus for 25 minutes now. Celebrate your victory in UNO later! 🎴",
  "Deep study builds mastery. A great UNO match is your earned reward! 🧠",
  "Lock in! Soon you will be playing with a relaxed, satisfied mind.",
  "1 focused study session = 1-2 thrilling, guilt-free UNO victories! 🏆",
  "Small daily focus blocks lead to massive long-term success. 🚀"
];

function initPomodoro() {
  try {
    const saved = localStorage.getItem('uno_pomo_cfg');
    if (saved) {
      const cfg = JSON.parse(saved);
      if (cfg.durationMinutes) state.pomodoro.durationMinutes = cfg.durationMinutes;
      if (cfg.rewardGamesTotal) state.pomodoro.rewardGamesTotal = cfg.rewardGamesTotal;
      if (cfg.taskName && el.pomoTaskInput) {
        state.pomodoro.taskName = cfg.taskName;
        el.pomoTaskInput.value = cfg.taskName;
      }
    }
  } catch (_) { }

  state.pomodoro.totalSeconds = state.pomodoro.durationMinutes * 60;
  state.pomodoro.remainingSeconds = state.pomodoro.totalSeconds;

  // Restore active presets in modal
  document.querySelectorAll('.pomo-preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.min, 10) === state.pomodoro.durationMinutes);
  });
  document.querySelectorAll('.pomo-reward-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.games, 10) === state.pomodoro.rewardGamesTotal);
  });

  // Restore running/paused/break timer if page was reloaded
  try {
    const runState = localStorage.getItem('uno_pomo_run');
    if (runState) {
      const parsed = JSON.parse(runState);
      if (parsed.active) {
        state.pomodoro.active = true;
        state.pomodoro.mode = parsed.mode || 'focus';
        state.pomodoro.totalSeconds = parsed.totalSeconds || state.pomodoro.totalSeconds;
        state.pomodoro.rewardGamesPlayed = parsed.rewardGamesPlayed || 0;
        state.pomodoro.rewardGamesTotal = parsed.rewardGamesTotal || state.pomodoro.rewardGamesTotal;
        state.pomodoro.durationMinutes = parsed.durationMinutes || state.pomodoro.durationMinutes;
        if (parsed.taskName && el.pomoTaskInput) {
          state.pomodoro.taskName = parsed.taskName;
          el.pomoTaskInput.value = parsed.taskName;
        }

        if (parsed.isRunning && parsed.targetEndTime) {
          const remaining = Math.max(0, Math.round((parsed.targetEndTime - Date.now()) / 1000));
          if (remaining > 0) {
            // Timer was running and hasn't expired yet
            state.pomodoro.isRunning = true;
            state.pomodoro.targetEndTime = parsed.targetEndTime;
            state.pomodoro.remainingSeconds = remaining;
            state.pomodoro.timerHandle = setInterval(onPomodoroTick, 500);
          } else {
            // Timer expired while page was closed — trigger completion
            state.pomodoro.remainingSeconds = 0;
            state.pomodoro.isRunning = false;
            state.pomodoro.targetEndTime = null;
            // Delay so UI renders first
            setTimeout(() => onPomodoroComplete(), 300);
          }
        } else if (!parsed.isRunning && parsed.mode === 'focus') {
          // Was paused during focus — restore remaining time
          state.pomodoro.isRunning = false;
          state.pomodoro.remainingSeconds = parsed.remainingSeconds || state.pomodoro.totalSeconds;
        } else if (parsed.mode === 'break') {
          // Break mode — game is unlocked, just restore UI state
          state.pomodoro.isRunning = false;
          state.pomodoro.remainingSeconds = 0;
        }
      }
    }
  } catch (_) { }

  updatePomodoroUI();
  setupPomodoroListeners();
}

function savePomodoroState() {
  const p = state.pomodoro;
  try {
    localStorage.setItem('uno_pomo_cfg', JSON.stringify({
      durationMinutes: p.durationMinutes,
      rewardGamesTotal: p.rewardGamesTotal,
      taskName: p.taskName,
    }));
    // Persist full session state so the timer survives page refreshes
    if (p.active) {
      localStorage.setItem('uno_pomo_run', JSON.stringify({
        active: true,
        isRunning: p.isRunning,
        targetEndTime: p.targetEndTime,
        remainingSeconds: p.remainingSeconds,
        mode: p.mode,
        totalSeconds: p.totalSeconds,
        rewardGamesPlayed: p.rewardGamesPlayed,
        rewardGamesTotal: p.rewardGamesTotal,
        taskName: p.taskName,
        durationMinutes: p.durationMinutes,
      }));
    } else {
      localStorage.removeItem('uno_pomo_run');
    }
  } catch (_) { }
}

function updatePomodoroUI() {
  const p = state.pomodoro;
  const mins = Math.floor(p.remainingSeconds / 60);
  const secs = p.remainingSeconds % 60;
  const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  // Time display inside modal
  if (el.pomoTimeDisplay) el.pomoTimeDisplay.textContent = timeStr;

  // Mini floating pill
  if (el.pomoMiniText) {
    if (p.mode === 'focus') {
      el.pomoMiniText.textContent = `${timeStr} Focus`;
    } else {
      el.pomoMiniText.textContent = `🎮 Reward (${p.rewardGamesPlayed}/${p.rewardGamesTotal})`;
    }
  }
  if (el.pomodoroMiniPill) {
    el.pomodoroMiniPill.style.display = p.active ? 'flex' : 'none';
    el.pomodoroMiniPill.classList.toggle('is-break', p.mode === 'break');
  }

  // Top header button pulse
  if (el.btnPomodoroToggle) {
    el.btnPomodoroToggle.classList.toggle('is-running', p.isRunning);
  }

  // SVG circular progress ring (circumference is 597)
  if (el.pomoCircleProgress) {
    const fraction = p.totalSeconds > 0 ? (p.remainingSeconds / p.totalSeconds) : 0;
    const offset = 597 * (1 - fraction);
    el.pomoCircleProgress.style.strokeDashoffset = offset;
    el.pomoCircleProgress.style.stroke = p.mode === 'break' ? 'url(#pomoGradBreak)' : 'url(#pomoGradFocus)';
  }

  // Phase badge & subtext
  if (el.pomoPhaseBadge) {
    if (p.mode === 'focus') {
      el.pomoPhaseBadge.textContent = '🍅 STUDY FOCUS';
      el.pomoPhaseBadge.classList.remove('is-break');
    } else {
      el.pomoPhaseBadge.textContent = '🎮 UNO REWARD TIME';
      el.pomoPhaseBadge.classList.add('is-break');
    }
  }

  if (el.pomoSub) {
    if (p.mode === 'focus') {
      const task = p.taskName ? ` (${p.taskName})` : '';
      el.pomoSub.textContent = `Lock in and study for your goal${task}. Earn UNO matches when done!`;
    } else {
      el.pomoSub.textContent = `Focus session complete! Enjoy your earned reward matches (${p.rewardGamesPlayed}/${p.rewardGamesTotal})!`;
    }
  }

  // Status label
  if (el.pomoStatusLabel) {
    if (!p.isRunning && p.remainingSeconds === p.totalSeconds) {
      el.pomoStatusLabel.textContent = p.mode === 'focus' ? 'READY TO STUDY' : 'REWARD UNLOCKED';
    } else if (p.isRunning) {
      el.pomoStatusLabel.textContent = p.mode === 'focus' ? 'STUDYING IN PROGRESS' : 'REWARD TIME';
    } else {
      el.pomoStatusLabel.textContent = 'PAUSED';
    }
  }

  // Start button text
  if (el.pomoStartText) {
    if (p.mode === 'break') {
      el.pomoStartText.textContent = 'Play UNO Match Now 🎴';
    } else if (p.isRunning) {
      el.pomoStartText.textContent = 'Pause Timer ⏸';
    } else if (p.remainingSeconds < p.totalSeconds) {
      el.pomoStartText.textContent = 'Resume Focus ▶';
    } else {
      el.pomoStartText.textContent = 'Start Focus Session 🎯';
    }
  }

  const card = document.querySelector('.pomodoro-card');
  if (card) {
    card.classList.toggle('is-break', p.mode === 'break');
  }

  // Update Join Screen lock state
  updateJoinLockUI();
}

function isPomodoroLocked() {
  const p = state.pomodoro;
  return Boolean(p && p.active && p.mode === 'focus');
}

function updateJoinLockUI() {
  const p = state.pomodoro;
  const locked = isPomodoroLocked();

  if (el.joinNormalControls) {
    el.joinNormalControls.style.display = locked ? 'none' : 'block';
  }
  if (el.joinFocusLock) {
    el.joinFocusLock.style.display = locked ? 'flex' : 'none';
  }

  if (locked) {
    const mins = Math.floor(p.remainingSeconds / 60);
    const secs = p.remainingSeconds % 60;
    const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    if (el.lockCountdown) el.lockCountdown.textContent = timeStr;
    if (el.lockTaskName) {
      el.lockTaskName.textContent = p.taskName ? `Studying: ${p.taskName}` : 'Deep study in progress...';
    }
  }
}

function cancelPomodoroSession() {
  sound.buttonClick();
  const p = state.pomodoro;
  if (!confirm('End your study session early? No reward matches will be earned.')) {
    return;
  }
  resetPomodoro();
  p.active = false;
  savePomodoroState();
  updatePomodoroUI();
  updateJoinLockUI();
  toast('Study session ended. Game unlocked! 🔓');
}

function togglePomodoroTimer() {
  const p = state.pomodoro;
  sound.buttonClick();

  if (p.mode === 'break') {
    closePomodoroModal();
    toast(`🎮 Time for your reward match (${p.rewardGamesPlayed + 1}/${p.rewardGamesTotal})!`);
    return;
  }

  if (p.isRunning) {
    // Pause timer — freeze remaining seconds from real time
    p.remainingSeconds = Math.max(0, Math.round((p.targetEndTime - Date.now()) / 1000));
    p.isRunning = false;
    p.targetEndTime = null;
    clearInterval(p.timerHandle);
    p.timerHandle = null;
    savePomodoroState();
    updatePomodoroUI();
  } else {
    // Start or resume timer
    p.active = true;
    p.isRunning = true;
    p.targetEndTime = Date.now() + p.remainingSeconds * 1000;

    if (el.pomoTaskInput) {
      p.taskName = el.pomoTaskInput.value.trim();
    }

    clearInterval(p.timerHandle);
    p.timerHandle = setInterval(onPomodoroTick, 500);

    savePomodoroState();
    updatePomodoroUI();
    toast('🎯 Focus session started! Lock in!');
  }
}

function onPomodoroTick() {
  const p = state.pomodoro;
  if (!p.isRunning) return;

  const now = Date.now();
  const left = Math.max(0, Math.round((p.targetEndTime - now) / 1000));
  p.remainingSeconds = left;

  if (p.remainingSeconds <= 0) {
    clearInterval(p.timerHandle);
    p.timerHandle = null;
    p.isRunning = false;
    onPomodoroComplete();
  }

  updatePomodoroUI();
}

function onPomodoroComplete() {
  const p = state.pomodoro;
  if (p.mode === 'focus') {
    p.mode = 'break';
    p.rewardGamesPlayed = 0;
    p.remainingSeconds = 0;
    p.isRunning = false;
    p.targetEndTime = null;
    sound.pomodoroComplete();
    spawnConfetti();

    toast(`🎉 Focus complete! You earned ${p.rewardGamesTotal} UNO reward match${p.rewardGamesTotal > 1 ? 'es' : ''}!`, 7000);
    openPomodoroModal();
  } else {
    resetPomodoro();
  }
  savePomodoroState();
  updatePomodoroUI();
}

function resetPomodoro() {
  sound.buttonClick();
  const p = state.pomodoro;
  clearInterval(p.timerHandle);
  p.timerHandle = null;
  p.isRunning = false;
  p.mode = 'focus';
  p.totalSeconds = p.durationMinutes * 60;
  p.remainingSeconds = p.totalSeconds;
  p.targetEndTime = null;
  savePomodoroState();
  updatePomodoroUI();
}

function openPomodoroModal() {
  sound.buttonClick();
  if (el.pomodoroModal) {
    el.pomodoroModal.style.display = 'flex';
  }
  if (el.pomoQuote) {
    el.pomoQuote.textContent = `"${POMO_QUOTES[Math.floor(Math.random() * POMO_QUOTES.length)]}"`;
  }
  updatePomodoroUI();
}

function closePomodoroModal() {
  sound.buttonClick();
  if (el.pomodoroModal) {
    el.pomodoroModal.style.display = 'none';
  }
}

function handlePomodoroGameOver() {
  const p = state.pomodoro;
  if (!p.active) {
    if (el.pomoGameOverBox) el.pomoGameOverBox.style.display = 'none';
    return;
  }

  if (p.mode === 'break') {
    p.rewardGamesPlayed++;
    if (el.pomoGameOverBox) {
      el.pomoGameOverBox.style.display = 'block';
    }

    if (p.rewardGamesPlayed < p.rewardGamesTotal) {
      if (el.pomoGameOverStatus) {
        el.pomoGameOverStatus.textContent = `Reward Match ${p.rewardGamesPlayed} of ${p.rewardGamesTotal} finished! 1 match remaining.`;
      }
    } else {
      if (el.pomoGameOverStatus) {
        el.pomoGameOverStatus.textContent = `All ${p.rewardGamesTotal} reward match${p.rewardGamesTotal > 1 ? 'es' : ''} finished! Time for your next study block 🎯`;
      }
    }
  }
  savePomodoroState();
  updatePomodoroUI();
}

function setupPomodoroListeners() {
  if (el.btnPomodoroToggle) {
    el.btnPomodoroToggle.addEventListener('click', openPomodoroModal);
  }
  if (el.btnClosePomodoro) {
    el.btnClosePomodoro.addEventListener('click', closePomodoroModal);
  }
  if (el.pomodoroMiniPill) {
    el.pomodoroMiniPill.addEventListener('click', openPomodoroModal);
  }
  if (el.btnJoinPomoBanner) {
    el.btnJoinPomoBanner.addEventListener('click', openPomodoroModal);
  }
  if (el.btnPomoStart) {
    el.btnPomoStart.addEventListener('click', togglePomodoroTimer);
  }
  if (el.btnPomoReset) {
    el.btnPomoReset.addEventListener('click', resetPomodoro);
  }
  if (el.btnPomoRestartCycle) {
    el.btnPomoRestartCycle.addEventListener('click', () => {
      sound.buttonClick();
      resetPomodoro();
      openPomodoroModal();
      toast('Ready for your next study block! 🎯');
    });
  }

  if (el.btnLockOpenTimer) {
    el.btnLockOpenTimer.addEventListener('click', openPomodoroModal);
  }
  if (el.btnLockCancel) {
    el.btnLockCancel.addEventListener('click', cancelPomodoroSession);
  }

  if (el.pomodoroModal) {
    el.pomodoroModal.addEventListener('click', (e) => {
      if (e.target === el.pomodoroModal) closePomodoroModal();
    });
  }

  if (el.pomoTaskInput) {
    el.pomoTaskInput.addEventListener('input', () => {
      state.pomodoro.taskName = el.pomoTaskInput.value.trim();
      savePomodoroState();
    });
  }

  // Preset duration buttons
  document.querySelectorAll('.pomo-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sound.buttonClick();
      document.querySelectorAll('.pomo-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const min = parseInt(btn.dataset.min, 10);
      state.pomodoro.durationMinutes = min;
      resetPomodoro();
    });
  });

  // Reward selection buttons
  document.querySelectorAll('.pomo-reward-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sound.buttonClick();
      document.querySelectorAll('.pomo-reward-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.pomodoro.rewardGamesTotal = parseInt(btn.dataset.games, 10);
      savePomodoroState();
      updatePomodoroUI();
    });
  });
}

// Initialize Pomodoro Study & Play mode
initPomodoro();
