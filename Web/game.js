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
  'norOutfitStage', 'inventory',
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
  if (stage <= 0) return 'assets/img/redress/redress-1.png?v=1';
  const itemId = NOR_OUTFIT_SEQUENCE[stage - 1];
  return NOR_OUTFIT_STEPS[itemId].src;
}

// re-derives every visual from the restored state — always resumes on the
// room screen (the stable hub) rather than mid-puzzle or mid-animation
function applyLoadedState() {
  updateBedSprite();
  updateWindowVisual();
  updateClockVisuals();
  renderInventory();

  if (state.norAwake) {
    wakeNor();
    if (state.norSeenInBath) {
      el('nor-box').classList.add('hidden');
      el('hit-nor').classList.add('hidden');
    }
  }

  updateBathVisual();

  if (state.norLeftBath) {
    el('nor-redress-img').src = redressSrcForStage(state.norOutfitStage);
    el('nor-redress-img').classList.remove('hidden');
  }
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  el('scene-' + name).classList.add('active');
  updateClockLoopForScreen(name);
  updateBathAmbience(name);
  saveProgress();
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

function playLine(audioEl, text, pose) {
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
    el('nor-img').src = 'assets/img/nor/neutral-v2.png';
    audioEl.removeEventListener('ended', finish);
  };
  audioEl.addEventListener('ended', finish);
}

// ---------------- window ----------------

