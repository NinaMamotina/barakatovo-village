const el = (id) => document.getElementById(id);

const dbToVol = (db) => Math.pow(10, db / 20);

// master audio bus: every sound in the game passes through a gentle limiter
// so nothing spikes or clips; voice lines additionally get a rumble cut + leveling
let masterCtx = null;
let masterLimiter = null;
let voiceBus = null;
let narratorBus = null;
const routedNodes = new WeakMap();

// a short synthetic decay (no impulse-response file needed) for a subtle
// sense of a small room around the narrator lines
function makeReverbImpulse(ctx, duration, decay) {
  const rate = ctx.sampleRate;
  const length = Math.round(rate * duration);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function ensureMasterBus() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!masterCtx) {
    masterCtx = new AC();
    masterLimiter = masterCtx.createDynamicsCompressor();
    masterLimiter.threshold.value = -16;
    masterLimiter.knee.value = 18;
    masterLimiter.ratio.value = 5;
    masterLimiter.attack.value = 0.006;
    masterLimiter.release.value = 0.25;
    masterLimiter.connect(masterCtx.destination);

    const voiceHighpass = masterCtx.createBiquadFilter();
    voiceHighpass.type = 'highpass';
    voiceHighpass.frequency.value = 90;
    const voiceCompressor = masterCtx.createDynamicsCompressor();
    voiceCompressor.threshold.value = -24;
    voiceCompressor.knee.value = 30;
    voiceCompressor.ratio.value = 4;
    voiceCompressor.attack.value = 0.01;
    voiceCompressor.release.value = 0.25;
    voiceHighpass.connect(voiceCompressor);
    voiceCompressor.connect(masterLimiter);
    voiceBus = voiceHighpass;

    // narrator lines: same leveling as voice, plus a light reverb send for atmosphere
    const narratorHighpass = masterCtx.createBiquadFilter();
    narratorHighpass.type = 'highpass';
    narratorHighpass.frequency.value = 90;
    const narratorCompressor = masterCtx.createDynamicsCompressor();
    narratorCompressor.threshold.value = -24;
    narratorCompressor.knee.value = 30;
    narratorCompressor.ratio.value = 4;
    narratorCompressor.attack.value = 0.01;
    narratorCompressor.release.value = 0.25;
    const narratorDry = masterCtx.createGain();
    narratorDry.gain.value = 1;
    const narratorWet = masterCtx.createGain();
    narratorWet.gain.value = 0.2; // subtle — atmosphere, not an echo chamber
    const narratorConvolver = masterCtx.createConvolver();
    narratorConvolver.buffer = makeReverbImpulse(masterCtx, 1.1, 3.2);
    narratorHighpass.connect(narratorCompressor);
    narratorCompressor.connect(narratorDry);
    narratorCompressor.connect(narratorConvolver);
    narratorConvolver.connect(narratorWet);
    narratorDry.connect(masterLimiter);
    narratorWet.connect(masterLimiter);
    narratorBus = narratorHighpass;
  }
  if (masterCtx.state === 'suspended') masterCtx.resume();
  return masterCtx;
}
function routeToMaster(audioEl, bus) {
  const ctx = ensureMasterBus();
  if (!ctx) return;
  if (routedNodes.has(audioEl)) return;
  const source = ctx.createMediaElementSource(audioEl);
  const target = bus === 'narrator' ? narratorBus : bus ? voiceBus : masterLimiter;
  source.connect(target);
  routedNodes.set(audioEl, source);
}

// the computer's running hum loops while it is switched on and the player is
// looking at its closeup; leaving to the wider view or switching it off stops it.
// Played from a decoded buffer so the loop point is truly gapless.
// the nasheed that plays after Nor leaves the bathroom steps aside while the
// player is at the computer closeup (fading out, not cutting), and fades back in
// from the same spot afterwards
let nasheedPausedForComputer = false;
let nasheedFadeTimer = null;
function fadeAudioVolume(audio, toVol, ms, done) {
  clearInterval(nasheedFadeTimer);
  const fromVol = audio.volume;
  const t0 = performance.now();
  nasheedFadeTimer = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    audio.volume = Math.max(0, Math.min(1, fromVol + (toVol - fromVol) * k));
    if (k >= 1) {
      clearInterval(nasheedFadeTimer);
      if (done) done();
    }
  }, 40);
}
function updateNasheedForComputer(name) {
  const nasheed = el('audio-nasheed');
  if (name === 'computer') {
    if (!nasheed.paused && !nasheedPausedForComputer) {
      nasheedPausedForComputer = true;
      fadeAudioVolume(nasheed, 0, 700, () => nasheed.pause());
    }
  } else if (nasheedPausedForComputer) {
    nasheedPausedForComputer = false;
    routeToMaster(nasheed, false);
    if (nasheed.paused) {
      nasheed.volume = 0;
      nasheed.play();
    }
    fadeAudioVolume(nasheed, dbToVol(-16), 1000);
  }
}

let computerHumTimer = null;
let humBuffer = null;
let humBufferLoading = false;
let humSource = null;
let humGain = null;

function humShouldPlay() {
  const active = document.querySelector('.screen.active');
  // either video (compass or cats) playing takes over the sound
  const videoPlaying = ['computer-video', 'computer-window-video'].some(id => {
    const v = el(id);
    return v && !v.paused && !v.ended;
  });
  return !!(state.computerOn && active && active.id === 'scene-computer' && !videoPlaying);
}
function stopHum() {
  if (!humSource) return;
  // fade out instead of cutting, then release the nodes
  const src = humSource, gain = humGain, ctx = masterCtx;
  humSource = null;
  humGain = null;
  gain.gain.cancelScheduledValues(ctx.currentTime);
  gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
  setTimeout(() => {
    try { src.stop(); } catch (e) {}
    src.disconnect();
    gain.disconnect();
  }, 600);
}
function startHum() {
  if (humSource) return;
  const ctx = ensureMasterBus();
  if (!ctx) return;
  if (!humBuffer) {
    if (humBufferLoading) return;
    humBufferLoading = true;
    fetch('assets/audio/computer-hum-loop.wav?v=1')
      .then(r => r.arrayBuffer())
      .then(buf => new Promise((res, rej) => ctx.decodeAudioData(buf, res, rej)))
      .then(decoded => { humBuffer = decoded; humBufferLoading = false; updateComputerHum(); })
      .catch(() => { humBufferLoading = false; });
    return;
  }
  humSource = ctx.createBufferSource();
  humSource.buffer = humBuffer;
  humSource.loop = true;
  humGain = ctx.createGain();
  humGain.gain.value = 0;
  humGain.gain.linearRampToValueAtTime(dbToVol(-12), ctx.currentTime + 0.6);
  humSource.connect(humGain);
  humGain.connect(masterLimiter);
  humSource.start(0);
}
function updateComputerHum() {
  if (humShouldPlay()) startHum();
  else stopHum();
}

['computer-video', 'computer-window-video'].forEach(id => {
  const v = el(id);
  if (!v) return;
  ['play', 'playing', 'pause', 'ended'].forEach(ev => v.addEventListener(ev, () => updateComputerHum()));
});

// the "how does a compass work?" result appears in the search list as soon as
// Nor has asked for it — no need to close and reopen the search first
function syncCompassSuggestion() {
  el('search-suggestion-compass').classList.toggle('hidden', !state.compassHintGiven);
}

// every tap inside the computer screen (icons, search, results, back/close, video buttons)
function playComputerClick() {
  playSfx(el('audio-computer-click'), -6);
}

function playSfx(audioEl, db, startAt) {
  routeToMaster(audioEl, false);
  audioEl.currentTime = startAt || 0;
  audioEl.volume = dbToVol(db);
  audioEl.play();
}

const state = {
  hour: 12,
  minute: 0,
  clockCorrect: false,
  clockLoopBg: false, // true once the ambient tick-tock has dropped to -20dB for good
  window: 'closed', // closed -> open -> mosque
  bed: 'sleeping',  // sleeping -> getup -> fixed
  norAwake: false,
  norGreeted: false, // true once she's said her wudu/namaz line
  norSeenInBath: false, // true once the player has opened the bathroom door at least once
  cardsSolved: false,
  norLeftBath: false, // true once the wash cutscene finishes — Nor has stepped out
  norOutfitStage: 0, // how many NOR_OUTFIT_SEQUENCE steps she's dressed so far, in order
  readyForNamaz: false, // true once she's fully dressed and said it's time to pray — unlocks room3/room4
  norRoom4Shown: false, // true once Nor has appeared by the door in room4 after the carpet was found
  carpetPlaced: false, // true once the carpet has been dragged onto the floor between the door and the nightstand
  hintsFound: { kibla: false, compass: false, south: false }, // which of the 3 direction hints the player has already seen
  computerOn: false, // toggled by the power button — reflected on both the far view and the closeup
  videoOpened: false, // true once the correct search result has been picked, opening the compass video
  searchOpened: false, // true once the internet icon has been clicked, showing the search bar
  compassHintGiven: false, // true once Nor has said she needs to look up how the compass works
  compassWallLines: { room: false, room2: false, room3: false }, // walls where Nor has already said where north is
  compassIntroDone: false, // true once Nor has explained how to look for south after the compass first opens
  compassOpenLineDone: false, // true once Nor has said "now you can open the compass" after both hints were found
  inventory: [],
  talking: false,
};

const TARGET_HOUR = 5;
const TARGET_MINUTE = 30;
const MINUTE_STEP = 5;

// ---------------- save / resume progress ----------------

const SAVE_KEY = 'barakatovo-progress-v1';
const SAVED_FIELDS = [
  'hour', 'minute', 'clockCorrect', 'window', 'bed', 'norAwake',
  'norGreeted', 'norSeenInBath', 'cardsSolved', 'norLeftBath',
  'norOutfitStage', 'readyForNamaz', 'inventory', 'norRoom4Shown',
  'carpetPlaced', 'hintsFound', 'computerOn', 'videoOpened', 'searchOpened',
  'compassHintGiven', 'compassOpenLineDone', 'compassIntroDone', 'compassWallLines',
];

function saveProgress() {
  try {
    const data = {};
    SAVED_FIELDS.forEach(k => { data[k] = state[k]; });
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (e) {
    // storage unavailable (private mode / quota) — progress just won't persist
  }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    SAVED_FIELDS.forEach(k => {
      if (k in data) state[k] = data[k];
    });
    return true;
  } catch (e) {
    return false;
  }
}

// redresses Nor to whatever sprite matches her saved outfit stage, without
// replaying any of the dressing dialogue/audio
function redressSrcForStage(stage) {
  if (stage <= 0) return 'assets/img/redress/redress-1.webp?v=1';
  const itemId = NOR_OUTFIT_SEQUENCE[stage - 1];
  return NOR_OUTFIT_STEPS[itemId].src;
}

// world sprite + hit button for every item collectItem() can pick up, so a
// restored save can hide whatever's already in the inventory (otherwise the
// item's picture sits back in the room looking uncollected after a reload
// or a language switch, even though it's already in the inventory bar)
const ITEM_WORLD_ELEMENTS = {
  hijab: { imgElId: 'hijab-img', hitElId: 'hit-hijab' },
  dress: { imgElId: 'dress-img', hitElId: 'hit-dress' },
  socks: { imgElId: 'socks-img', hitElId: 'hit-socks' },
  bag: { imgElId: 'bag-img', hitElId: 'hit-bag' },
  boots: { imgElId: 'boots-img', hitElId: 'hit-boots' },
  carpet: { imgElId: 'carpet-img', hitElId: 'hit-carpet' },
  // the compass also sits in plain view on top of the nightstand in the
  // room4 wide shot, not just the tumbochka-top closeup — both need to
  // disappear once it's collected, and stay gone after a reload
  compass: { imgElId: 'compas-big-img', hitElId: 'hit-compas-big', extraImgElId: 'compas-on-tumbochka-img' },
};

function hideWorldSprite(id) {
  const spot = ITEM_WORLD_ELEMENTS[id];
  if (!spot) return;
  const itemImg = el(spot.imgElId);
  if (itemImg) itemImg.style.opacity = '0';
  const hitBtn = el(spot.hitElId);
  if (hitBtn) hitBtn.classList.add('hidden');
  if (spot.extraImgElId) {
    const extraImg = el(spot.extraImgElId);
    if (extraImg) extraImg.style.opacity = '0';
  }
}

function restoreCollectedItemSprites() {
  state.inventory.forEach(({ id }) => hideWorldSprite(id));
  // worn clothes leave the inventory (removeInventoryItem), but their
  // wardrobe sprite must stay gone too — otherwise reloading the page (or
  // switching language, which reloads a fresh copy of the page) brings
  // already-worn items back into view in the wardrobe
  NOR_OUTFIT_SEQUENCE.forEach((id, i) => {
    if (i < state.norOutfitStage) hideWorldSprite(id);
  });
}

