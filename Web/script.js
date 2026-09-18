const el = (id) => document.getElementById(id);

const state = {
  window: 'closed', // closed -> open -> mosque
  clockCorrect: false,
  hour: 12,
  minute: 0,
  bed: 'sleeping', // sleeping -> getup -> fixed
  norAwake: false,
  talking: false,
};

const TARGET_HOUR = 5;
const TARGET_MINUTE = 30;
const MINUTE_STEP = 5;

// ---------- dialogue ----------

function playLine(audioEl, text) {
  state.talking = true;
  el('dialogue').classList.remove('hidden');
  el('dialogue-text').textContent = text;
  audioEl.currentTime = 0;
  audioEl.play();

  const finish = () => {
    state.talking = false;
    el('dialogue').classList.add('hidden');
    audioEl.removeEventListener('ended', finish);
  };
  audioEl.addEventListener('ended', finish);
}

// ---------- window ----------

function updateWindowSprite() {
  const src = {
    closed: 'assets/img/window/closed.png',
    open: 'assets/img/window/open.png',
    mosque: 'assets/img/window/mosque.png',
  }[state.window];
  el('window-sprite').src = src;
  el('window-closeup-sprite').src = src;
}

function openWindowCloseup() {
  if (state.talking) return;
  el('window-closeup').classList.remove('hidden');
}

function closeWindowCloseup() {
  el('window-closeup').classList.add('hidden');
}

function onWindowClicked() {
  if (state.talking) return;

  if (state.window === 'closed') {
    state.window = 'open';
    updateWindowSprite();
  } else if (state.window === 'open') {
    if (state.clockCorrect) {
      state.window = 'mosque';
      updateWindowSprite();
      el('audio-azan').currentTime = 0;
      el('audio-azan').play();
      wakeNor();
      setBedGetUp();
    }
  }
}

// ---------- clock ----------

function updateClockVisuals() {
  const hourAngle = (state.hour % 12) * 30 + state.minute * 0.5;
  const minuteAngle = state.minute * 6;
  el('hour-hand').style.transform = `rotate(${hourAngle}deg)`;
  el('minute-hand').style.transform = `rotate(${minuteAngle}deg)`;
  el('clock-readout').textContent =
    String(state.hour).padStart(2, '0') + ':' + String(state.minute).padStart(2, '0');
}

function tick() {
  const a = el('audio-tick');
  a.currentTime = 0;
  a.play();
  updateClockVisuals();
  checkClockCorrect();
}

function checkClockCorrect() {
  if (!state.clockCorrect && state.hour === TARGET_HOUR && state.minute === TARGET_MINUTE) {
    state.clockCorrect = true;
  }
}

function openClockCloseup() {
  if (state.talking) return;
  el('clock-closeup').classList.remove('hidden');
}

function closeClockCloseup() {
  el('clock-closeup').classList.add('hidden');
}

function hourUp() { state.hour = (state.hour % 12) + 1; tick(); }
function hourDown() { state.hour = ((state.hour + 10) % 12) + 1; tick(); }
function minuteUp() { state.minute = (state.minute + MINUTE_STEP) % 60; tick(); }
function minuteDown() { state.minute = (state.minute - MINUTE_STEP + 60) % 60; tick(); }

// ---------- bed ----------

function updateBedSprite() {
  const src = {
    sleeping: 'assets/img/bed/sleeping.png',
    getup: 'assets/img/bed/getup.png',
    fixed: 'assets/img/bed/fixed.png',
  }[state.bed];
  el('bed-sprite').src = src;
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
  playLine(el('audio-nor2'), 'Пророк ﷺ сказал: «Чистота — половина веры».');
}

// ---------- Nor ----------

function wakeNor() {
  state.norAwake = true;
  el('hotspot-nor').classList.remove('hidden');
}

function onNorClicked() {
  if (state.talking) return;
  playLine(
    el('audio-nor1'),
    'Ас-Саламу Алейкум! Уже наступил Фаджр. Пора сделать омовение, надеть намазник и совершить намаз.'
  );
}

// ---------- wiring ----------

el('hotspot-window').addEventListener('click', openWindowCloseup);
el('window-closeup-btn').addEventListener('click', onWindowClicked);
el('window-closeup').querySelector('.back-btn').addEventListener('click', closeWindowCloseup);

el('hotspot-clock').addEventListener('click', openClockCloseup);
el('clock-closeup').querySelector('.back-btn').addEventListener('click', closeClockCloseup);
el('btn-hour-up').addEventListener('click', hourUp);
el('btn-hour-down').addEventListener('click', hourDown);
el('btn-min-up').addEventListener('click', minuteUp);
el('btn-min-down').addEventListener('click', minuteDown);

el('hotspot-bed').addEventListener('click', onBedClicked);
el('hotspot-nor').addEventListener('click', onNorClicked);

updateWindowSprite();
updateBedSprite();
updateClockVisuals();
