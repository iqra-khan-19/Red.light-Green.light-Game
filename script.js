(function () {
  "use strict";

  // ---------- DOM ----------
  const screens = ['modeScreen','hostLobby','joinScreen','guestLobby','startScreen','gameScreen','endScreen'];
  let currentScreen = 'modeScreen';
  function showScreen(id) {
    currentScreen = id;
    screens.forEach(s => {
      document.getElementById(s).style.display = (s === id) ? 'flex' : 'none';
    });
  }

  const startBtn = document.getElementById('startBtn');
  const restartBtn = document.getElementById('restartBtn');
  const moveBtn = document.getElementById('moveBtn');
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const lightDot = document.getElementById('lightDot');
  const lightLabel = document.getElementById('lightLabel');
  const eliminatedCountEl = document.getElementById('eliminatedCount');
  const flashEl = document.getElementById('flash');
  const resultTitle = document.getElementById('resultTitle');
  const resultText = document.getElementById('resultText');
  const scoreList = document.getElementById('scoreList');
  const soundRed = document.getElementById('sound-red');
  const soundGreen = document.getElementById('sound-green');
  const soundLost = document.getElementById('sound-lost');
  const soundTheme = document.getElementById('sound-theme');
  const muteBtnGlobal = document.getElementById('muteBtnGlobal');
  const muteBtnGame = document.getElementById('muteBtnGame');

  const roomCodeDisplay = document.getElementById('roomCodeDisplay');
  const shareCodeBtn = document.getElementById('shareCodeBtn');
  const shareStatusEl = document.getElementById('shareStatus');
  const hostPlayerList = document.getElementById('hostPlayerList');
  const hostStartBtn = document.getElementById('hostStartBtn');
  const guestPlayerList = document.getElementById('guestPlayerList');
  const joinCodeInput = document.getElementById('joinCodeInput');
  const joinStatus = document.getElementById('joinStatus');
  const leaderboardEl = document.getElementById('leaderboard');
  const winCelebration = document.getElementById('winCelebration');
  const confettiLayer = document.getElementById('confettiLayer');
  const winSpeechBubble = document.getElementById('winSpeechBubble');

  // ---------- theme lookup (reads the CSS variables above) ----------
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  const THEME = {};
  function loadTheme() {
    THEME.track = cssVar('--color-track');
    THEME.laneLine = cssVar('--color-lane-line');
    THEME.finish = cssVar('--color-finish-line');
    THEME.player = cssVar('--color-player');
    THEME.ai = [cssVar('--color-ai-1'), cssVar('--color-ai-2'), cssVar('--color-ai-3'), cssVar('--color-ai-4')];
    THEME.eliminated = cssVar('--color-eliminated');
    THEME.text = cssVar('--color-text');
    THEME.playerOutline = cssVar('--color-player-outline');
    THEME.numberText = cssVar('--color-number-text');
    THEME.confetti = [cssVar('--color-confetti-1'), cssVar('--color-confetti-2'), cssVar('--color-confetti-3'), cssVar('--color-confetti-4')];
  }
  loadTheme(); // load once up front so lobby badges have colors before the race starts

  function colorFor(index) {
    return index === 0 ? THEME.player : THEME.ai[(index - 1) % THEME.ai.length];
  }

  // ---------- game constants ----------
  let LANE_COUNT = 5; // 1 player + 4 AI in solo mode; player count in multiplayer
  const START_Y_MARGIN = 40;
  const FINISH_Y = 46;
  const CHAR_R = 16;

  const PLAYER_SPEED = 104;      // px/sec while moving (slower + wobble = longer, tenser race)
  const AI_SPEED_MIN = 80;
  const AI_SPEED_MAX = 114;

  const GREEN_MIN_MS = 1500, GREEN_MAX_MS = 3800;
  const RED_MIN_MS = 1500, RED_MAX_MS = 3400;
  const REPEAT_CALL_CHANCE = 0.35; // chance the caller repeats the same light instead of switching
  const BROADCAST_INTERVAL_MS = 60; // how often the host sends position updates (~16/sec)
  const ROOM_ID_PREFIX = 'rlgl5-'; // namespaces our room codes on the shared public PeerJS server

  // ---------- state ----------
  let MODE = 'solo'; // 'solo' | 'host' | 'guest'
  let W, H;
  let characters = [];
  let lightState = 'green'; // 'green' | 'red'
  let lightTimer = 0;
  let lightDuration = 0;
  let running = false;
  let lastTs = 0;
  let movePressed = false;
  let flashTimeout = null;
  let finishOrder = []; // host-only: characters in the order they finished
  let particleBursts = []; // flower-burst particle groups, one per elimination

  // networking state
  let peer = null;
  let myPeerId = null;
  let roomCode = '';
  let hostConns = {};      // host only: peerId -> { conn, number, moving }
  let guestConn = null;    // guest only: connection to the host
  let lobbyPlayers = [];   // both: [{peerId, number, isHost}]
  let lastBroadcast = 0;

  function resizeCanvas() {
    W = canvas.width; // keep internal resolution fixed for simplicity
    H = canvas.height;
  }

  function laneX(i) {
    const margin = 60;
    const usable = W - margin * 2;
    const count = Math.max(LANE_COUNT - 1, 1);
    return margin + (usable * i) / count;
  }

  const SHAPES = ['circle', 'square', 'triangle'];
  function shapeFor(index) { return SHAPES[index % SHAPES.length]; }

  // gives each lane a gentle winding drift instead of a dead-straight line —
  // purely visual, based only on distance travelled + lane index, so host
  // and guests always compute the exact same wiggle without needing to sync it
  function wobbleOffset(distanceTraveled, laneIndex) {
    return Math.sin(distanceTraveled * 0.018 + laneIndex * 1.4) * 11;
  }
  function renderXFor(c) {
    const i = characters.indexOf(c);
    const distanceTraveled = (H - START_Y_MARGIN) - c.y;
    return c.x + wobbleOffset(distanceTraveled, i >= 0 ? i : 0);
  }

  // ---------- flower-burst effect (plays when a racer is eliminated) ----------
  function spawnFlowerBurst(x, y, color) {
    const petals = 10;
    const group = [];
    for (let i = 0; i < petals; i++) {
      const angle = (Math.PI * 2 * i) / petals + Math.random() * 0.3;
      const speed = 55 + Math.random() * 55;
      group.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 5 + Math.random() * 4,
        color: THEME.confetti[i % THEME.confetti.length] || color,
        rotation: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 6,
        life: 0,
        maxLife: 0.5 + Math.random() * 0.25
      });
    }
    particleBursts.push(group);
  }

  function updateBursts(dt) {
    for (let bi = particleBursts.length - 1; bi >= 0; bi--) {
      const group = particleBursts[bi];
      let anyAlive = false;
      group.forEach(p => {
        p.life += dt;
        if (p.life < p.maxLife) {
          anyAlive = true;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vx *= 0.94;
          p.vy = p.vy * 0.94 + 40 * dt;
          p.rotation += p.vr * dt;
        }
      });
      if (!anyAlive) particleBursts.splice(bi, 1);
    }
  }

  function drawBursts() {
    particleBursts.forEach(group => {
      group.forEach(p => {
        if (p.life >= p.maxLife) return;
        const alpha = Math.max(0, 1 - p.life / p.maxLife);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    });
    ctx.globalAlpha = 1;
  }

  function randomNumbers(count) {
    // unique 3-digit racer numbers, squid-game style badges
    const used = new Set();
    const out = [];
    while (out.length < count) {
      const n = 100 + Math.floor(Math.random() * 900);
      if (used.has(n)) continue;
      used.add(n);
      out.push(n);
    }
    return out;
  }

  // ================= SOLO MODE =================

  function initSoloCharacters() {
    LANE_COUNT = 5;
    characters = [];
    const numbers = randomNumbers(LANE_COUNT);
    let aiIdx = 0;
    for (let i = 0; i < LANE_COUNT; i++) {
      const isPlayer = i === Math.floor(LANE_COUNT / 2);
      const color = isPlayer ? THEME.player : THEME.ai[aiIdx % THEME.ai.length];
      if (!isPlayer) aiIdx++;
      characters.push({
        id: i,
        isPlayer,
        number: numbers[i],
        shape: shapeFor(i),
        x: laneX(i),
        y: H - START_Y_MARGIN,
        alive: true,
        finished: false,
        moving: false,
        color,
        speed: isPlayer ? PLAYER_SPEED : (AI_SPEED_MIN + Math.random() * (AI_SPEED_MAX - AI_SPEED_MIN)),
        boldness: 0.4 + Math.random() * 0.5,
        reactionMs: 60 + Math.random() * 320,
        aiStopAt: 0,
        aiMoveDecisionAt: 0
      });
    }
    buildScoreboard();
  }

  function updateAI(c, dtMs, now) {
    if (!c.alive || c.finished) { c.moving = false; return; }
    if (lightState === 'green') {
      if (now > c.aiMoveDecisionAt) {
        c.moving = Math.random() < c.boldness;
        c.aiMoveDecisionAt = now + 150 + Math.random() * 250;
      }
    } else {
      if (now >= c.aiStopAt) c.moving = false;
    }
  }

  function step(ts) {
    if (!running || MODE !== 'solo') return;
    if (!lastTs) lastTs = ts;
    const dtMs = Math.min(50, ts - lastTs);
    lastTs = ts;
    const dt = dtMs / 1000;
    const now = performance.now();

    lightTimer += dtMs;
    if (lightTimer >= lightDuration) setLight(nextLightState());

    updateBursts(dt);

    const player = characters.find(c => c.isPlayer);
    if (player.alive && !player.finished) player.moving = movePressed;

    characters.forEach(c => {
      if (!c.alive || c.finished) return;
      if (!c.isPlayer) updateAI(c, dtMs, now);

      if (lightState === 'red' && c.moving) { eliminate(c); return; }

      if (c.moving) {
        c.y -= c.speed * dt;
        if (c.y <= FINISH_Y) markFinished(c);
      }
    });

    draw();
    updateScoreboard();
    requestAnimationFrame(step);
  }

  function startGame() {
    MODE = 'solo';
    loadTheme();
    resizeCanvas();
    initSoloCharacters();
    lightState = null; // so the opening call isn't mistaken for a repeat
    setLight('green');
    running = true;
    lastTs = 0;
    movePressed = false;
    pressMove(false);
    updateEliminatedCount();
    pauseThemeSound();

    showScreen('gameScreen');
    requestAnimationFrame(step);
  }

  function endGame(won) {
    running = false;
    pressMove(false);
    leaderboardEl.innerHTML = '';
    hideWinCelebration();
    if (won) {
      resultTitle.textContent = 'You made it!';
      resultText.textContent = 'You reached the finish line without getting caught moving.';
      showWinCelebration();
    } else {
      resultTitle.textContent = 'Caught you!';
      resultText.textContent = 'You were still moving when the light turned red. Try again.';
    }
    showScreen('endScreen');
  }

  // ================= SHARED: scoreboard, drawing, sound, light =================

  function buildScoreboard() {
    scoreList.innerHTML = '';
    characters.forEach(c => {
      const row = document.createElement('div');
      row.className = 'score-row';
      row.id = 'score-row-' + c.id;
      const label = c.isPlayer ? 'You' : (c.isHost ? 'Host' : 'Racer');
      row.innerHTML =
        '<div class="score-badge shape-' + (c.shape || 'circle') + '" style="background:' + c.color + '">' + c.number + '</div>' +
        '<div class="score-name">' + label + '</div>' +
        '<div class="score-bar-track"><div class="score-bar-fill" id="score-fill-' + c.id + '" style="width:0%"></div></div>' +
        '<div class="score-status" id="score-status-' + c.id + '">Racing</div>';
      scoreList.appendChild(row);
    });
  }

  function updateScoreboard() {
    const total = (H - START_Y_MARGIN) - FINISH_Y;
    characters.forEach(c => {
      const pct = Math.max(0, Math.min(100, ((H - START_Y_MARGIN - c.y) / total) * 100));
      const fill = document.getElementById('score-fill-' + c.id);
      const status = document.getElementById('score-status-' + c.id);
      if (fill) {
        fill.style.width = pct.toFixed(0) + '%';
        fill.classList.toggle('out', !c.alive);
      }
      if (status) {
        status.textContent = !c.alive ? 'OUT' : (c.finished ? 'FINISHED' : Math.round(pct) + '%');
      }
    });
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = THEME.track;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = THEME.laneLine;
    ctx.lineWidth = 1;
    for (let i = 0; i < LANE_COUNT; i++) {
      ctx.beginPath();
      const steps = 36;
      for (let s = 0; s <= steps; s++) {
        const y = (H - 10) - ((H - 20) * s) / steps;
        const distanceTraveled = (H - START_Y_MARGIN) - y;
        const x = laneX(i) + wobbleOffset(distanceTraveled, i);
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.fillStyle = THEME.finish;
    ctx.fillRect(0, FINISH_Y - 4, W, 8);

    characters.forEach(c => {
      const rx = renderXFor(c);
      traceRacerShape(rx, c.y, CHAR_R, c.shape);
      ctx.fillStyle = c.alive ? c.color : THEME.eliminated;
      ctx.globalAlpha = c.alive ? 1 : 0.5;
      ctx.fill();

      if (c.isPlayer) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = THEME.playerOutline;
        traceRacerShape(rx, c.y, CHAR_R, c.shape);
        ctx.stroke();
      }

      if (c.alive) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = THEME.numberText;
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(c.number), rx, c.y + 3);
      } else {
        ctx.globalAlpha = 1;
        ctx.fillStyle = THEME.text;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('OUT', rx, c.y + 4);
      }
      ctx.globalAlpha = 1;
    });

    drawBursts();
  }

  // shapes: 'circle' | 'square' | 'triangle' — each racer gets one, set in shapeFor()
  function traceRacerShape(x, y, r, shape) {
    ctx.beginPath();
    if (shape === 'square') {
      ctx.rect(x - r, y - r, r * 2, r * 2);
    } else if (shape === 'triangle') {
      ctx.moveTo(x, y - r * 1.15);
      ctx.lineTo(x + r * 1.05, y + r * 0.8);
      ctx.lineTo(x - r * 1.05, y + r * 0.8);
      ctx.closePath();
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  let muted = false;

  function playSound(el) {
    if (!el || !el.src || muted) return;
    try {
      el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function playThemeSound() {
    if (muted || !soundTheme || !soundTheme.src) return;
    try {
      const p = soundTheme.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function pauseThemeSound() {
    try { soundTheme && soundTheme.pause(); } catch (e) { /* ignore */ }
  }

  function updateMuteButtons() {
    const icon = muted ? '🔇' : '🔊';
    if (muteBtnGlobal) muteBtnGlobal.textContent = icon;
    if (muteBtnGame) muteBtnGame.textContent = icon;
  }

  function toggleMute() {
    muted = !muted;
    updateMuteButtons();
    if (muted) {
      pauseThemeSound();
    } else if (currentScreen !== 'gameScreen') {
      playThemeSound();
    }
  }

  muteBtnGlobal.addEventListener('click', toggleMute);
  muteBtnGame.addEventListener('click', toggleMute);

  function unlockAudio() {
    [soundRed, soundGreen, soundLost, soundTheme].forEach(el => {
      if (!el || !el.src) return;
      el.play().then(() => el.pause()).catch(() => {});
      el.currentTime = 0;
    });
  }

  function playLightCallSound(state, isRepeatCall) {
    const el = state === 'green' ? soundGreen : soundRed;
    playSound(el);
    if (isRepeatCall) setTimeout(() => playSound(el), 350);
  }

  function setLight(state) {
    const prevState = lightState;
    const isFreshRed = state === 'red' && prevState !== 'red';
    const isRepeatCall = state === prevState;

    lightState = state;
    lightTimer = 0;
    const durFactor = isRepeatCall ? (0.5 + Math.random() * 0.4) : 1;
    lightDuration = (state === 'green'
      ? (GREEN_MIN_MS + Math.random() * (GREEN_MAX_MS - GREEN_MIN_MS))
      : (RED_MIN_MS + Math.random() * (RED_MAX_MS - RED_MIN_MS))) * durFactor;

    if (isFreshRed && MODE === 'solo') {
      const now = performance.now();
      characters.forEach(c => {
        if (!c.isPlayer && c.alive && !c.finished) c.aiStopAt = now + c.reactionMs;
      });
    }

    lightDot.style.background = state === 'green' ? 'var(--color-light-green)' : 'var(--color-light-red)';
    lightDot.style.boxShadow = state === 'green'
      ? '0 0 12px 2px var(--color-light-green)'
      : '0 0 12px 2px var(--color-light-red)';
    lightDot.classList.toggle('danger', state === 'red');

    const baseLabel = state === 'green' ? 'GREEN LIGHT' : 'RED LIGHT';
    lightLabel.textContent = isRepeatCall ? (baseLabel + ', ' + baseLabel + '!') : baseLabel;

    playLightCallSound(state, isRepeatCall);

    if (MODE === 'host') {
      sendToAllGuests({ t: 'light', state, label: lightLabel.textContent, repeat: isRepeatCall });
    }
  }

  function nextLightState() {
    if (Math.random() < REPEAT_CALL_CHANCE) return lightState;
    return lightState === 'green' ? 'red' : 'green';
  }

  function eliminate(c) {
    if (!c.alive) return;
    c.alive = false;
    c.moving = false;
    updateEliminatedCount();
    spawnFlowerBurst(renderXFor(c), c.y, c.color);
    if (MODE === 'solo') {
      if (c.isPlayer) { playSound(soundLost); endGame(false); }
    } else if (MODE === 'host') {
      if (c.isPlayer) playSound(soundLost);
    }
    flashOnce();
  }

  function markFinished(c) {
    if (c.finished) return;
    c.y = FINISH_Y;
    c.finished = true;
    c.moving = false;
    if (MODE === 'solo') {
      if (c.isPlayer) endGame(true);
    } else if (MODE === 'host') {
      finishOrder.push(c);
    }
  }

  function flashOnce() {
    flashEl.style.opacity = '0.35';
    clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => { flashEl.style.opacity = '0'; }, 120);
  }

  function updateEliminatedCount() {
    const out = characters.filter(c => !c.alive).length;
    eliminatedCountEl.textContent = out + ' out';
  }

  // ---------- win celebration (doll + confetti) ----------
  const WIN_LINES = ['Great job!', 'You made it!', 'Well played!', 'Nicely done!'];

  function hideWinCelebration() {
    winCelebration.style.display = 'none';
    confettiLayer.innerHTML = '';
  }

  function showWinCelebration() {
    winSpeechBubble.textContent = WIN_LINES[Math.floor(Math.random() * WIN_LINES.length)];
    winCelebration.style.display = 'flex';
    spawnConfetti();
  }

  function spawnConfetti() {
    confettiLayer.innerHTML = '';
    const colors = ['var(--color-confetti-1)', 'var(--color-confetti-2)', 'var(--color-confetti-3)', 'var(--color-confetti-4)'];
    for (let i = 0; i < 40; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + '%';
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = (1.1 + Math.random() * 1.1) + 's';
      piece.style.animationDelay = (Math.random() * 0.4) + 's';
      confettiLayer.appendChild(piece);
    }
  }

  // ---------- input ----------
  function pressMove(v) {
    movePressed = v;
    moveBtn.classList.toggle('pressed', v);
    if (MODE === 'guest') sendToHost({ t: 'input', moving: v });
  }

  moveBtn.addEventListener('mousedown', () => pressMove(true));
  moveBtn.addEventListener('mouseup', () => pressMove(false));
  moveBtn.addEventListener('mouseleave', () => pressMove(false));
  moveBtn.addEventListener('touchstart', (e) => { e.preventDefault(); pressMove(true); }, { passive: false });
  moveBtn.addEventListener('touchend', (e) => { e.preventDefault(); pressMove(false); }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'KeyW', 'Space'].includes(e.code)) { e.preventDefault(); pressMove(true); }
  });
  window.addEventListener('keyup', (e) => {
    if (['ArrowUp', 'KeyW', 'Space'].includes(e.code)) { e.preventDefault(); pressMove(false); }
  });

  // ================= MULTIPLAYER: NETWORKING =================

  function sendToAllGuests(msg) {
    Object.values(hostConns).forEach(h => { if (h.conn && h.conn.open) h.conn.send(msg); });
  }
  function sendToHost(msg) {
    if (guestConn && guestConn.open) guestConn.send(msg);
  }

  function randomRoomCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
    let s = '';
    for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function ensureUniqueNumber() {
    let n;
    do { n = randomNumbers(1)[0]; } while (lobbyPlayers.some(p => p.number === n));
    return n;
  }

  function teardownNetwork() {
    if (peer) { try { peer.destroy(); } catch (e) {} }
    peer = null; myPeerId = null; guestConn = null; hostConns = {}; lobbyPlayers = []; roomCode = '';
    MODE = 'solo';
  }

  // ---------- HOST ----------
  function startHosting() {
    showScreen('hostLobby');
    roomCodeDisplay.textContent = 'Creating…';
    hostStartBtn.disabled = true;
    attemptCreateHostPeer(0);
  }

  function attemptCreateHostPeer(tries) {
    if (tries > 5) { roomCodeDisplay.textContent = 'Failed — try again'; return; }
    const code = randomRoomCode();
    const id = ROOM_ID_PREFIX + code;
    const p = new Peer(id);

    p.on('open', pid => {
      peer = p; myPeerId = pid; roomCode = code; MODE = 'host';
      roomCodeDisplay.textContent = code;
      lobbyPlayers = [{ peerId: pid, number: randomNumbers(1)[0], isHost: true }];
      renderHostLobbyList();
      p.on('connection', conn => registerGuestConnection(conn));
    });

    p.on('error', err => {
      if (err && err.type === 'unavailable-id') {
        try { p.destroy(); } catch (e) {}
        attemptCreateHostPeer(tries + 1);
      } else {
        roomCodeDisplay.textContent = 'Error — try again';
        console.warn('PeerJS host error', err);
      }
    });
  }

  function registerGuestConnection(conn) {
    conn.on('open', () => {
      const num = ensureUniqueNumber();
      hostConns[conn.peer] = { conn, number: num, moving: false };
      lobbyPlayers.push({ peerId: conn.peer, number: num, isHost: false });
      renderHostLobbyList();
      broadcastLobby();
    });
    conn.on('data', data => handleGuestData(conn.peer, data));
    conn.on('close', () => handleGuestDisconnect(conn.peer));
  }

  function handleGuestData(peerId, data) {
    if (data.t === 'input' && hostConns[peerId]) hostConns[peerId].moving = data.moving;
  }

  function handleGuestDisconnect(peerId) {
    delete hostConns[peerId];
    lobbyPlayers = lobbyPlayers.filter(p => p.peerId !== peerId);
    if (running) {
      const c = characters.find(ch => ch.peerId === peerId);
      if (c && c.alive && !c.finished) { c.alive = false; updateEliminatedCount(); }
    } else {
      renderHostLobbyList();
      broadcastLobby();
    }
  }

  function broadcastLobby() {
    sendToAllGuests({ t: 'lobby', players: lobbyPlayers });
  }

  function buildPlayerRow(p, index) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const label = p.peerId === myPeerId ? 'You' : (p.isHost ? 'Host' : 'Racer ' + p.number);
    row.innerHTML = '<div class="score-badge shape-' + shapeFor(index) + '" style="background:' + colorFor(index) + '">' + p.number + '</div><div>' + label + '</div>';
    return row;
  }

  function renderHostLobbyList() {
    hostPlayerList.innerHTML = '';
    lobbyPlayers.forEach((p, i) => hostPlayerList.appendChild(buildPlayerRow(p, i)));
    hostStartBtn.disabled = lobbyPlayers.length < 1;
  }

  function renderGuestLobbyList() {
    guestPlayerList.innerHTML = '';
    lobbyPlayers.forEach((p, i) => guestPlayerList.appendChild(buildPlayerRow(p, i)));
  }

  function hostStartGame() {
    if (!peer) return;
    resizeCanvas();
    const players = lobbyPlayers.map((p, i) => ({
      peerId: p.peerId, number: p.number, isHost: p.isHost, color: colorFor(i), shape: shapeFor(i)
    }));
    initMultiplayerCharacters(players);
    sendToAllGuests({ t: 'start', players });

    lightState = null;
    running = true;
    lastTs = 0;
    lastBroadcast = 0;
    finishOrder = [];
    movePressed = false;
    pressMove(false);
    updateEliminatedCount();
    pauseThemeSound();
    showScreen('gameScreen');
    setLight('green');
    requestAnimationFrame(hostStep);
  }

  function initMultiplayerCharacters(players) {
    LANE_COUNT = Math.max(2, Math.min(8, players.length));
    characters = players.map((p, i) => ({
      id: p.peerId,
      peerId: p.peerId,
      isPlayer: p.peerId === myPeerId,
      isHost: p.isHost,
      number: p.number,
      shape: p.shape,
      x: laneX(i),
      y: H - START_Y_MARGIN,
      alive: true,
      finished: false,
      moving: false,
      color: p.color
    }));
    buildScoreboard();
  }

  function broadcastState() {
    sendToAllGuests({
      t: 'state',
      eliminatedCount: eliminatedCountEl.textContent,
      characters: characters.map(c => ({
        id: c.id, peerId: c.peerId, number: c.number, color: c.color, shape: c.shape,
        x: c.x, y: c.y, alive: c.alive, finished: c.finished, isHost: c.isHost
      }))
    });
  }

  function hostStep(ts) {
    if (!running || MODE !== 'host') return;
    if (!lastTs) lastTs = ts;
    const dtMs = Math.min(50, ts - lastTs);
    lastTs = ts;
    const dt = dtMs / 1000;

    lightTimer += dtMs;
    if (lightTimer >= lightDuration) setLight(nextLightState());

    updateBursts(dt);

    const me = characters.find(c => c.isPlayer);
    if (me && me.alive && !me.finished) me.moving = movePressed;

    characters.forEach(c => {
      if (!c.alive || c.finished) return;
      if (!c.isPlayer) {
        const h = hostConns[c.peerId];
        c.moving = h ? h.moving : false;
      }
      if (lightState === 'red' && c.moving) { eliminate(c); return; }
      if (c.moving) {
        c.y -= PLAYER_SPEED * dt;
        if (c.y <= FINISH_Y) markFinished(c);
      }
    });

    draw();
    updateScoreboard();

    const now = performance.now();
    if (now - lastBroadcast >= BROADCAST_INTERVAL_MS) { broadcastState(); lastBroadcast = now; }

    if (characters.every(c => !c.alive || c.finished)) { hostEndRound(); return; }

    requestAnimationFrame(hostStep);
  }

  function hostEndRound() {
    running = false;
    pressMove(false);
    const results = [];
    finishOrder.forEach((c, idx) => {
      results.push({ peerId: c.peerId, number: c.number, color: c.color, shape: c.shape, isHost: c.isHost, place: idx + 1, status: 'Finished' });
    });
    characters.filter(c => !c.alive).forEach(c => {
      results.push({ peerId: c.peerId, number: c.number, color: c.color, shape: c.shape, isHost: c.isHost, place: null, status: 'Eliminated' });
    });
    sendToAllGuests({ t: 'end', results });
    renderEndScreen(results);
  }

  // ---------- GUEST ----------
  function setJoinStatus(msg) { joinStatus.textContent = msg; }

  function joinGame(codeRaw) {
    const code = (codeRaw || '').trim().toUpperCase();
    if (code.length < 4) { setJoinStatus('Enter the 4-character room code.'); return; }
    setJoinStatus('Connecting…');

    const p = new Peer();
    p.on('open', pid => {
      peer = p; myPeerId = pid; MODE = 'guest';
      const conn = p.connect(ROOM_ID_PREFIX + code, { reliable: true });
      guestConn = conn;

      conn.on('open', () => { setJoinStatus(''); showScreen('guestLobby'); });
      conn.on('data', data => handleHostData(data));
      conn.on('close', () => { setJoinStatus('Disconnected from host.'); teardownNetwork(); showScreen('joinScreen'); });
      conn.on('error', err => { console.warn('conn error', err); setJoinStatus('Could not connect — check the code.'); });
    });
    p.on('error', err => { console.warn('PeerJS guest error', err); setJoinStatus('Connection error — try again.'); });
  }

  let guestLastTs = 0;
  function guestRenderLoop(ts) {
    if (MODE !== 'guest' || !running) return;
    if (!guestLastTs) guestLastTs = ts;
    const dt = Math.min(50, ts - guestLastTs) / 1000;
    guestLastTs = ts;
    updateBursts(dt);
    draw();
    requestAnimationFrame(guestRenderLoop);
  }

  function handleHostData(data) {
    if (data.t === 'lobby') {
      lobbyPlayers = data.players;
      renderGuestLobbyList();
    } else if (data.t === 'start') {
      loadTheme();
      resizeCanvas();
      LANE_COUNT = Math.max(2, Math.min(8, data.players.length));
      characters = data.players.map((p, i) => ({
        id: p.peerId, peerId: p.peerId, isPlayer: p.peerId === myPeerId, isHost: p.isHost,
        number: p.number, shape: p.shape, x: laneX(i), y: H - START_Y_MARGIN, alive: true, finished: false, color: p.color
      }));
      buildScoreboard();
      running = true;
      movePressed = false;
      pressMove(false);
      updateEliminatedCount();
      pauseThemeSound();
      showScreen('gameScreen');
      guestLastTs = 0;
      requestAnimationFrame(guestRenderLoop);
    } else if (data.t === 'light') {
      lightState = data.state;
      lightDot.style.background = data.state === 'green' ? 'var(--color-light-green)' : 'var(--color-light-red)';
      lightDot.style.boxShadow = data.state === 'green'
        ? '0 0 12px 2px var(--color-light-green)'
        : '0 0 12px 2px var(--color-light-red)';
      lightDot.classList.toggle('danger', data.state === 'red');
      lightLabel.textContent = data.label;
      playLightCallSound(data.state, data.repeat);
    } else if (data.t === 'state') {
      const prevAliveById = {};
      characters.forEach(c => { prevAliveById[c.id] = c.alive; });
      const newChars = data.characters.map(c => Object.assign({}, c, { isPlayer: c.peerId === myPeerId }));
      newChars.forEach((c, i) => {
        if (prevAliveById[c.id] === true && c.alive === false) {
          const distanceTraveled = (H - START_Y_MARGIN) - c.y;
          const rx = c.x + wobbleOffset(distanceTraveled, i);
          spawnFlowerBurst(rx, c.y, c.color);
          if (c.isPlayer) { playSound(soundLost); flashOnce(); }
        }
      });
      characters = newChars;
      eliminatedCountEl.textContent = data.eliminatedCount;
      updateScoreboard();
    } else if (data.t === 'end') {
      renderEndScreen(data.results);
    }
  }

  // ---------- shared multiplayer end screen ----------
  function renderEndScreen(results) {
    running = false;
    leaderboardEl.innerHTML = '';
    hideWinCelebration();
    const mine = results.find(r => r.peerId === myPeerId);
    if (mine && mine.status === 'Finished' && mine.place === 1) {
      resultTitle.textContent = 'You won the round!';
      showWinCelebration();
    } else if (mine && mine.status === 'Finished') {
      resultTitle.textContent = 'You finished — place ' + mine.place;
    } else {
      resultTitle.textContent = 'You were eliminated';
    }
    resultText.textContent = 'Final results for this room:';

    results.forEach(r => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row' + (r.peerId === myPeerId ? ' lb-me' : '');
      const name = r.peerId === myPeerId ? 'You' : (r.isHost ? 'Host' : 'Racer ' + r.number);
      row.innerHTML =
        '<span class="lb-place">' + (r.place ? ('#' + r.place) : '—') + '</span>' +
        '<span class="score-badge shape-' + (r.shape || 'circle') + '" style="background:' + r.color + '">' + r.number + '</span>' +
        '<span class="lb-name">' + name + '</span>' +
        '<span class="lb-status">' + r.status + '</span>';
      leaderboardEl.appendChild(row);
    });

    showScreen('endScreen');
  }

  // ================= UI WIRING =================

  function setShareStatus(msg) {
    shareStatusEl.textContent = msg;
    setTimeout(() => { if (shareStatusEl.textContent === msg) shareStatusEl.textContent = ''; }, 2500);
  }

  shareCodeBtn.addEventListener('click', async () => {
    const link = location.origin + location.pathname + '?join=' + roomCode;
    const text = 'Join my Red Light, Green Light game! Room code: ' + roomCode;
    if (navigator.share) {
      try { await navigator.share({ title: 'Red Light, Green Light', text, url: link }); }
      catch (e) { /* user cancelled the share sheet, ignore */ }
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text + ' ' + link);
        setShareStatus('Copied to clipboard!');
      } catch (e) { setShareStatus('Room code: ' + roomCode); }
    } else {
      setShareStatus('Room code: ' + roomCode);
    }
  });

  document.getElementById('soloBtn').addEventListener('click', () => {
    unlockAudio(); teardownNetwork(); MODE = 'solo'; showScreen('startScreen'); playThemeSound();
  });
  document.getElementById('hostBtn').addEventListener('click', () => {
    unlockAudio(); teardownNetwork(); startHosting(); playThemeSound();
  });
  document.getElementById('joinBtn').addEventListener('click', () => {
    unlockAudio(); teardownNetwork(); joinCodeInput.value = ''; setJoinStatus(''); showScreen('joinScreen'); playThemeSound();
  });
  hostStartBtn.addEventListener('click', () => { unlockAudio(); hostStartGame(); });
  document.getElementById('hostCancelBtn').addEventListener('click', () => { teardownNetwork(); showScreen('modeScreen'); });
  document.getElementById('joinConnectBtn').addEventListener('click', () => { unlockAudio(); joinGame(joinCodeInput.value); });
  document.getElementById('joinCancelBtn').addEventListener('click', () => { teardownNetwork(); showScreen('modeScreen'); });

  startBtn.addEventListener('click', () => { unlockAudio(); startGame(); });

  restartBtn.addEventListener('click', () => {
    if (MODE === 'solo') { startGame(); }
    else { teardownNetwork(); showScreen('modeScreen'); playThemeSound(); }
  });

  showScreen('modeScreen');
  updateMuteButtons();
  playThemeSound(); // best effort — browsers may block this until the first tap/click, unlockAudio() covers that

  // if this page was opened from a shared invite link (?join=CODE), jump straight to Join
  const urlParams = new URLSearchParams(location.search);
  const invitedCode = urlParams.get('join');
  if (invitedCode) {
    teardownNetwork();
    joinCodeInput.value = invitedCode.toUpperCase();
    setJoinStatus('Code filled in from your invite link — tap Connect.');
    showScreen('joinScreen');
  }

})();