// re-derives every visual from the restored state — always resumes on the
// room screen (the stable hub) rather than mid-puzzle or mid-animation
function applyLoadedState() {
  // a carpet still sitting in the inventory can't have been placed yet
  if (state.inventory.some(it => it.id === 'carpet')) state.carpetPlaced = false;
  updateBedSprite();
  updateWindowVisual();
  updateClockVisuals();
  updateClockIconHands();
  renderInventory();
  restoreCollectedItemSprites();
  updateRoom4Access();

  // a restored save means the "puzzle just solved" celebration already
  // happened in an earlier session — from now on the tick-tock should only
  // ever resume quietly in the background, never replay at full volume
  if (state.clockCorrect) {
    state.clockLoopBg = true;
    el('audio-clock-loop').volume = dbToVol(-20);
  }

  if (state.norAwake) {
    wakeNor();
    if (state.norGreeted) {
      el('nor-box').classList.add('hidden');
      el('hit-nor').classList.add('hidden');
    }
  }

  updateBathVisual();

  if (state.norLeftBath) {
    el('nor-redress-img').src = redressSrcForStage(state.norOutfitStage);
    el('nor-redress-img').classList.remove('hidden');
  }

  if (state.norRoom4Shown) {
    el('nor-redress-img').classList.add('hidden');
    el('nor-room4-img').classList.remove('hidden');
  }

  if (state.carpetPlaced) {
    el('carpet-placed-img').classList.remove('hidden');
    el('hints-wrap').classList.remove('hidden');
  }

  updateComputerVisual();

  updateHintsUI();
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  // the inventory only stays hidden on the opening cutscene; any other screen (e.g. a debug jump) brings it back
  if (name !== 'intro') el('inventory-wrap').classList.remove('hidden');
  el('scene-' + name).classList.add('active');
  updateClockLoopForScreen(name);
  updateBathAmbience(name);
  updateComputerHum();
  updateNasheedForComputer(name);
  syncCompassSuggestion();
  saveProgress();
  const wall = COMPASS_WALL_OF_SCREEN[name];
  if (wall) {
    compassWall = wall;
    updateCompassImage();
  }
  updateNorFollow();
  // in closeups (board, drawer, computer...) the compass steps aside: its corner arrow would sit on the usual back button
  el('compass-overlay').classList.toggle('compass-suspended', !['room', 'room2', 'room3', 'room4'].includes(name));
  if (['room', 'room2', 'room3', 'room4'].includes(name) && !el('compass-overlay').classList.contains('hidden')) setTimeout(onCompassWallArrival, 350);
  if (name === 'room4') setTimeout(maybePlayCompassOpenLine, 400);
  if (name === 'room4') setTimeout(maybePlayCompassIntro, 600);
}

// once both direction hints are known and the player is back in the room view
// where Nor stands, she says by herself that the compass can be opened now;
// waits for any line she is still speaking, and only ever happens once
// the compass needle follows which wall of the room the player is facing:
// room4 (door wall) faces west, then turning right: room (bed) north,
// room2 east, room3 south — each wall has its own drawing
const COMPASS_BY_WALL = {
  room: 'assets/img/room4/compass-room.webp?v=2',
  room2: 'assets/img/room4/compass-room2.webp?v=2',
  room3: 'assets/img/room4/compass-room3.webp?v=2',
  room4: 'assets/img/room4/compass-room4.webp?v=2',
};
Object.values(COMPASS_BY_WALL).forEach(src => { new Image().src = src; });
// closeups and side rooms keep the compass of the wall they belong to, so
// jumping straight into one (or leaving the bathroom) never shows a wrong needle
const COMPASS_WALL_OF_SCREEN = {
  room: 'room', window: 'room', clock: 'room', schedule: 'room',
  room2: 'room2', wardrobe: 'room2', mirror: 'room2', bath: 'room2', cards: 'room2',
  room3: 'room3', computer: 'room3',
  room4: 'room4', board: 'room4', 'tumbochka-drawer': 'room4', 'tumbochka-top': 'room4',
};
let compassWall = 'room4';
// while Nor's compass demonstration runs the needle is driven by the animation, not by the wall
let compassLock = false;
function updateCompassImage() {
  if (compassLock) return;
  el('compass-overlay-img').src = COMPASS_BY_WALL[compassWall];
}
let compassOverlayOpenedAt = 0;
function openCompassOverlay() {
  playSfx(el('audio-move'), -12);
  compassOverlayOpenedAt = Date.now();
  updateCompassImage();
  el('compass-overlay').classList.remove('hidden');
  Object.keys(COMPASS_SFX_URLS).forEach(loadCompassSfx);
  updateNorFollow();
  if (state.compassIntroDone && !compassDemoRunning) onCompassWallArrival();
  maybePlayCompassIntro();
}

// the first time the compass opens, in the room view where Nor stands, she
// explains how to look for south (if it opened elsewhere, it waits until she is back)
function maybePlayCompassIntro() {
  if (state.compassIntroDone || el('compass-overlay').classList.contains('hidden')) return;
  const active = document.querySelector('.screen.active');
  if (!state.norRoom4Shown || !active || active.id !== 'scene-room4') return;
  state.compassIntroDone = true;
  saveProgress();
  runCompassDemo();
}

// Nor's demonstration: the needle spins fast while she explains, slows down while she
// holds the compass still, then settles with the red end on the right and she asks which
// side of the world she is facing — with the four answers popping up over the compass
const COMPASS_SPIN_ORDER = ['room', 'room2', 'room3', 'room4']; // red end: up, left, down, right
let compassDemoTimers = [];
let compassDemoRunning = false;
function compassDemoLater(fn, ms) {
  compassDemoTimers.push(setTimeout(fn, ms));
}

// short sounds for the compass, played from decoded buffers so rapid ticks stay crisp
const COMPASS_SFX_URLS = {
  tick: 'assets/audio/compass-tick.m4a?v=1',
  plip1: 'assets/audio/compass-plip1.m4a?v=1',
  plip2: 'assets/audio/compass-plip2.m4a?v=1',
  plip3: 'assets/audio/compass-plip3.m4a?v=1',
  plip4: 'assets/audio/compass-plip4.m4a?v=1',
};
const compassSfxBuffers = {};
const compassSfxLoading = {};
function loadCompassSfx(name) {
  const ctx = ensureMasterBus();
  if (!ctx || compassSfxBuffers[name] || compassSfxLoading[name]) return;
  compassSfxLoading[name] = true;
  fetch(COMPASS_SFX_URLS[name])
    .then(r => r.arrayBuffer())
    .then(b => new Promise((res, rej) => ctx.decodeAudioData(b, res, rej)))
    .then(d => { compassSfxBuffers[name] = d; })
    .catch(() => { compassSfxLoading[name] = false; });
}
function playCompassSfx(name, db) {
  const ctx = ensureMasterBus();
  if (!ctx) return;
  const buf = compassSfxBuffers[name];
  if (!buf) { loadCompassSfx(name); return; }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = dbToVol(db);
  src.connect(g);
  g.connect(masterLimiter);
  src.start(0);
}

// every needle step of the spin ticks like a roulette wheel
function setCompassFrame(wall) {
  el('compass-overlay-img').src = COMPASS_BY_WALL[wall];
  playCompassSfx('tick', -14);
}

// Nor stands at the left of every wall while the compass is open; her words there
// use one shared bubble (the per-room bubbles only exist inside their own rooms)
let compassBubbleTimer = null;
function showCompassBubble(text, ms) {
  clearTimeout(compassBubbleTimer);
  el('compass-bubble-text').textContent = text;
  el('compass-bubble').classList.remove('hidden');
  compassBubbleTimer = setTimeout(() => el('compass-bubble').classList.add('hidden'), ms || 8000);
}
function hideCompassBubble() {
  clearTimeout(compassBubbleTimer);
  el('compass-bubble').classList.add('hidden');
}
const COMPASS_WALL_SCREENS = ['scene-room', 'scene-room2', 'scene-room3'];
function updateNorFollow() {
  const active = document.querySelector('.screen.active');
  const open = !el('compass-overlay').classList.contains('hidden');
  const show = open && state.norRoom4Shown && active && COMPASS_WALL_SCREENS.includes(active.id);
  el('nor-follow-img').classList.toggle('hidden', !show);
}

// the four answers: the player stands at each wall, reads the needle and says which
// side of the world it faces; only once all four walls are answered does Nor tell
// whether they were right
const COMPASS_TRUTH = { room4: 'west', room: 'north', room2: 'east', room3: 'south' };
let compassAnswers = { room: null, room2: null, room3: null, room4: null };
function refreshDirButtons() {
  document.querySelectorAll('.compass-dir-btn').forEach(b => {
    const d = b.dataset.dir;
    b.classList.toggle('selected', compassAnswers[compassWall] === d);
    b.classList.toggle('used', Object.keys(compassAnswers).some(w => w !== compassWall && compassAnswers[w] === d));
  });
}
function showDirButtons() {
  el('compass-dir-buttons').classList.remove('hidden');
  const btns = [...document.querySelectorAll('.compass-dir-btn')];
  btns.forEach(b => b.classList.remove('shown'));
  btns.forEach((b, k) => {
    compassDemoLater(() => {
      b.classList.add('shown');
      playCompassSfx('plip' + (k + 1), -26);
    }, 250 + k * 180);
  });
  refreshDirButtons();
}
function cancelCompassDemo() {
  compassDemoTimers.forEach(clearTimeout);
  compassDemoTimers = [];
  compassDemoRunning = false;
  compassLock = false;
  hideCompassBubble();
  el('compass-dir-buttons').classList.add('hidden');
  document.querySelectorAll('.compass-dir-btn').forEach(b => b.classList.remove('shown'));
}
function evaluateCompassAnswers() {
  const walls = Object.keys(COMPASS_TRUTH);
  if (!walls.every(w => compassAnswers[w])) return;
  const ok = walls.every(w => compassAnswers[w] === COMPASS_TRUTH[w]);
  if (ok) {
    showCompassBubble('Получилось! Теперь я знаю: компьютер — это юг!', 8000);
    if (!state.hintsFound.south) {
      state.hintsFound.south = true;
      updateHintsUI();
      playSfx(el('audio-puzzlesolved'), -16);
      saveProgress();
    }
  } else {
    showCompassBubble('Хмм, кажется, я ошиблась. Ничего страшного — давай начнём сначала и всё проверим ещё раз!', 4500);
    compassDemoLater(restartCompassPuzzle, 4700);
  }
}

// a wrong set of answers: the screen fades to black, the room is back at the door wall,
// and the compass part starts over from "holding the compass steady"
function restartCompassPuzzle() {
  cancelCompassDemo();
  compassDemoRunning = true;
  compassAnswers = { room: null, room2: null, room3: null, room4: null };
  el('compass-fade').classList.add('on');
  compassDemoLater(() => {
    el('compass-dir-buttons').classList.add('hidden');
    hideCompassBubble();
    showScreen('room4');
    compassWall = 'room4';
    compassLock = true;
    el('compass-overlay-img').src = COMPASS_BY_WALL.room4;
    el('compass-fade').classList.remove('on');
  }, 700);
  compassDemoLater(() => runCompassDemo(true), 1500);
}

// what Nor says the first time she stands at each wall: where north is, and then
// which side of the world she is facing
const COMPASS_WALL_LINES = {
  room: 'Здесь красная стрелка смотрит прямо вперёд — туда, где север. А какая сторона света тогда передо мной?',
  room2: 'А здесь красная стрелка показывает влево, значит север слева от меня. Какая же сторона света тогда передо мной?',
  room3: 'А здесь север оказался на противоположной стене! Тогда какая же сторона света передо мной?',
};
// arriving at another wall with the compass open: the answers pop up again, and the
// first time at each wall Nor says where north is
function onCompassWallArrival() {
  if (el('compass-overlay').classList.contains('hidden') || compassDemoRunning || !state.compassIntroDone) return;
  showDirButtons();
  const line = COMPASS_WALL_LINES[compassWall];
  if (line && !state.compassWallLines[compassWall]) {
    state.compassWallLines[compassWall] = true;
    saveProgress();
    showCompassBubble(line, 9000);
  }
}

function runCompassDemo(restart) {
  cancelCompassDemo();
  compassLock = true;
  compassDemoRunning = true;
  Object.keys(COMPASS_SFX_URLS).forEach(loadCompassSfx);
  const line1 = 'Моя комната — квадрат, и у неё четыре стороны. Переходи от одной к другой стрелочками справа и слева. Давай найдём, с какой стороны юг!';
  const line2 = 'Так, держу компас ровно, как показывали в видео.';
  const line3 = 'Ага, красная стрелка справа, значит и северный полюс тоже справа. А какая часть света тогда передо мной?';
  // on a restart the first explanation is skipped: only a short fast spin, then line 2
  const T1 = restart ? 0 : 12000, T2 = 5500, T3 = 9500;
  let i = 0;
  if (!restart) {
    playRoom4Dialogue(line1, null, T1);
    // fast spin for the whole first line
    for (let t = 0; t < T1; t += 90) {
      compassDemoLater(() => setCompassFrame(COMPASS_SPIN_ORDER[i++ % 4]), t);
    }
  }
  // second line: the spin slows down (gaps grow)
  compassDemoLater(() => {
    playRoom4Dialogue(line2, null, T2);
    let t = 0, gap = 110;
    if (restart) {
      for (; t < 1200; t += 90) compassDemoLater(() => setCompassFrame(COMPASS_SPIN_ORDER[i++ % 4]), t);
    }
    while (t < T2 - 700) {
      compassDemoLater(() => setCompassFrame(COMPASS_SPIN_ORDER[i++ % 4]), t);
      t += gap;
      gap = Math.round(gap * 1.28);
    }
  }, T1);
  // third line: settled with the red end on the right, then the four answers
  compassDemoLater(() => {
    el('compass-overlay-img').src = COMPASS_BY_WALL.room4;
    compassWall = 'room4';
    compassLock = false;
    compassDemoRunning = false;
    playRoom4Dialogue(line3, null, T3);
    lastRoom4Line = { text: line3, audioId: null };
    showDirButtons();
  }, T1 + T2);
}
document.querySelectorAll('.compass-dir-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    playSfx(el('audio-buttonclick'), -8);
    const d = btn.dataset.dir;
    Object.keys(compassAnswers).forEach(w => { if (compassAnswers[w] === d) compassAnswers[w] = null; });
    compassAnswers[compassWall] = d;
    refreshDirButtons();
    evaluateCompassAnswers();
  });
});
function closeCompassOverlay() {
  playSfx(el('audio-move'), -12);
  cancelCompassDemo();
  el('compass-overlay').classList.add('hidden');
  updateNorFollow();
}
el('compass-overlay-img').addEventListener('click', () => {
  // the tap that picked the compass up also ends with a click — ignore it
  if (Date.now() - compassOverlayOpenedAt < 400) return;
  closeCompassOverlay();
});
el('compass-close-btn').addEventListener('click', closeCompassOverlay);