function updateWindowVisual() {
  const src = {
    closed: 'assets/img/window/closed-2000.png?v=3',
    open: 'assets/img/window/open-2000.png?v=3',
    mosque: 'assets/img/window/mosque-2000.png?v=3',
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

function tick() {
  playSfx(el('audio-buttonclick'), -8);
  updateClockVisuals();
  checkClockCorrect();
}

function checkClockCorrect() {
  if (!state.clockCorrect && state.hour === TARGET_HOUR && state.minute === TARGET_MINUTE) {
    state.clockCorrect = true;
    updateWindowVisual();
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
    sleeping: 'assets/img/bed/sleeping.png',
    getup: 'assets/img/bed/getup.png',
    fixed: 'assets/img/bed/fixed.png',
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
    'assets/img/nor/finger-up-v2.png'
  );
}

// ---------------- Nor ----------------

function wakeNor() {
  state.norAwake = true;
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
    'assets/img/nor/arms-out-v4.png'
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

// warm the browser's cache/decoder for the big room2/bath images so there's
// no partial-paint flash the first time each screen is shown
[
  'assets/img/room2/door-open.png?v=1',
  'assets/img/room2/bath-no-nor.png?v=2',
  'assets/img/room2/bath-nor.png?v=2',
  'assets/img/room2/wardrobe-open.png?v=1',
  'assets/img/room2/wardrobe-closeup.png?v=3',
  'assets/img/room2/cards/cardkit-bg.png?v=1',
  'assets/img/room2/bath-cards-solved.png?v=1',
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

function updateBathVisual() {
  if (state.norLeftBath) {
    el('bath-img').src = 'assets/img/room2/bath-no-nor.png?v=2';
    el('cardkit-bath-prop').classList.remove('hidden');
    return;
  }
  el('cardkit-bath-prop').classList.add('hidden');
  el('bath-img').src = state.cardsSolved
    ? 'assets/img/room2/bath-cards-solved.png?v=1'
    : state.norAwake
      ? 'assets/img/room2/bath-nor.png?v=2'
      : 'assets/img/room2/bath-no-nor.png?v=2';
}

el('hit-door').addEventListener('click', () => {
  if (state.talking || doorBusy) return;
  doorBusy = true;
  playSfx(el('audio-door'), -7);
  updateBathVisual();
  el('door-img').src = 'assets/img/room2/door-open.png?v=1';
  setTimeout(() => {
    showScreen('bath');
    el('door-img').src = 'assets/img/room2/door-closed.png?v=1';
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
    if (state.norAwake) {
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
    el('wardrobe-img').src = 'assets/img/room2/wardrobe-open.png?v=1';
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

  function attach(slot, x, y) {
    const img = slot.querySelector('img');
    if (!img) return;
    inventoryDragActive = true;
    sourceSlot = slot;
    slot.classList.add('drag-source');
    const rect = img.getBoundingClientRect();
    ghost = document.createElement('img');
    ghost.src = img.src;
    ghost.dataset.item = img.dataset.item;
    ghost.className = 'inv-drag-ghost';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.left = (x - rect.width / 2) + 'px';
    ghost.style.top = (y - rect.height / 2) + 'px';
    document.body.appendChild(ghost);
  }

  // item flies back home on the second click unless it's dropped on a
  // valid target (right now: the right item dropped on Nor dresses her up)
  function flyBack() {
    playSfx(el('audio-backtoinv'), -6);
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

  function release(target) {
    if (!ghost) return;
    const itemId = ghost.dataset.item;
    const norImg = el('nor-redress-img');
    const droppedOnNor = norImg && !norImg.classList.contains('hidden') &&
      target && target.closest && target.closest('#nor-redress-img');

    if (droppedOnNor && NOR_OUTFIT_STEPS[itemId] && outfitStepAllowed(itemId)) {
      norImg.src = NOR_OUTFIT_STEPS[itemId].src;
      state.norOutfitStage++;
      playSfx(el('audio-clothes'), -8, 0.5);
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
            playRoom2Dialogue(followUpText, el('audio-nor9'));
            lastRoom2Line = { text: followUpText, audioId: 'audio-nor9' };
          };
          if (stepAudio) {
            stepAudio.addEventListener('ended', followUp, { once: true });
          } else {
            setTimeout(followUp, 8000);
          }
        }
      }
      return;
    }
    flyBack();
  }

  window.addEventListener('pointermove', (e) => {
    if (!ghost) return;
    ghost.style.left = (e.clientX - ghost.offsetWidth / 2) + 'px';
    ghost.style.top = (e.clientY - ghost.offsetHeight / 2) + 'px';
  });

  window.addEventListener('click', (e) => {
    if (ghost) {
      release(e.target);
      return;
    }
    const slot = e.target.closest && e.target.closest('.inv-slot.filled');
    if (slot && bar.contains(slot)) {
      attach(slot, e.clientX, e.clientY);
    }
  });
}

// which inventory item, dropped on Nor, advances her outfit to which sprite —
// must be worn strictly in this order (each needs the previous one already on)
const NOR_OUTFIT_SEQUENCE = ['dress', 'socks', 'hijab', 'boots', 'bag'];
const NOR_OUTFIT_STEPS = {
  dress: {
    src: 'assets/img/redress/redress-2.png?v=1',
    line: 'Моё любимое платье! Его подарил мне папа, когда мы путешествовали по Марокко.',
    audio: 'audio-nor5',
  },
  socks: {
    src: 'assets/img/redress/redress-3.png?v=1',
  },
  hijab: {
    src: 'assets/img/redress/redress-4.png?v=1',
    line: 'Хиджаб — это моя скромность и послушание Аллаху. Я люблю свой хиджаб!',
    audio: 'audio-nor6',
  },
  boots: {
    src: 'assets/img/redress/redress-5.png?v=1',
    line: 'Для намаза ботинки мне не нужны, я их сниму во время молитвы и снова надену перед выходом.',
    audio: 'audio-nor7',
  },
  bag: {
    src: 'assets/img/redress/redress-6.png?v=1',
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
  collectItem('hijab', 'Хиджаб', 'assets/img/room2/hijab-item.png?v=1', 'hijab-img', 'hit-hijab');
});
el('hit-dress').addEventListener('click', () => {
  if (state.talking) return;
  collectItem('dress', 'Платье', 'assets/img/room2/dress-item.png?v=1', 'dress-img', 'hit-dress');
});
el('hit-socks').addEventListener('click', () => {
  if (state.talking) return;
  collectItem('socks', 'Носки', 'assets/img/room2/socks-item.png?v=1', 'socks-img', 'hit-socks');
});
el('hit-bag').addEventListener('click', () => {
  if (state.talking) return;
  collectItem('bag', 'Сумка', 'assets/img/room2/bag-item.png?v=2', 'bag-img', 'hit-bag');
});
el('hit-boots').addEventListener('click', () => {
  if (state.talking) return;
  collectItem('boots', 'Ботинки', 'assets/img/room2/boots-item.png?v=1', 'boots-img', 'hit-boots');
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
    };
    audioEl.addEventListener('ended', finish);
  } else {
    playBathDialogue._t = setTimeout(() => box.classList.add('hidden'), 8000);
  }
}

function playCardsDialogue(text, audioEl) {
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
    };
    audioEl.addEventListener('ended', finish);
  } else {
    playCardsDialogue._t = setTimeout(() => box.classList.add('hidden'), 8000);
  }
}

function playRoom2Dialogue(text, audioEl) {
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
    };
    audioEl.addEventListener('ended', finish);
  } else {
    playRoom2Dialogue._t = setTimeout(() => box.classList.add('hidden'), 8000);
  }
}

el('nor-redress-img').addEventListener('click', () => {
  if (inventoryDragActive) return; // this click is completing an item drop, not a plain tap
  if (lastRoom2Line) {
    playRoom2Dialogue(lastRoom2Line.text, el(lastRoom2Line.audioId));
  } else {
    playRoom2Dialogue('Омовение я сделала, теперь надо одеться для намаза.', el('audio-nor4'));
  }
});

// ---------------- wudu wash cutscene ----------------

const CUTSCENE_STEP_MS = 4000;

function stopSfx(audioEl) {
  audioEl.pause();
  audioEl.currentTime = 0;
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

  playSfx(valve, -10);
  setTimeout(() => playSfx(sink, -6), 2000);

  setTimeout(() => {
    stopSfx(valve);
    stopSfx(sink);
    showFrame(1);
    playSfx(faucet, 0);
  }, CUTSCENE_STEP_MS);

  setTimeout(() => {
    stopSfx(faucet);
    showFrame(2);
    playSfx(drops, 0);
  }, CUTSCENE_STEP_MS * 2);

  setTimeout(() => {
    stopSfx(drops);
    showFrame(3);
    playSfx(towel, -6);
  }, CUTSCENE_STEP_MS * 3);

  setTimeout(() => {
    stopSfx(towel);
    state.norLeftBath = true;
    state.norOutfitStage = 0;
    updateBathVisual();
    el('nor-redress-img').classList.remove('hidden');
    playSfx(el('audio-door'), -7);
    el('hit-bath-door').classList.remove('hidden'); // free to follow her out now
    showScreen('bath');
  }, CUTSCENE_STEP_MS * 4);
}

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
  btn('Комната', () => showScreen('room'));
  btn('Окно', () => showScreen('window'));
  btn('Часы', () => showScreen('clock'));
  btn('Расписание', () => showScreen('schedule'));
  btn('Разбудить Нор', () => { state.norAwake = true; state.norGreeted = true; wakeNor(); });
  btn('Комната 2', () => showScreen('room2'));
  btn('Шкаф (крупный план)', () => {
    wardrobeOpen = true;
    el('wardrobe-img').src = 'assets/img/room2/wardrobe-open.png?v=1';
    showScreen('wardrobe');
  });
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
    }, 800);
  });
  btn('Катсцена омовения', () => playCutscene());
  btn('Переодевание', () => {
    // clean slate every time, so the whole sequence can be replayed from scratch
    state.inventory = [];
    renderInventory();
    state.norLeftBath = true;
    state.norOutfitStage = 0;
    el('nor-redress-img').src = 'assets/img/redress/redress-1.png?v=1';
    el('nor-redress-img').classList.remove('hidden');
    const nasheed = el('audio-nasheed');
    routeToMaster(nasheed, false);
    nasheed.volume = dbToVol(-16);
    nasheed.play();
    collectItem('dress', 'Платье', 'assets/img/room2/dress-item.png?v=2', null, null, false);
    collectItem('socks', 'Носки', 'assets/img/room2/socks-item.png?v=1', null, null, false);
    collectItem('hijab', 'Хиджаб', 'assets/img/room2/hijab-item.png?v=1', null, null, false);
    collectItem('boots', 'Ботинки', 'assets/img/room2/boots-item.png?v=1', null, null, false);
    collectItem('bag', 'Сумка', 'assets/img/room2/bag-item.png?v=2', null, null, false);
    showScreen('room2');
  });
  btn('Инвентарь', () => el('inventory-wrap').classList.toggle('open'));
  document.body.appendChild(panel);
}