function maybePlayCompassOpenLine() {
  if (state.compassOpenLineDone) return;
  if (!state.hintsFound.kibla || !state.hintsFound.compass) return;
  if (!state.norRoom4Shown) return;
  if (document.querySelector('.screen.active').id !== 'scene-room4') return;
  if (!el('room4-dialogue').classList.contains('hidden')) {
    setTimeout(maybePlayCompassOpenLine, 800);
    return;
  }
  state.compassOpenLineDone = true;
  saveProgress();
  const text = 'Теперь можно открыть компас.';
  playRoom4Dialogue(text, el('audio-nor32'));
  lastRoom4Line = { text, audioId: 'audio-nor32' };
}

// ambient bathroom loop: plays across the whole wudu experience (bath, cards,
// wash cutscene) regardless of whether Nor is there, stops the moment the
// player steps back out into the rest of the house
const BATH_AMBIENCE_SCREENS = ['bath', 'cutscene'];
function updateBathAmbience(name) {
  const amb = el('audio-bathroom-amb');
  if (BATH_AMBIENCE_SCREENS.includes(name)) {
    if (amb.paused) {
      routeToMaster(amb, false);
      amb.volume = dbToVol(-8);
      amb.play();
    }
  } else if (!amb.paused) {
    amb.pause();
    amb.currentTime = 0;
  }
}

// the ambient clock tick-tock (once started) goes quiet in the bathroom and
// resumes anywhere else in the house
function updateClockLoopForScreen(name) {
  if (!state.clockCorrect) return;
  const loop = el('audio-clock-loop');
  if (loop.ended) return; // played through once already, stays quiet for good
  if (name === 'bath' || name === 'cards' || name === 'cutscene') {
    if (!loop.paused) loop.pause();
  } else if (loop.paused) {
    routeToMaster(loop, false);
    loop.play();
  }
}

function flashHint(text, duration = 2200) {
  const hint = el('hint');
  hint.textContent = text;
  hint.classList.add('show');
  clearTimeout(flashHint._t);
  flashHint._t = setTimeout(() => hint.classList.remove('show'), duration);
}

// ---------------- dialogue ----------------

const NOR_IDLE_SRC = 'assets/img/redress/redress-1.webp?v=1';

// tracks whichever playLine() is currently talking, so a second tap on Nor
// can cut it short instead of only ever blocking while state.talking is true
let currentLineAudio = null;
let currentLineFinish = null;

// whichever dialogue box anywhere in the game is currently showing/talking —
// starting any new line (from this box or any other) stops this one first,
// so lines never overlap each other
let activeDialogueStop = null;

function playLine(audioEl, text, pose) {
  if (activeDialogueStop) activeDialogueStop();
  state.talking = true;
  if (pose) el('nor-img').src = pose;
  el('dialogue').classList.remove('hidden');
  el('dialogue-text').textContent = text;
  routeToMaster(audioEl, true);
  audioEl.currentTime = 0;
  audioEl.volume = dbToVol(0);
  audioEl.play();

  const finish = () => {
    state.talking = false;
    el('dialogue').classList.add('hidden');
    el('nor-img').src = NOR_IDLE_SRC;
    audioEl.removeEventListener('ended', finish);
    currentLineAudio = null;
    currentLineFinish = null;
    if (activeDialogueStop === stopCurrentLine) activeDialogueStop = null;
  };
  audioEl.addEventListener('ended', finish);
  currentLineAudio = audioEl;
  currentLineFinish = finish;
  activeDialogueStop = stopCurrentLine;
}

function stopCurrentLine() {
  if (!currentLineAudio) return;
  currentLineAudio.pause();
  currentLineFinish();
}

el('dialogue-skip').addEventListener('click', stopCurrentLine);

// ---------------- window ----------------

function updateWindowVisual() {
  const src = {
    closed: 'assets/img/window/closed-2000.webp?v=4',
    open: 'assets/img/window/open-2000.webp?v=4',
    mosque: 'assets/img/window/mosque-2000.webp?v=4',
  }[state.window];
  el('window-img-room').src = src;
  el('window-img-closeup').src = src;
  el('hit-mosque').classList.toggle('hidden', !(state.window === 'open' && state.clockCorrect));
}

// room view: shutters just open the close-up
el('hit-shutters').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('window');
});

// close-up view: shutters actually open the window
el('hit-open-shutters').addEventListener('click', () => {
  if (state.talking) return;
  if (state.window === 'closed') {
    state.window = 'open';
    playSfx(el('audio-door'), -7);
    updateWindowVisual();
  }
});

el('hit-mosque').addEventListener('click', () => {
  if (state.talking) return;
  if (state.window === 'open' && state.clockCorrect) {
    state.window = 'mosque';
    updateWindowVisual();
    const azan = el('audio-azan');
    routeToMaster(azan, false);
    azan.volume = dbToVol(-10);
    azan.currentTime = 0;
    azan.play();
  }
});

// Nor wakes up when the player leaves the window close-up after the azan has started
document.querySelectorAll('[data-back-window]').forEach(btn =>
  btn.addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    if (state.window === 'mosque') {
      fadeAzanDown();
    }
    if (state.window === 'mosque' && !state.norAwake) {
      wakeNor();
      setBedGetUp();
    }
    showScreen('room');
  })
);

function fadeAzanDown() {
  const azan = el('audio-azan');
  if (azan.paused) return;
  const floor = dbToVol(-20);
  const step = () => {
    azan.volume = Math.max(floor, azan.volume - 0.08);
    if (azan.volume > floor) requestAnimationFrame(step);
  };
  step();
}

// ---------------- clock ----------------

function updateClockVisuals() {
  const hourAngle = (state.hour % 12) * 30 + state.minute * 0.5 + 180;
  const minuteAngle = state.minute * 6 + 180;
  el('hand-hour').style.transform = `rotate(${hourAngle}deg)`;
  el('hand-minute').style.transform = `rotate(${minuteAngle}deg)`;
  el('time-readout').textContent =
    String(state.hour).padStart(2, '0') + ' : ' + String(state.minute).padStart(2, '0');
}

// the little clock icon on the main room screen isn't the puzzle itself, so
// it only ever shows one of two fixed times — 12:00 before the puzzle is
// solved, 5:30 (Fajr) after — instead of tracking whatever the child is
// mid-fiddling with on the closeup screen
function updateClockIconHands() {
  // unlike the closeup clock's hand images, these are plain divs pivoted at
  // their own base, so 0deg already points straight up at 12 — no +180 needed
  const hourAngle = state.clockCorrect ? (TARGET_HOUR % 12) * 30 + TARGET_MINUTE * 0.5 : 0;
  const minuteAngle = state.clockCorrect ? TARGET_MINUTE * 6 : 0;
  document.querySelector('.clock-icon-hand.hour').style.transform = `rotate(${hourAngle}deg)`;
  document.querySelector('.clock-icon-hand.minute').style.transform = `rotate(${minuteAngle}deg)`;
}

function tick() {
  playSfx(el('audio-buttonclick'), -8);
  updateClockVisuals();
  checkClockCorrect();
}

function checkClockCorrect() {
  if (!state.clockCorrect && state.hour === TARGET_HOUR && state.minute === TARGET_MINUTE) {
    state.clockCorrect = true;
    updateWindowVisual();
    updateClockIconHands();
    const badge = el('clock-success');
    badge.classList.remove('hidden');
    badge.style.animation = 'none';
    badge.offsetHeight; // restart animation
    badge.style.animation = '';
    // stays up until the child presses back — no auto-hide timer, they need time to read it
    playSfx(el('audio-puzzlesolved'), -10);
    const narrator = el('audio-narrator-clock');
    routeToMaster(narrator, 'narrator');
    narrator.currentTime = 0;
    narrator.volume = dbToVol(-6);
    narrator.play();
    const loop = el('audio-clock-loop');
    routeToMaster(loop, false);
    loop.currentTime = 0;
    loop.volume = dbToVol(-10);
    loop.play();
    saveProgress();
  }
}

el('hit-clock').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  fadeAzanDown();
  showScreen('clock');
  updateClockVisuals();
});
document.querySelectorAll('[data-back]').forEach(btn =>
  btn.addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    if (el('scene-clock').classList.contains('active')) {
      el('clock-success').classList.add('hidden');
      if (state.clockCorrect && !state.clockLoopBg) {
        el('audio-clock-loop').volume = dbToVol(-20);
        state.clockLoopBg = true;
      }
    }
    showScreen('room');
  })
);

el('hit-schedule').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('schedule');
});

el('btn-hour-right').addEventListener('click', () => { state.hour = (state.hour % 12) + 1; tick(); });
el('btn-hour-left').addEventListener('click', () => { state.hour = ((state.hour + 10) % 12) + 1; tick(); });
el('btn-min-right').addEventListener('click', () => { state.minute = (state.minute + MINUTE_STEP) % 60; tick(); });
el('btn-min-left').addEventListener('click', () => { state.minute = (state.minute - MINUTE_STEP + 60) % 60; tick(); });

// ---------------- bed ----------------

function updateBedSprite() {
  const src = {
    sleeping: 'assets/img/bed/sleeping.webp?v=1',
    getup: 'assets/img/bed/getup.webp?v=1',
    fixed: 'assets/img/bed/fixed.webp?v=1',
  }[state.bed];
  el('bed-img').src = src;
}

function setBedGetUp() {
  if (state.bed !== 'sleeping') return;
  state.bed = 'getup';
  updateBedSprite();
}

function onBedClicked() {
  if (state.talking) return;
  if (state.bed !== 'getup') return;

  state.bed = 'fixed';
  updateBedSprite();
  playLine(
    el('audio-nor2'),
    'Готово! Так намного уютнее! А ведь Пророк ﷺ сказал: «Чистота — половина веры».',
    'assets/img/nor/finger-up-v2.webp?v=1'
  );
}

// ---------------- Nor ----------------

function wakeNor() {
  state.norAwake = true;
  el('nor-img').src = NOR_IDLE_SRC;
  el('nor-box').classList.remove('hidden');
  el('hit-nor').classList.remove('hidden');
  saveProgress();
}

function onNorClicked() {
  if (state.talking) return;
  state.norGreeted = true;
  saveProgress();
  playLine(
    el('audio-nor1'),
    'Ас-Саламу Алейкум! Уже наступил Фаджр. Пора сделать омовение, надеть намазник и совершить намаз.',
    'assets/img/nor/arms-out-v4.webp?v=1'
  );
}

// bed hit area lives under the bed image itself; give it its own hit button
const hitBed = document.createElement('button');
hitBed.id = 'hit-bed';
hitBed.className = 'hit';
hitBed.style.left = '8%';
hitBed.style.top = '54%';
hitBed.style.width = '58%';
hitBed.style.height = '36%';
hitBed.style.zIndex = '4';
el('scene-room').appendChild(hitBed);
hitBed.addEventListener('click', onBedClicked);

el('hit-nor').addEventListener('click', onNorClicked);

// ---------------- room 2 / bath ----------------

let doorBusy = false;
let wardrobeOpen = false;
let inventoryDragActive = false; // true while an item ghost is attached to the cursor
let lastRoom2Line = null; // { text, audioId } of the most recent thing Nor said in room2 — tapping her repeats it
// while the bag line's follow-up is waiting on its fixed timer, this holds a
// function that jumps straight to it — skipping the bag line fires it early
// instead of leaving the player to wait out the rest of the 8s
let pendingBagFollowUp = null;

// warm the browser's cache/decoder for the big room2/bath images so there's
// no partial-paint flash the first time each screen is shown
[
  'assets/img/room2/door-open.webp?v=2',
  'assets/img/room2/bath-no-nor.jpg?v=1',
  'assets/img/room2/bath-nor.jpg?v=1',
  'assets/img/room2/wardrobe-open.webp?v=2',
  'assets/img/room2/wardrobe-closeup.webp?v=4',
  'assets/img/room2/cards/cardkit-bg.webp?v=2',
  'assets/img/room2/bath-cards-solved.webp?v=2',
  'assets/img/window/open-2000.webp?v=4',
  'assets/img/window/mosque-2000.webp?v=4',
  'assets/img/bed/getup.webp?v=1',
  'assets/img/bed/fixed.webp?v=1',
].forEach(src => { new Image().src = src; });

el('hit-to-room2').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('room2');
});

el('hit-to-room1').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('room');
});

// room3/room4 (and the shortcut back into them from the main room) only
// open up once Nor is dressed and has said it's time to pray — before that
// there's nothing there for the player to do
function updateRoom4Access() {
  el('hit-room2-to-room3').classList.toggle('hidden', !state.readyForNamaz);
  el('hit-room-to-room4').classList.toggle('hidden', !state.readyForNamaz);
}

el('hit-room-to-room4').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('room4');
});

el('hit-room2-to-room3').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('room3');
});
el('hit-room3-to-room2').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('room2');
});
el('hit-room3-to-room4').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('room4');
});
el('hit-room4-to-room3').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('room3');
});
el('hit-room4-to-room').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('room');
});

// ---------------- room3: computer desk ----------------

// everything besides the compass video that can be opened on the computer
// screen — icons on the desktop, and the decoy search results
const COMPUTER_APPS = {
  study: { type: 'image', src: 'assets/img/room3/apps/study.jpg?v=1', line: '5 — это моя гордость, 4 — это моя мотивация.', audio: 'audio-nor19' },
  photos: { type: 'menu', items: [
    { label: 'Фото 1', src: 'assets/img/room3/apps/photo-1.jpg?v=1', line: 'Вот и вся наша семья. Интересно, как мы все уместились в один кадр?', audio: 'audio-nor12' },
    { label: 'Фото 2', src: 'assets/img/room3/apps/photo-2.jpg?v=1', line: 'Папа тоже умеет помогать. Правда, мама почему-то говорит, что иногда после его помощи работы становится больше.', audio: 'audio-nor13' },
    { label: 'Фото 3', src: 'assets/img/room3/apps/photo-3.jpg?v=1', line: 'Мы учим Коран всей семьёй. Моя маленькая сестра Мария тоже учит. Правда, пока больше учит нас терпению.', audio: 'audio-nor17' },
    { label: 'Фото 4', src: 'assets/img/room3/apps/photo-4.jpg?v=1', line: 'Папа и Ясин строят скворечник. Надеюсь, птицы не будут слишком придирчивы к ремонту.', audio: 'audio-nor15' },
  ] },
  documents: { type: 'menu', items: [
    { label: 'Мои заметки', src: 'assets/img/room3/apps/doc-notes.jpg?v=1', line: 'Некоторые вопросы я уже совсем забыла. Хорошо, что я додумалась их записать.', audio: 'audio-nor14' },
    { label: 'Моя комната', src: 'assets/img/room3/apps/doc-room-map.webp?v=1', line: 'Это моя любимая комната, план сверху. Папа и старший брат Ясин долго спорили, что куда поставить. Но мама сама всё поставила.', audio: 'audio-nor21' },
  ] },
};
const SEARCH_RESULT_APPS = {
  cats: { type: 'video', src: 'assets/video/cats.mp4?v=2', line: 'Ой, какой милый котик!', audio: 'audio-nor23' },
  games: { type: 'image', src: 'assets/img/room3/apps/games-blocked.jpg?v=1', line: 'Опять папа придумал новые правила, иногда это немного раздражает, но я принимаю это ради Аллаха. Я понимаю, что он это делает ради меня, чтобы я выросла хорошим человеком.', audio: 'audio-nor20' },
  weather: { type: 'image', src: 'assets/img/room3/apps/weather.jpg?v=1', line: 'Дождь — это милость от Аллаха.', audio: 'audio-nor22' },
  cookies: { type: 'image', src: 'assets/img/room3/apps/cookies.jpg?v=1', line: 'МашаАллах! Рецепт печенья! Теперь мне срочно нужно печенье!', audio: 'audio-nor16' },
};

// true while the generic app window (photos/documents/decoy results) is
// open — plain UI flag, not saved, same pattern as tumbochkaOpen below
let computerWindowOpen = false;

// the frame+glow layers are shared between the compass video and every app
// window — both sit in the exact same screen cutout, so one pair of layers
// masks all of them and nothing new has to be drawn per picture
function updateComputerFrameVisibility() {
  const show = state.computerOn && (state.videoOpened || computerWindowOpen);
  el('computer-video-frame').classList.toggle('hidden', !show);
  el('computer-video-top-layer').classList.toggle('hidden', !show);
}

function openComputerWindow(content) {
  el('computer-video-wrap').classList.add('hidden');
  el('computer-video').pause();
  el('computer-search-wrap').classList.add('hidden');
  el('computer-search-suggestions').classList.add('hidden');
  computerWindowOpen = true;
  el('computer-window').classList.remove('hidden');
  el('computer-window-close').classList.remove('hidden');
  updateComputerFrameVisibility();
  if (content.type === 'menu') {
    showComputerMenu(content.items);
  } else {
    showComputerContent(content);
  }
}

function showComputerMenu(items) {
  const menu = el('computer-window-menu');
  menu.innerHTML = '';
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'computer-window-menu-item';
    btn.textContent = item.label;
    btn.addEventListener('click', () => { playComputerClick(); showComputerContent(item, items); });
    menu.appendChild(btn);
  });
  menu.classList.remove('hidden');
  el('computer-window-image').classList.add('hidden');
  el('computer-window-video').classList.add('hidden');
  el('computer-window-video').pause();
  el('computer-window-back').classList.add('hidden');
  stopRoom3Dialogue();
}

// video content (the cats decoy) only plays its line once the video is
// actually started, not the instant the window opens — everything else
// speaks right away
let computerVideoDialogue = null;

function showComputerContent(item, parentItems) {
  el('computer-window-menu').classList.add('hidden');
  if (item.type === 'video') {
    el('computer-window-video').src = item.src;
    el('computer-window-video').classList.remove('hidden');
    el('computer-window-image').classList.add('hidden');
    computerVideoDialogue = item.line ? { text: item.line, audioId: item.audio } : null;
  } else {
    el('computer-window-image').src = item.src;
    el('computer-window-image').classList.remove('hidden');
    el('computer-window-video').classList.add('hidden');
    el('computer-window-video').pause();
    computerVideoDialogue = null;
  }
  el('computer-window-back').classList.toggle('hidden', !parentItems);
  if (parentItems) {
    el('computer-window-back').onclick = () => { playComputerClick(); showComputerMenu(parentItems); };
  }
  if (item.type !== 'video') {
    if (item.line) {
      playRoom3Dialogue(item.line, item.audio ? el(item.audio) : null);
    } else {
      stopRoom3Dialogue();
    }
  }
}
el('computer-window-video').addEventListener('play', () => {
  if (computerVideoDialogue) {
    playRoom3Dialogue(computerVideoDialogue.text, computerVideoDialogue.audioId ? el(computerVideoDialogue.audioId) : null);
  }
});

function playRoom3Dialogue(text, audioEl) {
  if (activeDialogueStop) activeDialogueStop();
  const box = el('room3-dialogue');
  el('room3-dialogue-text').textContent = text;
  box.classList.remove('hidden');
  clearTimeout(playRoom3Dialogue._t);
  if (audioEl) {
    routeToMaster(audioEl, true);
    audioEl.currentTime = 0;
    audioEl.volume = dbToVol(0);
    audioEl.play();
    const finish = () => {
      box.classList.add('hidden');
      audioEl.removeEventListener('ended', finish);
      playRoom3Dialogue._stop = null;
      if (activeDialogueStop === stopRoom3Dialogue) activeDialogueStop = null;
    };
    audioEl.addEventListener('ended', finish);
    playRoom3Dialogue._stop = () => { audioEl.pause(); finish(); };
  } else {
    playRoom3Dialogue._stop = null;
    playRoom3Dialogue._t = setTimeout(() => {
      box.classList.add('hidden');
      if (activeDialogueStop === stopRoom3Dialogue) activeDialogueStop = null;
    }, 8000);
  }
  activeDialogueStop = stopRoom3Dialogue;
}
function stopRoom3Dialogue() {
  clearTimeout(playRoom3Dialogue._t);
  if (playRoom3Dialogue._stop) playRoom3Dialogue._stop();
  else el('room3-dialogue').classList.add('hidden');
  if (activeDialogueStop === stopRoom3Dialogue) activeDialogueStop = null;
}
el('room3-dialogue-skip').addEventListener('click', stopRoom3Dialogue);

function closeComputerWindow() {
  computerWindowOpen = false;
  el('computer-window').classList.add('hidden');
  el('computer-window-back').classList.add('hidden');
  el('computer-window-close').classList.add('hidden');
  el('computer-window-video').pause();
  stopRoom3Dialogue();
  updateComputerFrameVisibility();
}

// reflects state.computerOn/state.searchOpened/state.videoOpened onto both
// the far view and the closeup — called on toggle and on save restore, so
// the views can never disagree about whether the computer is on
function updateComputerVisual() {
  syncCompassSuggestion();
  const on = state.computerOn;
  el('computer-far-img').src = on
    ? 'assets/img/room3/computer-on-far.webp?v=1'
    : 'assets/img/room3/computer-off-far.webp?v=1';
  el('computer-closeup-img').src = on
    ? 'assets/img/room3/computer-on-closeup.webp?v=1'
    : 'assets/img/room3/computer-off-closeup.webp?v=1';
  el('computer-icons-img').classList.toggle('hidden', !on);
  el('computer-internet-icon-img').classList.toggle('hidden', !on);
  el('hit-internet-icon').classList.toggle('hidden', !on);
  el('hit-icon-study').classList.toggle('hidden', !on);
  el('hit-icon-koran').classList.toggle('hidden', !on);
  el('hit-icon-photos').classList.toggle('hidden', !on);
  el('hit-icon-documents').classList.toggle('hidden', !on);
  const showVideo = on && state.videoOpened;
  const showSearch = on && state.searchOpened && !state.videoOpened;
  // the compass video, the search bar and any app window all live in the
  // same screen rect — showing one always means closing the other two
  if (!on || showVideo || showSearch) closeComputerWindow();
  el('computer-video-wrap').classList.toggle('hidden', !showVideo);
  if (showVideo) {
    // while paused (whether never started, or finished and offering a
    // replay) the video's own frame would hide the splash card behind it
    if (el('computer-video').paused) {
      el('computer-video').classList.add('computer-video-ended-hide');
    }
    revealVideoPlayButton();
  } else {
    el('computer-video').pause();
    el('computer-video-play').classList.add('hidden');
  }
  el('computer-search-wrap').classList.toggle('hidden', !showSearch);
  if (!showSearch) el('computer-search-suggestions').classList.add('hidden');
  // the video and the search page can both be closed back to the plain desktop
  el('computer-view-close').classList.toggle('hidden', !showVideo);
  el('computer-search-backdrop').classList.toggle('hidden', !showSearch);
  updateComputerFrameVisibility();
}

// the play button only appears once the video actually has a frame ready to
// show — revealing it immediately could leave the child tapping a button
// that does nothing yet while the file is still loading
function revealVideoPlayButton() {
  const video = el('computer-video');
  const show = () => {
    if (video.ended) {
      setVideoReplayIcon();
    } else {
      setVideoPlayIcon();
    }
    el('computer-video-play').classList.remove('hidden');
  };
  // phones don't preload video before the first tap, so 'canplay' may never
  // fire on its own — metadata (or a short timeout) is enough to show the button
  if (video.readyState >= 1) {
    show();
  } else {
    let shown = false;
    const showOnce = () => { if (shown) return; shown = true; show(); };
    video.addEventListener('loadedmetadata', showOnce, { once: true });
    video.addEventListener('canplay', showOnce, { once: true });
    setTimeout(showOnce, 1200);
  }
}

function setVideoPlayIcon() {
  el('computer-video-play').innerHTML =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
}
function setVideoReplayIcon() {
  el('computer-video-play').innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
}

el('hit-computer').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('computer');
});
document.querySelectorAll('[data-back-computer]').forEach(btn =>
  btn.addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    el('computer-video').pause();
    closeComputerWindow();
    showScreen('room3');
  })
);
el('hit-computer-power').addEventListener('click', () => {
  if (state.talking) return;
  state.computerOn = !state.computerOn;
  if (!state.computerOn) {
    state.videoOpened = false;
    state.searchOpened = false;
  }
  playSfx(el('audio-buttonclick'), -8);
  // switching on: the boot sound follows the click after a beat
  if (state.computerOn) setTimeout(() => playSfx(el('audio-compturn'), -16), 100);
  updateComputerVisual();
  // the hum starts together with the power button
  updateComputerHum();
  saveProgress();
});
el('hit-internet-icon').addEventListener('click', () => {
  if (state.talking || !state.computerOn) return;
  state.searchOpened = true;
  playComputerClick();
  updateComputerVisual();
  saveProgress();
});
el('computer-search-bar').addEventListener('click', () => {
  playComputerClick();
  // the real answer only shows up once Nor has actually asked the
  // question — before that the child would have no way to know it
  el('search-suggestion-compass').classList.toggle('hidden', !state.compassHintGiven);
  el('computer-search-suggestions').classList.toggle('hidden');
  playRoom3Dialogue('Я хотела поискать всего одну вещь, а интернет уже успел предложить мне двадцать.', el('audio-nor24'));
});
document.querySelectorAll('.search-suggestion').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.correct === 'true') {
      state.videoOpened = true;
      playComputerClick();
      updateComputerVisual();
      saveProgress();
      return;
    }
    // the decoy results aren't dead ends — each one opens its own content
    const key = btn.id.replace('search-suggestion-', '');
    const content = SEARCH_RESULT_APPS[key];
    if (content) {
      playComputerClick();
      openComputerWindow(content);
    }
  });
});
el('hit-icon-study').addEventListener('click', () => {
  if (state.talking) return;
  playComputerClick();
  openComputerWindow(COMPUTER_APPS.study);
});
el('hit-icon-koran').addEventListener('click', () => {
  // no content or line for this one yet
  if (state.talking) return;
  playComputerClick();
});
el('hit-icon-photos').addEventListener('click', () => {
  if (state.talking) return;
  playComputerClick();
  openComputerWindow(COMPUTER_APPS.photos);
});
el('hit-icon-documents').addEventListener('click', () => {
  if (state.talking) return;
  playComputerClick();
  openComputerWindow(COMPUTER_APPS.documents);
});
el('computer-window-close').addEventListener('click', () => {
  playComputerClick();
  closeComputerWindow();
});
function closeComputerSearchOrVideo() {
  state.videoOpened = false;
  state.searchOpened = false;
  playComputerClick();
  stopRoom3Dialogue();
  updateComputerVisual();
  saveProgress();
}
el('computer-search-backdrop').addEventListener('click', closeComputerSearchOrVideo);
// the search wrap is wider than the bar inside it: a tap on its bare part counts as empty screen too
el('computer-search-wrap').addEventListener('click', (e) => {
  if (e.target === el('computer-search-wrap')) closeComputerSearchOrVideo();
});
el('computer-view-close').addEventListener('click', () => {
  state.videoOpened = false;
  state.searchOpened = false;
  playComputerClick();
  stopRoom3Dialogue();
  updateComputerVisual();
  saveProgress();
});
el('computer-video-play').addEventListener('click', () => {
  playComputerClick();
  const video = el('computer-video');
  if (video.ended) video.currentTime = 0;
  video.classList.remove('computer-video-ended-hide');
  video.play();
});
// the skip button only exists while the video is actually running; it jumps
// straight to the end, which counts exactly like watching it to the finish
el('computer-video').addEventListener('pause', () => el('computer-video-skip').classList.add('hidden'));
el('computer-video-skip').addEventListener('click', () => {
  playComputerClick();
  const video = el('computer-video');
  video.pause();
  video.dispatchEvent(new Event('ended'));
});
el('computer-video').addEventListener('play', () => {
  el('computer-video-skip').classList.remove('hidden');
  el('computer-video-play').classList.add('hidden');
  el('computer-video').classList.remove('computer-video-ended-hide');
});
el('computer-video').addEventListener('ended', () => {
  el('computer-video-skip').classList.add('hidden');
  setVideoReplayIcon();
  el('computer-video-play').classList.remove('hidden');
  // the video's own last frame would otherwise stay on screen instead of
  // the splash card — hide it so the "where to place it" poster shows again
  el('computer-video').classList.add('computer-video-ended-hide');
  // watching the compass video to the end counts as finding the second hint
  if (!state.hintsFound.compass) {
    state.hintsFound.compass = true;
    updateHintsUI();
    playSfx(el('audio-puzzlesolved'), -16);
    saveProgress();
    playRoom3Dialogue('Ага, красная стрелка компаса — это север, запомним.', el('audio-nor31'));
  }
});

// ---------------- room4: nightstand + board ----------------

let tumbochkaOpen = false;
el('hit-tumbochka-drawer').addEventListener('click', () => {
  if (state.talking) return;
  if (!tumbochkaOpen) {
    tumbochkaOpen = true;
    playSfx(el('audio-wardrobe'), -7);
    el('tumbochka-img').src = 'assets/img/room4/tumbochka-opened.webp?v=1';
  } else {
    playSfx(el('audio-move'), -12);
    showScreen('tumbochka-drawer');
  }
});
document.querySelectorAll('[data-back-tumbochka-drawer]').forEach(btn =>
  btn.addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    showScreen('room4');
    if (!state.norRoom4Shown && state.inventory.some(it => it.id === 'carpet')) {
      state.norRoom4Shown = true;
      saveProgress();
      el('nor-redress-img').classList.add('hidden');
      el('nor-room4-img').classList.remove('hidden');
      setTimeout(() => {
        const text = 'Отлично! Коврик найден. Обычно я кладу его между дверью и тумбочкой.';
        playRoom4Dialogue(text, el('audio-nor25'));
        lastRoom4Line = { text, audioId: 'audio-nor25' };
      }, 200);
    }
  })
);

el('hit-tumbochka-top').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('tumbochka-top');
});
document.querySelectorAll('[data-back-tumbochka-top]').forEach(btn =>
  btn.addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    showScreen('room4');
  })
);

el('hit-board').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('board');
});
document.querySelectorAll('[data-back-board]').forEach(btn =>
  btn.addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    showScreen('room4');
    if (kiblaHintPending) {
      kiblaHintPending = false;
      state.hintsFound.kibla = true;
      updateHintsUI();
      playSfx(el('audio-puzzlesolved'), -16);
      saveProgress();
    }
    if (kiblaWhereSouthPending) {
      kiblaWhereSouthPending = false;
      setTimeout(() => {
        const text = 'Кибла на юг. Так, а где в комнате юг?';
        playRoom4Dialogue(text, el('audio-nor28'));
        lastRoom4Line = { text, audioId: 'audio-nor28' };
      }, 200);
    }
  })
);

// each board sticker opens a bigger, readable version over a dim backdrop;
// stickers 2 and 3 are both clusters of tiny icons, so they share one zoom
let kiblaHintPending = false;
const BOARD_STICKER_ZOOM = {
  1: 'assets/img/room4/board-zoom-1.webp?v=1',
  2: 'assets/img/room4/board-zoom-23.webp?v=1',
  3: 'assets/img/room4/board-zoom-23.webp?v=1',
  4: 'assets/img/room4/board-zoom-4.jpg?v=1',
  5: 'assets/img/room4/board-zoom-5.webp?v=1',
};
Object.keys(BOARD_STICKER_ZOOM).forEach(n => {
  el('hit-board-sticker-' + n).addEventListener('click', () => {
    if (state.talking) return;
    playSfx(el('audio-move'), -12);
    el('sticker-lightbox-img').src = BOARD_STICKER_ZOOM[n];
    el('sticker-lightbox').classList.remove('hidden');
    // the compass sticker (1) was a gift from Nor's friend; she tells the story
    if (n === '1') {
      if (activeDialogueStop) activeDialogueStop();
      const caption = el('sticker-lightbox-caption');
      caption.textContent = 'Этот стикер мне подарила моя подруга. МаШаАллах. Она очень красиво рисует и хорошо знает географию.';
      caption.classList.remove('hidden');
      const stickerVoice = el('audio-nor29');
      routeToMaster(stickerVoice, true);
      stickerVoice.currentTime = 0;
      stickerVoice.volume = dbToVol(0);
      stickerVoice.play();
    }
    // Nor reads the kibla note aloud (no caption: it is the text written on the note itself)
    if (n === '4') {
      if (activeDialogueStop) activeDialogueStop();
      const kiblaVoice = el('audio-nor27');
      routeToMaster(kiblaVoice, true);
      kiblaVoice.currentTime = 0;
      kiblaVoice.volume = dbToVol(0);
      kiblaVoice.play();
    }
    // the "кибла" note pinned to the board tells the player which way to
    // face for prayer — seeing it counts as finding the first of 3 hints,
    // but only once Nor has actually said the hints need finding
    // the hint itself is only added (and its sound played) once the player
    // steps back out to the room view — see the board's back button
    if (n === '4' && state.carpetPlaced && !state.hintsFound.kibla) {
      kiblaHintPending = true;
    }
  });
});

function updateHintsUI() {
  const kiblaSlot = el('hint-slot-kibla');
  kiblaSlot.classList.toggle('filled', !!state.hintsFound.kibla);
  kiblaSlot.textContent = state.hintsFound.kibla ? 'Кибла на Юг' : '';

  const compassSlot = el('hint-slot-compass');
  compassSlot.classList.toggle('filled', !!state.hintsFound.compass);
  compassSlot.textContent = state.hintsFound.compass ? 'Красная стрелка компаса — Север' : '';

  const southSlot = el('hint-slot-3');
  southSlot.classList.toggle('filled', !!state.hintsFound.south);
  southSlot.textContent = state.hintsFound.south ? 'Компьютер — это Юг!' : '';
}
let kiblaWhereSouthPending = false;
el('sticker-lightbox').addEventListener('click', () => {
  const wasKibla = el('sticker-lightbox-img').src.includes('board-zoom-4');
  el('sticker-lightbox').classList.add('hidden');
  ['audio-nor11', 'audio-nor27', 'audio-nor29'].forEach(id => {
    const narrator = el(id);
    narrator.pause();
    narrator.currentTime = 0;
  });
  el('sticker-lightbox-caption').classList.add('hidden');
  // Nor wonders where south is once the player steps back out to the room view,
  // but only after she has already told the player about the 3 hints (carpet placed)
  if (wasKibla && state.carpetPlaced) kiblaWhereSouthPending = true;
});


function updateBathVisual() {
  if (state.norLeftBath) {
    el('bath-img').src = 'assets/img/room2/bath-no-nor.jpg?v=1';
    el('cardkit-bath-prop').classList.remove('hidden');
    return;
  }
  el('cardkit-bath-prop').classList.add('hidden');
  el('bath-img').src = state.cardsSolved
    ? 'assets/img/room2/bath-cards-solved.webp?v=2'
    : state.norGreeted
      ? 'assets/img/room2/bath-nor.jpg?v=1'
      : 'assets/img/room2/bath-no-nor.jpg?v=1';
}

el('hit-door').addEventListener('click', () => {
  if (state.talking || doorBusy) return;
  doorBusy = true;
  playSfx(el('audio-door'), -7);
  updateBathVisual();
  el('door-img').src = 'assets/img/room2/door-open.webp?v=2';
  setTimeout(() => {
    showScreen('bath');
    el('door-img').src = 'assets/img/room2/door-closed.webp?v=2';
    doorBusy = false;
    const azan = el('audio-azan');
    if (!azan.paused) {
      azan.pause();
      azan.currentTime = 0;
    }
    const nasheed = el('audio-nasheed');
    if (!nasheed.paused) {
      nasheed.pause(); // just pauses — resumes from here, not from the start, once back in room2
    }
    // she's been seen in the mirror now — Nor is no longer waiting by the bed
    // (only once greeted: otherwise she'd vanish from the room before her
    // salam-aleikum line ever played, with nowhere to be seen at all)
    if (state.norGreeted) {
      el('nor-box').classList.add('hidden');
      el('hit-nor').classList.add('hidden');
    }
    state.norSeenInBath = true;
  }, 900);
});

el('hit-bath-door').addEventListener('click', () => {
  playSfx(el('audio-door'), -7);
  showScreen('room2');
  if (state.norLeftBath) {
    const nasheed = el('audio-nasheed');
    if (nasheed.paused) {
      routeToMaster(nasheed, false);
      nasheed.volume = dbToVol(-16);
      nasheed.play();
    }
  }
});

// ---------------- wardrobe ----------------

el('hit-wardrobe-drawer').addEventListener('click', () => {
  if (state.talking) return;
  if (!wardrobeOpen) {
    wardrobeOpen = true;
    playSfx(el('audio-wardrobe'), -7);
    el('wardrobe-img').src = 'assets/img/room2/wardrobe-open.webp?v=2';
  } else {
    playSfx(el('audio-move'), -12);
    showScreen('wardrobe');
  }
});

document.querySelectorAll('[data-back-wardrobe]').forEach(btn =>
  btn.addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    showScreen('room2');
  })
);

// ---------------- mirror + wudu booklet ----------------

el('hit-mirror').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('mirror');
});
document.querySelectorAll('[data-back-mirror]').forEach(btn =>
  btn.addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    showScreen('room2');
  })
);

function openBooklet() {
  if (state.talking) return;
  if (activeDialogueStop) activeDialogueStop();
  playSfx(el('audio-move'), -12);
  el('sticker-lightbox-img').src = 'assets/img/room2/wudu-booklet.jpg?v=1';
  el('sticker-lightbox').classList.remove('hidden');
  const caption = el('sticker-lightbox-caption');
  caption.textContent = 'Хорошо, что мама распечатала мне эту памятку. Иногда я забываю порядок омовения.';
  caption.classList.remove('hidden');
  const narrator = el('audio-nor11');
  routeToMaster(narrator, true);
  narrator.currentTime = 0;
  narrator.volume = dbToVol(0);
  narrator.play();
}
// the booklet is tucked into the mirror on the wall, but only readable once
// zoomed in — tapping it on the wall just zooms to the mirror, like tapping
// the mirror itself; only the closeup's booklet actually opens it
el('hit-booklet').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  showScreen('mirror');
});
el('hit-booklet-closeup').addEventListener('click', openBooklet);

// ---------------- inventory ----------------

const MAX_INVENTORY_SLOTS = 9;
function buildInventoryUI() {
  const bar = el('inventory-bar');
  for (let i = 0; i < MAX_INVENTORY_SLOTS; i++) {
    const slot = document.createElement('div');
    slot.className = 'inv-slot';
    bar.appendChild(slot);
  }
  el('inventory-toggle').addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    el('inventory-wrap').classList.toggle('open');
  });
  setupInventoryDrag();

  el('lang-gear').addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    el('lang-menu').classList.toggle('hidden');
    el('lang-submenu').classList.add('hidden'); // closed by default each time the menu opens
  });

  el('hints-toggle').addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    el('hints-bar').classList.toggle('hidden');
  });

  el('lang-menu-toggle').addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    el('lang-submenu').classList.toggle('hidden');
  });

  el('reset-progress-btn').addEventListener('click', () => {
    el('reset-confirm').classList.remove('hidden');
    const narrator = el('audio-narrator-reset');
    routeToMaster(narrator, 'narrator');
    narrator.currentTime = 0;
    narrator.volume = dbToVol(-6);
    narrator.play();
  });

  el('reset-confirm-yes').addEventListener('click', () => {
    localStorage.removeItem(SAVE_KEY);
    location.reload();
  });

  el('reset-confirm-no').addEventListener('click', () => {
    el('reset-confirm').classList.add('hidden');
  });
}

// drag an item out of its slot with the mouse/finger; since there is nowhere
// valid to drop it yet (Nor's clothes aren't drawn), it always flies back
function setupInventoryDrag() {
  const bar = el('inventory-bar');
  let ghost = null;
  let sourceSlot = null;
  let activePointerId = null;

  function attach(slot, x, y) {
    const img = slot.querySelector('img');
    if (!img) return;
    inventoryDragActive = true;
    sourceSlot = slot;
    slot.classList.add('drag-source');
    const rect = img.getBoundingClientRect();
    const itemId = img.dataset.item;
    ghost = document.createElement('img');
    let ghostW = rect.width, ghostH = rect.height;
    if (itemId === 'carpet') {
      // the rolled-up icon unfurls into the full prayer rug while dragging
      ghost.src = 'assets/img/room4/carpet-unrolled.webp?v=1';
      ghostH = rect.height * 1.6;
      ghostW = ghostH * (1235 / 1864);
    } else {
      ghost.src = img.src;
    }
    ghost.dataset.item = itemId;
    ghost.className = 'inv-drag-ghost';
    ghost.style.width = ghostW + 'px';
    ghost.style.height = ghostH + 'px';
    ghost.style.left = (x - ghostW / 2) + 'px';
    ghost.style.top = (y - ghostH / 2) + 'px';
    document.body.appendChild(ghost);
    // the open inventory drawer sits above Nor's feet (z-index-wise) right
    // where boots naturally get dropped — ignore it as a drop target for
    // the rest of this drag so the hit-test falls through to her instead
    el('inventory-wrap').style.pointerEvents = 'none';
  }

  // item flies back home on the second click unless it's dropped on a
  // valid target (right now: the right item dropped on Nor dresses her up)
  function flyBack() {
    // opening the compass is a good thing to do, not a rejected drop: skip the "back to inventory" bump
    const opensCompass = ghost.dataset.item === 'compass' && state.compassOpenLineDone;
    if (!opensCompass) playSfx(el('audio-backtoinv'), -6);
    el('inventory-wrap').style.pointerEvents = '';
    // tapping the compass in the inventory doesn't dress Nor or place
    // anything — it just makes her think out loud; this line is deliberately
    // NOT saved as lastRoom4Line, so tapping Nor keeps repeating whatever she
    // last actually said instead of getting stuck on this aside
    if (ghost.dataset.item === 'compass' && state.compassOpenLineDone) {
      // Nor has said the compass can be opened now: tapping it shows it
      openCompassOverlay();
    } else if (ghost.dataset.item === 'compass' && !state.hintsFound.compass) {
      // once she has watched the compass video this aside is over for good
      playRoom4Dialogue('Я не знаю, как пользоваться компасом. Надо посмотреть в интернете.', el('audio-nor-compass'));
      state.compassHintGiven = true;
      syncCompassSuggestion();
      saveProgress();
    }
    const targetImg = sourceSlot.querySelector('img');
    const rect = targetImg.getBoundingClientRect();
    ghost.classList.add('flying-back');
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    const toRemove = ghost;
    const srcSlot = sourceSlot;
    ghost = null;
    sourceSlot = null;
    inventoryDragActive = false;
    setTimeout(() => {
      toRemove.remove();
      srcSlot.classList.remove('drag-source');
    }, 260);
  }

  function release(x, y) {
    if (!ghost) return;
    const itemId = ghost.dataset.item;
    const target = document.elementFromPoint(x, y);
    const norImg = el('nor-redress-img');
    const droppedOnNor = norImg && !norImg.classList.contains('hidden') &&
      target && target.closest && target.closest('#nor-redress-img');

    if (droppedOnNor && NOR_OUTFIT_STEPS[itemId] && outfitStepAllowed(itemId)) {
      el('inventory-wrap').style.pointerEvents = '';
      norImg.src = NOR_OUTFIT_STEPS[itemId].src;
      state.norOutfitStage++;
      // clothes.mp3 has a quiet dip right after its lead-in (0.5-0.68s) before
      // the actual satisfying rustle peak — starting at 0.5 played that dip
      // first and read as a laggy sound; 0.68 starts right on the punch
      playSfx(el('audio-clothes'), -8, 0.68);
      removeInventoryItem(itemId);
      ghost.remove();
      sourceSlot.classList.remove('drag-source');
      ghost = null;
      sourceSlot = null;
      inventoryDragActive = false;
      if (NOR_OUTFIT_STEPS[itemId].line) {
        const stepAudio = NOR_OUTFIT_STEPS[itemId].audio ? el(NOR_OUTFIT_STEPS[itemId].audio) : null;
        playRoom2Dialogue(NOR_OUTFIT_STEPS[itemId].line, stepAudio);
        lastRoom2Line = { text: NOR_OUTFIT_STEPS[itemId].line, audioId: NOR_OUTFIT_STEPS[itemId].audio };
        if (itemId === 'bag') {
          const followUpText = 'АльхамдулиЛлях, теперь надо расстелить коврик и сделать намаз.';
          const followUp = () => {
            pendingBagFollowUp = null;
            playRoom2Dialogue(followUpText, el('audio-nor9'));
            lastRoom2Line = { text: followUpText, audioId: 'audio-nor9' };
            state.readyForNamaz = true;
            updateRoom4Access();
            saveProgress();
          };
          // a fixed timer, not stepAudio's 'ended' event: if the child keeps
          // tapping Nor she keeps restarting this same line, and 'ended'
          // would then never fire — leaving room3/room4 locked forever
          const followUpTimer = setTimeout(followUp, 8000);
          pendingBagFollowUp = () => {
            clearTimeout(followUpTimer);
            followUp();
          };
        }
      }
      return;
    }

    const droppedOnCarpetSpot = target && target.closest && target.closest('#hit-carpet-drop');
    if (droppedOnCarpetSpot && itemId === 'carpet' && !state.carpetPlaced) {
      el('inventory-wrap').style.pointerEvents = '';
      state.carpetPlaced = true;
      el('carpet-placed-img').classList.remove('hidden');
      playSfx(el('audio-move'), -12);
      removeInventoryItem('carpet');
      ghost.remove();
      sourceSlot.classList.remove('drag-source');
      ghost = null;
      sourceSlot = null;
      inventoryDragActive = false;
      el('hints-wrap').classList.remove('hidden');
      const text = 'Теперь нужно положить его в правильном направлении. Чтобы узнать это направление, в комнате есть 3 подсказки. Собери их всех.';
      playRoom4Dialogue(text, el('audio-nor26'));
      lastRoom4Line = { text, audioId: 'audio-nor26' };
      return;
    }

    flyBack();
  }

  // real press-and-hold drag (works for mouse AND touch): pointerdown picks
  // the item up and captures the pointer so move/up keep arriving even as
  // the finger slides off the original slot; pointerup drops it wherever
  // the finger/cursor is at that moment
  bar.addEventListener('pointerdown', (e) => {
    if (ghost) return;
    const slot = e.target.closest && e.target.closest('.inv-slot.filled');
    if (!slot || !bar.contains(slot)) return;
    e.preventDefault();
    activePointerId = e.pointerId;
    attach(slot, e.clientX, e.clientY);
    if (e.target.setPointerCapture) {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!ghost || e.pointerId !== activePointerId) return;
    ghost.style.left = (e.clientX - ghost.offsetWidth / 2) + 'px';
    ghost.style.top = (e.clientY - ghost.offsetHeight / 2) + 'px';
  });

  function finishDrag(e) {
    if (!ghost || e.pointerId !== activePointerId) return;
    activePointerId = null;
    release(e.clientX, e.clientY);
  }
  window.addEventListener('pointerup', finishDrag);
  window.addEventListener('pointercancel', finishDrag);
}

// which inventory item, dropped on Nor, advances her outfit to which sprite —
// must be worn strictly in this order (each needs the previous one already on)
const NOR_OUTFIT_SEQUENCE = ['dress', 'socks', 'hijab', 'boots', 'bag'];
const NOR_OUTFIT_STEPS = {
  dress: {
    src: 'assets/img/redress/redress-2.webp?v=1',
    line: 'Моё любимое платье! Его подарил мне папа, когда мы путешествовали по Марокко.',
    audio: 'audio-nor5',
  },
  socks: {
    src: 'assets/img/redress/redress-3.webp?v=1',
  },
  hijab: {
    src: 'assets/img/redress/redress-4.webp?v=1',
    line: 'Хиджаб — это моя скромность и послушание Аллаху. Я люблю свой хиджаб!',
    audio: 'audio-nor6',
  },
  boots: {
    src: 'assets/img/redress/redress-5.webp?v=1',
    line: 'Для намаза ботинки мне не нужны, я их сниму во время молитвы и снова надену перед выходом.',
    audio: 'audio-nor7',
  },
  bag: {
    src: 'assets/img/redress/redress-6.webp?v=1',
    line: 'Перед выходом надо проверить, есть ли ключи и телефон в сумочке.',
    audio: 'audio-nor8',
  },
};

// true only if this is the very next item Nor is waiting for
function outfitStepAllowed(itemId) {
  return NOR_OUTFIT_SEQUENCE[state.norOutfitStage] === itemId;
}

function renderInventory() {
  const slots = document.querySelectorAll('#inventory-bar .inv-slot');
  slots.forEach((slot, i) => {
    const item = state.inventory[i];
    slot.classList.toggle('filled', !!item);
    slot.innerHTML = '';
    if (item) {
      const img = document.createElement('img');
      img.src = item.icon;
      img.dataset.item = item.id;
      slot.appendChild(img);
      const tip = document.createElement('span');
      tip.className = 'inv-tooltip';
      tip.textContent = item.label;
      slot.appendChild(tip);
    }
  });
}

// takes an item out of the inventory for good (e.g. once it's been dressed onto Nor)
function removeInventoryItem(id) {
  state.inventory = state.inventory.filter(it => it.id !== id);
  renderInventory();
  saveProgress();
}

// picks up an item into the inventory and fades its sprite out of the scene
function collectItem(id, label, icon, imgElId, hitElId, toFront) {
  if (state.inventory.some(it => it.id === id)) return;
  if (state.inventory.length >= MAX_INVENTORY_SLOTS) return;
  playSfx(el('audio-move'), -12);
  if (toFront) {
    state.inventory.unshift({ id, label, icon });
  } else {
    state.inventory.push({ id, label, icon });
  }
  renderInventory();
  saveProgress();
  const itemImg = el(imgElId);
  if (itemImg) itemImg.style.opacity = '0';
  const hitBtn = el(hitElId);
  if (hitBtn) hitBtn.classList.add('hidden');
}

el('hit-hijab').addEventListener('click', () => {
  if (state.talking) return;
  collectItem('hijab', 'Хиджаб', 'assets/img/room2/hijab-item.webp?v=1', 'hijab-img', 'hit-hijab');
});
el('hit-dress').addEventListener('click', () => {
  if (state.talking) return;
  collectItem('dress', 'Платье', 'assets/img/room2/dress-item.webp?v=1', 'dress-img', 'hit-dress');
});
el('hit-socks').addEventListener('click', () => {
  if (state.talking) return;
  collectItem('socks', 'Носки', 'assets/img/room2/socks-item.webp?v=1', 'socks-img', 'hit-socks');
});
el('hit-bag').addEventListener('click', () => {
  if (state.talking) return;
  collectItem('bag', 'Сумка', 'assets/img/room2/bag-item.webp?v=2', 'bag-img', 'hit-bag');
});
el('hit-boots').addEventListener('click', () => {
  if (state.talking) return;
  collectItem('boots', 'Ботинки', 'assets/img/room2/boots-item.webp?v=1', 'boots-img', 'hit-boots');
});
el('hit-carpet').addEventListener('click', () => {
  if (state.talking) return;
  collectItem('carpet', 'Коврик', 'assets/img/room4/carpet-in-tumbochka.webp?v=1', 'carpet-img', 'hit-carpet');
});
el('hit-compas-big').addEventListener('click', () => {
  // the compass only becomes collectible once the hints panel is up —
  // otherwise finding it this early gives no clue what it's even for
  if (state.talking || !state.carpetPlaced) return;
  collectItem('compass', 'Компас', 'assets/img/room4/compas-big.webp?v=1', 'compas-big-img', 'hit-compas-big');
  el('compas-on-tumbochka-img').style.opacity = '0';
});

// ---------------- wudu card puzzle ----------------

// the counter's card kit can always be opened, but it only shows the
// interactive board once Nor has woken up AND said her wudu/namaz line
el('hit-cards').addEventListener('click', () => {
  if (state.talking) return;
  playSfx(el('audio-move'), -12);
  updateCardsView();
  showScreen('cards');
  if (state.norGreeted && !state.cardsSolved) {
    playCardsDialogue('Хммм, в какой же последовательности надо делать омовение? До сих пор путаю.', el('audio-nor10'));
  }
});
document.querySelectorAll('[data-back-cards]').forEach(btn =>
  btn.addEventListener('click', () => {
    playSfx(el('audio-move'), -12);
    showScreen('bath');
  })
);

function updateCardsView() {
  const unlocked = state.norGreeted;
  el('cards-locked-img').classList.toggle('hidden', unlocked);
  el('card-slots').classList.toggle('hidden', !unlocked);
  el('card-arrows').classList.toggle('hidden', !unlocked);
  el('card-layer').classList.toggle('hidden', !unlocked);
  el('hit-card-pile').classList.toggle('hidden', !unlocked || cardsScattered);
}

const CARD_SLOTS = [
  { left: 12,    top: 18,    width: 23.33, height: 19.33 },
  { left: 38.33, top: 18,    width: 23.33, height: 19.33 },
  { left: 64.66, top: 18,    width: 23.33, height: 19.33 },
  { left: 12,    top: 40.33, width: 23.33, height: 19.33 },
  { left: 38.33, top: 40.33, width: 23.33, height: 19.33 },
  { left: 64.66, top: 40.33, width: 23.33, height: 19.33 },
  { left: 12,    top: 62.66, width: 23.33, height: 19.33 },
  { left: 38.33, top: 62.66, width: 23.33, height: 19.33 },
  { left: 64.66, top: 62.66, width: 23.33, height: 19.33 },
];
// horizontal arrows within each row, plus a trailing/leading pair at each
// row break (like a text line-wrap: the row "runs off" to the right and
// the next row "arrives" from the left, instead of a down arrow)
const CARD_ARROWS = [
  { left: 36.83, top: 27.67, glyph: '→' },
  { left: 63.16, top: 27.67, glyph: '→' },
  { left: 92,    top: 27.67, glyph: '→' },
  { left: 8,     top: 50,    glyph: '→' },
  { left: 36.83, top: 50,    glyph: '→' },
  { left: 63.16, top: 50,    glyph: '→' },
  { left: 92,    top: 50,    glyph: '→' },
  { left: 8,     top: 72.33, glyph: '→' },
  { left: 36.83, top: 72.33, glyph: '→' },
  { left: 63.16, top: 72.33, glyph: '→' },
];
const PILE_SPOT = { left: 50, top: 50, width: 20, height: 16.5 };
const CARD_TILTS = [-9, 6, -4, 8, -6, 3, -8, 5, -2];
const CARD_LABELS = {
  1: 'Бисмиллях', 2: 'Руки', 3: 'Рот', 4: 'Нос', 5: 'Лицо',
  6: 'Локти', 7: 'Волосы', 8: 'Уши', 9: 'Ступни',
};

let cardsScattered = false;
let winTriggered = false;
let selectedCard = null;
// cardSlotOf[cardIndex] = slotIndex once scattered
let cardSlotOf = [];

function buildCardBoard() {
  const slotsWrap = el('card-slots');
  CARD_SLOTS.forEach(s => {
    const d = document.createElement('div');
    d.className = 'card-slot';
    d.style.left = s.left + '%';
    d.style.top = s.top + '%';
    d.style.width = s.width + '%';
    d.style.height = s.height + '%';
    slotsWrap.appendChild(d);
  });

  const arrowsWrap = el('card-arrows');
  CARD_ARROWS.forEach(a => {
    const span = document.createElement('span');
    span.className = 'card-arrow';
    span.style.left = a.left + '%';
    span.style.top = a.top + '%';
    span.textContent = a.glyph;
    arrowsWrap.appendChild(span);
  });

  const layer = el('card-layer');
  for (let i = 1; i <= 9; i++) {
    const img = document.createElement('img');
    img.className = 'wudu-card';
    img.id = 'wudu-card-' + i;
    img.src = 'assets/img/room2/cards/card-' + i + '.jpg?v=1';
    img.dataset.card = i;
    img.style.left = (PILE_SPOT.left - PILE_SPOT.width / 2) + '%';
    img.style.top = (PILE_SPOT.top - PILE_SPOT.height / 2) + '%';
    img.style.width = PILE_SPOT.width + '%';
    img.style.height = PILE_SPOT.height + '%';
    img.style.transform = `rotate(${CARD_TILTS[i - 1]}deg)`;
    img.style.zIndex = i;
    layer.appendChild(img);
    img.addEventListener('click', () => onCardClick(i));
  }
}

function shuffledSlots() {
  const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function placeCardAtSlot(cardIndex, slotIndex) {
  const img = el('wudu-card-' + cardIndex);
  const s = CARD_SLOTS[slotIndex];
  img.style.left = s.left + '%';
  img.style.top = s.top + '%';
  img.style.width = s.width + '%';
  img.style.height = s.height + '%';
  img.style.transform = 'rotate(0deg)';
}

el('hit-card-pile').addEventListener('click', () => {
  if (!state.norGreeted || cardsScattered) return;
  playSfx(el('audio-cardshuffle'), -8);
  cardsScattered = true;
  el('hit-card-pile').classList.add('hidden');
  const order = shuffledSlots();
  for (let i = 1; i <= 9; i++) {
    cardSlotOf[i] = order[i - 1];
    const delay = (i - 1) * 70;
    setTimeout(() => placeCardAtSlot(i, order[i - 1]), delay);
  }
  setTimeout(checkCardsWin, 9 * 70 + 650);
});

function onCardClick(cardIndex) {
  if (!state.norGreeted || !cardsScattered || winTriggered) return;
  playSfx(el('audio-cardshuffle'), -8);
  if (selectedCard === null) {
    selectedCard = cardIndex;
    el('wudu-card-' + cardIndex).classList.add('selected');
    return;
  }
  if (selectedCard === cardIndex) {
    el('wudu-card-' + cardIndex).classList.remove('selected');
    selectedCard = null;
    return;
  }
  // swap the two cards' slots
  const slotA = cardSlotOf[selectedCard];
  const slotB = cardSlotOf[cardIndex];
  cardSlotOf[selectedCard] = slotB;
  cardSlotOf[cardIndex] = slotA;
  placeCardAtSlot(selectedCard, slotB);
  placeCardAtSlot(cardIndex, slotA);
  el('wudu-card-' + selectedCard).classList.remove('selected');
  selectedCard = null;
  setTimeout(checkCardsWin, 650);
}

// ---- win sequence: success popup -> reward card slides in -> collect ----

function checkCardsWin() {
  if (winTriggered || !cardsScattered) return;
  for (let i = 1; i <= 9; i++) {
    if (cardSlotOf[i] !== i - 1) return;
  }
  winTriggered = true;
  playSfx(el('audio-puzzlesolved'), -10);
  const narrator = el('audio-narrator-cards');
  routeToMaster(narrator, 'narrator');
  narrator.currentTime = 0;
  narrator.volume = dbToVol(-6);
  narrator.play();
  el('cards-success').classList.remove('hidden');
}

// the player taps the success message (once they've read it) to make the
// reward card drop in
el('cards-success').addEventListener('click', () => {
  const reward = el('card-reward');
  if (!reward.classList.contains('hidden')) return; // already dropped
  playSfx(el('audio-move'), -12);
  reward.classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    reward.classList.add('drop-in');
  }));
});

el('card-reward').addEventListener('click', () => {
  el('cards-success').classList.add('hidden');
  playSfx(el('audio-cardshuffle'), -8);

  const reward = el('card-reward');
  const startRect = reward.getBoundingClientRect();

  // open the inventory first so its next empty slot exists to fly into
  el('inventory-wrap').classList.add('open');

  requestAnimationFrame(() => {
    // the card always claims the very first slot, pushing everything else along
    const firstSlot = document.querySelectorAll('#inventory-bar .inv-slot')[0];
    const targetRect = firstSlot
      ? firstSlot.getBoundingClientRect()
      : { left: startRect.left, top: startRect.top, width: 0, height: 0 };

    // freeze the card at its current spot, then switch to fixed so it can
    // fly anywhere on screen, then animate it into the inventory slot
    reward.style.left = startRect.left + 'px';
    reward.style.top = startRect.top + 'px';
    reward.style.width = startRect.width + 'px';
    reward.style.height = startRect.height + 'px';
    reward.classList.add('flying-to-inventory');
    reward.classList.remove('drop-in');

    requestAnimationFrame(() => requestAnimationFrame(() => {
      reward.style.left = targetRect.left + 'px';
      reward.style.top = targetRect.top + 'px';
      reward.style.width = targetRect.width + 'px';
      reward.style.height = targetRect.height + 'px';
      reward.style.opacity = '0';
    }));

    setTimeout(() => {
      reward.classList.add('hidden');
      reward.classList.remove('flying-to-inventory');
      reward.removeAttribute('style');
      collectItem('card-1', CARD_LABELS[1], 'assets/img/room2/cards/card-1.jpg?v=1', null, null, true);

      setTimeout(() => {
        state.cardsSolved = true;
        updateBathVisual();
        showScreen('bath');
        playBathDialogue('А эта карточка мне ещё пригодится на будущие дела!', el('audio-nor3'));
        el('hit-bath-door').classList.add('hidden'); // can't leave mid-wash; re-enabled once Nor's out
        // wait for a tap anywhere in the scene instead of an auto-timer
        el('scene-bath').addEventListener('click', () => {
          playSfx(el('audio-move'), -12);
          playCutscene();
        }, { once: true });
      }, 500);
    }, 600);
  });
});

function playBathDialogue(text, audioEl) {
  if (activeDialogueStop) activeDialogueStop();
  const box = el('bath-dialogue');
  el('bath-dialogue-text').textContent = text;
  box.classList.remove('hidden');
  clearTimeout(playBathDialogue._t);
  if (audioEl) {
    routeToMaster(audioEl, true);
    audioEl.currentTime = 0;
    audioEl.volume = dbToVol(0);
    audioEl.play();
    const finish = () => {
      box.classList.add('hidden');
      audioEl.removeEventListener('ended', finish);
      playBathDialogue._stop = null;
      if (activeDialogueStop === stopBathDialogue) activeDialogueStop = null;
    };
    audioEl.addEventListener('ended', finish);
    playBathDialogue._stop = () => { audioEl.pause(); finish(); };
  } else {
    playBathDialogue._stop = null;
    playBathDialogue._t = setTimeout(() => {
      box.classList.add('hidden');
      if (activeDialogueStop === stopBathDialogue) activeDialogueStop = null;
    }, 8000);
  }
  activeDialogueStop = stopBathDialogue;
}
function stopBathDialogue() {
  clearTimeout(playBathDialogue._t);
  if (playBathDialogue._stop) playBathDialogue._stop();
  else el('bath-dialogue').classList.add('hidden');
  if (activeDialogueStop === stopBathDialogue) activeDialogueStop = null;
}
el('bath-dialogue-skip').addEventListener('click', stopBathDialogue);

function playCardsDialogue(text, audioEl) {
  if (activeDialogueStop) activeDialogueStop();
  const box = el('cards-dialogue');
  el('cards-dialogue-text').textContent = text;
  box.classList.remove('hidden');
  clearTimeout(playCardsDialogue._t);
  if (audioEl) {
    routeToMaster(audioEl, true);
    audioEl.currentTime = 0;
    audioEl.volume = dbToVol(0);
    audioEl.play();
    const finish = () => {
      box.classList.add('hidden');
      audioEl.removeEventListener('ended', finish);
      playCardsDialogue._stop = null;
      if (activeDialogueStop === stopCardsDialogue) activeDialogueStop = null;
    };
    audioEl.addEventListener('ended', finish);
    playCardsDialogue._stop = () => { audioEl.pause(); finish(); };
  } else {
    playCardsDialogue._stop = null;
    playCardsDialogue._t = setTimeout(() => {
      box.classList.add('hidden');
      if (activeDialogueStop === stopCardsDialogue) activeDialogueStop = null;
    }, 8000);
  }
  activeDialogueStop = stopCardsDialogue;
}
function stopCardsDialogue() {
  clearTimeout(playCardsDialogue._t);
  if (playCardsDialogue._stop) playCardsDialogue._stop();
  else el('cards-dialogue').classList.add('hidden');
  if (activeDialogueStop === stopCardsDialogue) activeDialogueStop = null;
}
el('cards-dialogue-skip').addEventListener('click', stopCardsDialogue);

function playRoom2Dialogue(text, audioEl) {
  if (activeDialogueStop) activeDialogueStop();
  const box = el('room2-dialogue');
  el('room2-dialogue-text').textContent = text;
  box.classList.remove('hidden');
  clearTimeout(playRoom2Dialogue._t);
  if (audioEl) {
    routeToMaster(audioEl, true);
    audioEl.currentTime = 0;
    audioEl.volume = dbToVol(0);
    audioEl.play();
    const finish = () => {
      box.classList.add('hidden');
      audioEl.removeEventListener('ended', finish);
      playRoom2Dialogue._stop = null;
      if (activeDialogueStop === stopRoom2Dialogue) activeDialogueStop = null;
    };
    audioEl.addEventListener('ended', finish);
    playRoom2Dialogue._stop = () => { audioEl.pause(); finish(); };
  } else {
    playRoom2Dialogue._stop = null;
    playRoom2Dialogue._t = setTimeout(() => {
      box.classList.add('hidden');
      if (activeDialogueStop === stopRoom2Dialogue) activeDialogueStop = null;
    }, 8000);
  }
  activeDialogueStop = stopRoom2Dialogue;
}
function stopRoom2Dialogue() {
  clearTimeout(playRoom2Dialogue._t);
  if (playRoom2Dialogue._stop) playRoom2Dialogue._stop();
  else el('room2-dialogue').classList.add('hidden');
  if (activeDialogueStop === stopRoom2Dialogue) activeDialogueStop = null;
}
el('room2-dialogue-skip').addEventListener('click', () => {
  // skipping the bag line specifically jumps straight to its follow-up
  // instead of just closing the box and leaving the timer to run out
  if (pendingBagFollowUp) {
    const fn = pendingBagFollowUp;
    pendingBagFollowUp = null;
    fn();
    return;
  }
  stopRoom2Dialogue();
});

el('nor-redress-img').addEventListener('click', () => {
  if (inventoryDragActive) return; // this click is completing an item drop, not a plain tap
  if (lastRoom2Line) {
    playRoom2Dialogue(lastRoom2Line.text, el(lastRoom2Line.audioId));
  } else {
    playRoom2Dialogue('Омовение я сделала, теперь надо одеться для намаза.', el('audio-nor4'));
  }
});

// ---------------- room4: Nor by the door (after the carpet is found) ----------------

let lastRoom4Line = null; // { text, audioId } of the most recent thing Nor said in room4 — tapping her repeats it

function playRoom4Dialogue(text, audioEl, holdMs) {
  if (activeDialogueStop) activeDialogueStop();
  const box = el('room4-dialogue');
  // Nor stands below the bubble once she has appeared by the door: tail points down at her
  box.classList.toggle('nor-below', !el('nor-room4-img').classList.contains('hidden'));
  el('room4-dialogue-text').textContent = text;
  box.classList.remove('hidden');
  clearTimeout(playRoom4Dialogue._t);
  if (audioEl) {
    routeToMaster(audioEl, true);
    audioEl.currentTime = 0;
    audioEl.volume = dbToVol(0);
    audioEl.play();
    const finish = () => {
      box.classList.add('hidden');
      audioEl.removeEventListener('ended', finish);
      playRoom4Dialogue._stop = null;
      if (activeDialogueStop === stopRoom4Dialogue) activeDialogueStop = null;
    };
    audioEl.addEventListener('ended', finish);
    playRoom4Dialogue._stop = () => { audioEl.pause(); finish(); };
  } else {
    playRoom4Dialogue._stop = null;
    playRoom4Dialogue._t = setTimeout(() => {
      box.classList.add('hidden');
      if (activeDialogueStop === stopRoom4Dialogue) activeDialogueStop = null;
    }, holdMs || 8000);
  }
  activeDialogueStop = stopRoom4Dialogue;
}
function stopRoom4Dialogue() {
  clearTimeout(playRoom4Dialogue._t);
  if (playRoom4Dialogue._stop) playRoom4Dialogue._stop();
  else el('room4-dialogue').classList.add('hidden');
  if (activeDialogueStop === stopRoom4Dialogue) activeDialogueStop = null;
}
el('room4-dialogue-skip').addEventListener('click', stopRoom4Dialogue);

el('nor-room4-img').addEventListener('click', () => {
  if (lastRoom4Line) {
    playRoom4Dialogue(lastRoom4Line.text, lastRoom4Line.audioId ? el(lastRoom4Line.audioId) : null);
  }
});

// ---------------- wudu wash cutscene ----------------

const CUTSCENE_STEP_MS = 4000;

function stopSfx(audioEl) {
  audioEl.pause();
  audioEl.currentTime = 0;
}

let cutsceneTimeouts = [];
let cutsceneAudios = [];

function finishCutscene() {
  cutsceneAudios.forEach(stopSfx);
  state.norLeftBath = true;
  state.norOutfitStage = 0;
  updateBathVisual();
  el('nor-redress-img').classList.remove('hidden');
  playSfx(el('audio-door'), -7);
  el('hit-bath-door').classList.remove('hidden'); // free to follow her out now
  showScreen('bath');
}

function skipCutscene() {
  cutsceneTimeouts.forEach(clearTimeout);
  cutsceneTimeouts = [];
  finishCutscene();
}

function playCutscene() {
  showScreen('cutscene');
  const frames = [1, 2, 3, 4].map(i => el('cutscene-' + i));
  const showFrame = (idx) => frames.forEach((f, i) => f.classList.toggle('active', i === idx));
  showFrame(0);

  const valve = el('audio-water-valve');
  const sink = el('audio-water-in-sink');
  const faucet = el('audio-faucet-sink');
  const drops = el('audio-drops');
  const towel = el('audio-towel');
  cutsceneAudios = [valve, sink, faucet, drops, towel];

  playSfx(valve, -10);
  cutsceneTimeouts = [
    setTimeout(() => playSfx(sink, -6), 2000),

    setTimeout(() => {
      stopSfx(valve);
      stopSfx(sink);
      showFrame(1);
      playSfx(faucet, 0);
    }, CUTSCENE_STEP_MS),

    setTimeout(() => {
      stopSfx(faucet);
      showFrame(2);
      playSfx(drops, 0);
    }, CUTSCENE_STEP_MS * 2),

    setTimeout(() => {
      stopSfx(drops);
      showFrame(3);
      playSfx(towel, -6);
    }, CUTSCENE_STEP_MS * 3),

    setTimeout(() => {
      cutsceneTimeouts = [];
      finishCutscene();
    }, CUTSCENE_STEP_MS * 4),
  ];
}

el('cutscene-skip').addEventListener('click', skipCutscene);

// ---------------- intro cutscene ----------------

const INTRO_NARRATORS = {
  1: 'audio-narrator-intro-1',
  2: 'audio-narrator-intro-2',
  3: 'audio-narrator-intro-3',
  4: 'audio-narrator-intro-4',
};
const INTRO_DARKEN_MS = 500;

let introTimeouts = [];

function clearIntroTimeouts() {
  introTimeouts.forEach(clearTimeout);
  introTimeouts = [];
}

function stopIntroNarrators() {
  Object.values(INTRO_NARRATORS).forEach(id => {
    const a = el(id);
    a.pause();
    a.currentTime = 0;
    a.onended = null;
  });
}

function showIntroFrame(n) {
  for (let i = 1; i <= 4; i++) {
    el('intro-frame-' + i).classList.toggle('active', i === n);
  }
  el('intro-yes-btn').classList.toggle('hidden', n !== 4);
}

function playIntroNarrator(n) {
  const audio = el(INTRO_NARRATORS[n]);
  routeToMaster(audio, 'narrator');
  audio.currentTime = 0;
  audio.volume = dbToVol(-6);
  audio.onended = () => {
    if (n < 4) introDarkenTo(n + 1);
  };
  audio.play();
}

// card change = fade to black, swap the picture underneath, fade back up —
// timed to start the moment the current line finishes narrating
function introDarkenTo(n) {
  el('intro-dim').classList.add('show-transition');
  introTimeouts.push(setTimeout(() => {
    showIntroFrame(n);
    playIntroNarrator(n);
    el('intro-dim').classList.remove('show-transition');
  }, INTRO_DARKEN_MS));
}

function startIntro() {
  el('inventory-wrap').classList.add('hidden');
  showScreen('intro');
  clearIntroTimeouts();
  stopIntroNarrators();
  el('intro-dim').classList.remove('show-transition');
  el('intro-dim').classList.add('show-hint');
  el('intro-play-btn').classList.remove('hidden');
  showIntroFrame(1);
}

function finishIntro() {
  clearIntroTimeouts();
  stopIntroNarrators();
  el('inventory-wrap').classList.remove('hidden');
  showScreen('room');
}

el('intro-play-btn').addEventListener('click', () => {
  playSfx(el('audio-move'), -12);
  el('intro-play-btn').classList.add('hidden');
  el('intro-dim').classList.remove('show-hint');
  introTimeouts.push(setTimeout(() => playIntroNarrator(1), 200));
});

el('intro-yes-btn').addEventListener('click', () => {
  playSfx(el('audio-move'), -12);
  finishIntro();
});

// ---------------- init ----------------

buildInventoryUI();
buildCardBoard();
updateCardsView();
applyLoadedState();

function hasSavedProgress() {
  try {
    return !!localStorage.getItem(SAVE_KEY);
  } catch (e) {
    return false;
  }
}

// switching languages carries the save straight over — no need to ask
if (hasSavedProgress() && new URLSearchParams(location.search).has('continue')) {
  loadProgress();
  updateCardsView();
  applyLoadedState();
} else if (hasSavedProgress()) {
  el('save-prompt').classList.remove('hidden');
} else {
  startIntro();
}

el('save-prompt-continue').addEventListener('click', () => {
  el('save-prompt').classList.add('hidden');
  loadProgress();
  updateCardsView();
  applyLoadedState();
});

el('save-prompt-restart').addEventListener('click', () => {
  localStorage.removeItem(SAVE_KEY);
  el('save-prompt').classList.add('hidden');
});

// ---------------- debug/test panel (add ?debug to the URL to see it) ----------------

if (location.search.includes('debug')) {
  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,0.85);color:#fff;padding:8px;font:12px sans-serif;display:flex;flex-wrap:wrap;gap:6px;';
  const btn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:6px 10px;cursor:pointer;border-radius:6px;border:1px solid #888;background:#222;color:#fff;';
    b.addEventListener('click', fn);
    panel.appendChild(b);
  };
  btn('Вступление', () => startIntro());
  btn('Комната', () => showScreen('room'));
  btn('Окно', () => showScreen('window'));
  btn('Часы', () => showScreen('clock'));
  btn('Расписание', () => showScreen('schedule'));
  btn('Разбудить Нор', () => { state.norAwake = true; state.norGreeted = true; wakeNor(); });
  btn('Комната 2', () => showScreen('room2'));
  btn('Шкаф (крупный план)', () => {
    wardrobeOpen = true;
    el('wardrobe-img').src = 'assets/img/room2/wardrobe-open.webp?v=2';
    showScreen('wardrobe');
  });
  // jumping straight to a later stage shouldn't leave earlier-stage items
  // sitting in the inventory, and shouldn't be missing ones already earned —
  // this puts the Бисмиллях reward card where it belongs (never consumed,
  // so it should be present from the moment the cards are solved onward)
  function debugMarkCardsSolved() {
    state.cardsSolved = true;
    winTriggered = true;
    if (!state.inventory.some(it => it.id === 'card-1')) {
      collectItem('card-1', CARD_LABELS[1], 'assets/img/room2/cards/card-1.jpg?v=1', null, null, true);
    }
  }
  btn('Ванная', () => { updateBathVisual(); showScreen('bath'); });
  btn('Карточки', () => { updateCardsView(); showScreen('cards'); });
  btn('Разложить карточки', () => {
    if (!cardsScattered) el('hit-card-pile').click();
  });
  btn('Решить карточки', () => {
    if (!cardsScattered) el('hit-card-pile').click();
    setTimeout(() => {
      for (let i = 1; i <= 9; i++) cardSlotOf[i] = i - 1;
      checkCardsWin();
      el('cards-success').classList.add('hidden');
      debugMarkCardsSolved();
      updateBathVisual();
    }, 800);
  });
  btn('Катсцена омовения', () => playCutscene());
  btn('Переодевание', () => {
    // clean slate every time, so the whole sequence can be replayed from scratch
    state.inventory = [];
    renderInventory();
    state.norLeftBath = true;
    state.norOutfitStage = 0;
    el('nor-redress-img').src = 'assets/img/redress/redress-1.webp?v=1';
    el('nor-redress-img').classList.remove('hidden');
    const nasheed = el('audio-nasheed');
    routeToMaster(nasheed, false);
    nasheed.volume = dbToVol(-16);
    nasheed.play();
    // wudu (and the Бисмиллях card it earns) already happened before dressing
    debugMarkCardsSolved();
    collectItem('dress', 'Платье', 'assets/img/room2/dress-item.webp?v=2', null, null, false);
    collectItem('socks', 'Носки', 'assets/img/room2/socks-item.webp?v=1', null, null, false);
    collectItem('hijab', 'Хиджаб', 'assets/img/room2/hijab-item.webp?v=1', null, null, false);
    collectItem('boots', 'Ботинки', 'assets/img/room2/boots-item.webp?v=1', null, null, false);
    collectItem('bag', 'Сумка', 'assets/img/room2/bag-item.webp?v=2', null, null, false);
    restoreCollectedItemSprites();
    showScreen('room2');
  });
  btn('Нор оделась', () => {
    state.norLeftBath = true;
    state.norOutfitStage = NOR_OUTFIT_SEQUENCE.length;
    state.readyForNamaz = true;
    // every dressing item has already been worn (and dropped from the
    // inventory) by this point — only the Бисмиллях card should remain
    ['dress', 'socks', 'hijab', 'boots', 'bag'].forEach(removeInventoryItem);
    debugMarkCardsSolved();
    restoreCollectedItemSprites();
    el('nor-redress-img').src = NOR_OUTFIT_STEPS.bag.src;
    el('nor-redress-img').classList.remove('hidden');
    updateRoom4Access();
    showScreen('room2');
  });
  btn('Нор знает компас', () => {
    // Nor has seen how the compass works and said it can be opened: tap the compass in the inventory
    state.readyForNamaz = true;
    state.norLeftBath = true;
    state.norOutfitStage = NOR_OUTFIT_SEQUENCE.length;
    state.norRoom4Shown = true;
    state.carpetPlaced = true;
    el('carpet-placed-img').classList.remove('hidden');
    el('hints-wrap').classList.remove('hidden');
    state.hintsFound = { kibla: true, compass: true };
    updateHintsUI();
    state.compassHintGiven = true;
    state.compassOpenLineDone = true;
    state.compassIntroDone = false;
    state.compassWallLines = { room: false, room2: false, room3: false };
    compassAnswers = { room: null, room2: null, room3: null, room4: null };
    cancelCompassDemo();
    el('compass-overlay').classList.add('hidden');
    updateNorFollow();
    el('nor-redress-img').classList.add('hidden');
    el('nor-room4-img').classList.remove('hidden');
    if (!state.inventory.some(it => it.id === 'compass')) {
      collectItem('compass', 'Компас', 'assets/img/room4/compas-big.webp?v=1', 'compas-big-img', 'hit-compas-big');
      el('compas-on-tumbochka-img').style.opacity = '0';
    }
    updateRoom4Access();
    showScreen('room4');
    el('inventory-wrap').classList.add('open');
    saveProgress();
  });
  btn('Инвентарь', () => el('inventory-wrap').classList.toggle('open'));
  document.body.appendChild(panel);
}
