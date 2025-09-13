/* Club Note — Mini Web Synth with louder metronome (dedicated gain) */

const NOTES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const KEYMAP = { "a":0,"w":1,"s":2,"e":3,"d":4,"f":5,"t":6,"g":7,"y":8,"h":9,"u":10,"j":11 };

let audioCtx = null;
let master = null;
let limiter = null;

// Track voices
let activeVoices = [];
let sustaining = false;
let heldVoices = [];

// MIDI (optional)
let midiAccess = null;

// Metronome output gain (dedicated, independent of synth master)
let metroGain = null;
const METRO_LEVEL = 0.85; // default 85% (0..1.2 OK)

// UI els
const el = (id) => document.getElementById(id);
const $root = el("root"), $oct = el("octave"), $mode = el("mode");
const $wave = el("wave"), $dur = el("dur"), $vol = el("vol");
const $a = el("a"), $d = el("d"), $s = el("s"), $r = el("r");
const $status = el("status"), $hold = el("hold");

// ===== Audio bootstrap
async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    master = audioCtx.createGain();
    master.gain.value = parseFloat($vol.value);

    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 30;
    comp.ratio.value = 12;
    comp.attack.value = 0.002;
    comp.release.value = 0.25;

    master.connect(comp).connect(audioCtx.destination);
    limiter = comp;

    // Dedicated metronome gain → straight to destination
    metroGain = audioCtx.createGain();
    metroGain.gain.value = METRO_LEVEL;
    metroGain.connect(audioCtx.destination);
  }
  if (audioCtx.state !== "running") {
    try { await audioCtx.resume(); } catch {}
  }
  updateStatus();
}

$vol.addEventListener("input", () => {
  if (!audioCtx) return;
  master.gain.setTargetAtTime(parseFloat($vol.value), audioCtx.currentTime, 0.01);
});

// ===== Helpers
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function noteNameToMidi(name, octave) { return (octave + 1) * 12 + NOTES.indexOf(name); }

function chordIntervals(mode) {
  switch (mode) {
    case "maj":  return [0,4,7];
    case "min":  return [0,3,7];
    case "maj7": return [0,4,7,11];
    case "min7": return [0,3,7,10];
    case "dim":  return [0,3,6];
    default:     return [0];
  }
}

// ===== Voice
function startVoice(midi, {wave,a,d,s,r,dur}, sustain=false) {
  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  osc.type = wave;
  osc.frequency.value = midiToFreq(midi);

  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(1, now + a);
  g.gain.linearRampToValueAtTime(s, now + a + d);

  osc.connect(g).connect(master);
  osc.start(now);

  if (!sustain) {
    const offT = now + dur;
    g.gain.setValueAtTime(s, offT);
    g.gain.linearRampToValueAtTime(0, offT + r);
    try { osc.stop(offT + r + 0.02); } catch {}
  }

  const voice = { osc, g, r, released: !sustain };
  activeVoices.push(voice);
  if (sustain) heldVoices.push(voice);

  osc.addEventListener("ended", () => {
    activeVoices = activeVoices.filter(v => v !== voice);
    heldVoices = heldVoices.filter(v => v !== voice);
  });

  return voice;
}

function releaseVoice(v) {
  if (!audioCtx || !v || v.released) return;
  const now = audioCtx.currentTime;
  try {
    v.g.gain.cancelScheduledValues(now);
    const cur = v.g.gain.value;
    v.g.gain.setValueAtTime(cur, now);
    v.g.gain.linearRampToValueAtTime(0, now + v.r);
    try { v.osc.stop(now + v.r + 0.02); } catch {}
  } catch {}
  v.released = true;
}

function releaseHeld() {
  const list = heldVoices.slice();
  heldVoices.length = 0;
  list.forEach(releaseVoice);
}

function stopAll() {
  releaseHeld();
  const now = audioCtx ? audioCtx.currentTime : 0;
  activeVoices.forEach(v => {
    try {
      v.g.gain.cancelScheduledValues(now);
      const cur = v.g.gain.value;
      v.g.gain.setValueAtTime(cur, now);
      v.g.gain.linearRampToValueAtTime(0, now + 0.03);
      try { v.osc.stop(now + 0.05); } catch {}
    } catch {}
    v.released = true;
  });
  activeVoices.length = 0;
}

// ===== Play selection
function playRootSelection() {
  const base = noteNameToMidi($root.value, parseInt($oct.value, 10));
  const ints = chordIntervals($mode.value);
  const count = ints.length;

  const opts = {
    wave: $wave.value,
    a: Math.max(0, parseFloat($a.value)),
    d: Math.max(0, parseFloat($d.value)),
    s: Math.min(1, Math.max(0, parseFloat($s.value))),
    r: Math.max(0, parseFloat($r.value)),
    dur: Math.max(0.01, parseFloat($dur.value))
  };

  const headroom = (count > 1 ? 0.9 / Math.sqrt(count) : 1);
  master.gain.setTargetAtTime(parseFloat($vol.value) * headroom, audioCtx.currentTime, 0.01);

  ints.forEach(iv => startVoice(base + iv, opts, sustaining));

  if (!sustaining) {
    const endAt = audioCtx.currentTime + opts.dur + opts.r + 0.05;
    master.gain.setTargetAtTime(parseFloat($vol.value), endAt, 0.05);
  }
}

// ===== MIDI input (optional)
async function initMIDI() {
  updateStatus("Audio: idle • MIDI: requesting… • Hold: OFF");
  try {
    midiAccess = await navigator.requestMIDIAccess();
    midiAccess.inputs.forEach(input => input.onmidimessage = onMIDIMessage);
    midiAccess.onstatechange = () => {
      midiAccess.inputs.forEach(input => input.onmidimessage = onMIDIMessage);
      updateStatus();
    };
    updateStatus();
  } catch {
    updateStatus("Audio: idle • MIDI: unavailable (ok, still works!) • Hold: OFF");
  }
}
function onMIDIMessage(e) {
  const [status, data1, data2] = e.data;
  const cmd = status & 0xf0;
  const midi = data1, vel = data2;

  if (cmd === 0x90 && vel > 0) { // Note On
    if (!audioCtx) return;
    const ints = chordIntervals($mode.value);
    const headroom = (ints.length > 1 ? 0.9 / Math.sqrt(ints.length) : 1);
    master.gain.setTargetAtTime(parseFloat($vol.value) * headroom * (vel / 127), audioCtx.currentTime, 0.005);

    const opts = {
      wave: $wave.value,
      a: Math.max(0, parseFloat($a.value)),
      d: Math.max(0, parseFloat($d.value)),
      s: Math.min(1, Math.max(0, parseFloat($s.value))),
      r: Math.max(0, parseFloat($r.value)),
      dur: Math.max(0.01, parseFloat($dur.value))
    };
    ints.forEach(iv => startVoice(midi + iv, opts, sustaining));
  }
}

// ===== UI wiring
el("play").addEventListener("click", async () => { await ensureAudio(); playRootSelection(); });
el("stop").addEventListener("click", stopAll);
$hold.addEventListener("click", () => {
  sustaining = !sustaining;
  $hold.classList.toggle("active", sustaining);
  $hold.textContent = sustaining ? "Release" : "Hold";
  if (!sustaining) releaseHeld();
  updateStatus();
});

["click","pointerdown","keydown","touchstart"].forEach(evt => {
  window.addEventListener(evt, async () => {
    if (audioCtx && audioCtx.state !== "running") {
      try { await audioCtx.resume(); } catch {}
      updateStatus();
    }
  });
});

window.addEventListener("keydown", async (e) => {
  if (e.repeat) return;
  const semis = KEYMAP[e.key.toLowerCase()];
  if (semis === undefined) return;
  await ensureAudio();

  const baseMidi = noteNameToMidi("C", parseInt($oct.value, 10));
  const midi = baseMidi + semis;

  const opts = {
    wave: $wave.value,
    a: Math.max(0, parseFloat($a.value)),
    d: Math.max(0, parseFloat($d.value)),
    s: Math.min(1, Math.max(0, parseFloat($s.value))),
    r: Math.max(0, parseFloat($r.value)),
    dur: Math.max(0.01, parseFloat($dur.value))
  };
  const ints = chordIntervals($mode.value);
  const headroom = (ints.length > 1 ? 0.9 / Math.sqrt(ints.length) : 1);
  master.gain.setTargetAtTime(parseFloat($vol.value) * headroom, audioCtx.currentTime, 0.01);
  ints.forEach(iv => startVoice(midi + iv, opts, sustaining));
});

// Kick MIDI init if supported
if ("requestMIDIAccess" in navigator) initMIDI();
else updateStatus();

// ===== Status
function updateStatus(msg) {
  const audio = audioCtx ? `Audio: ${audioCtx.state}` : "Audio: idle";
  let midi = "MIDI: unavailable";
  if (midiAccess) {
    const inputs = [...midiAccess.inputs.values()];
    midi = inputs.length ? `MIDI: ${inputs.map(i => i.name).join(", ")}` : "MIDI: no inputs";
  }
  const hold = `Hold: ${sustaining ? "ON" : "OFF"}`;
  $status.textContent = msg || `${audio} • ${midi} • ${hold}`;
}

/* ===================== Metronome ===================== */
let metroTimer = null;
let metroBpm = 120;
let metroBeat = 0; // 0..3 for 4/4
let metroRunning = false;

const $bpm = el("bpm");
const $bpmVal = el("bpmVal");
const $metroMode = el("metroMode");
const $metroStart = el("metroStart");
const $metroStop = el("metroStop");
const $metroVol = el("metroVol");

if ($bpm && $bpmVal) $bpmVal.textContent = `${$bpm.value} BPM`;
function metroIntervalMs() { return (60_000 / metroBpm); }

// Louder/brighter click routed through metroGain
function clickAudio(accent=false) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;

  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();

  // bright square; accent higher
  osc.type = "square";
  osc.frequency.setValueAtTime(accent ? 3000 : 1800, now);

  // punchy envelope
  const peak = accent ? 1.0 : 0.8;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(peak, now + 0.0015);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

  // dedicated metronome volume
  osc.connect(g).connect(metroGain || audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.08);
}

// Optional MIDI tick (if any output is available)
function clickMIDI(accent=false) {
  try {
    if (!midiAccess) return;
    const outs = [...midiAccess.outputs.values()];
    if (!outs.length) return;
    const out = outs[0];
    const velocity = accent ? 110 : 90;
    out.send([0x99, 37, velocity]);                 // ch 10 note on (37 side-stick)
    setTimeout(() => out.send([0x89, 37, 0]), 30);  // note off
  } catch {}
}

function tick() {
  const mode = $metroMode ? $metroMode.value : "all";
  const beatIndex = metroBeat % 4;

  const isBackbeatWanted = (mode === "backbeat");
  const shouldClick = !isBackbeatWanted || (beatIndex === 1 || beatIndex === 3); // 2 & 4

  if (shouldClick) {
    const accent = (beatIndex === 0);
    clickAudio(accent);
    clickMIDI(accent);
  }

  onBeatForCycle(); // circle-of-fourths driver

  metroBeat = (metroBeat + 1) % 4;
}

function startMetronome() {
  if (metroRunning) return;
  if (typeof ensureAudio === "function") ensureAudio();
  metroRunning = true;
  metroBeat = 0;
  tick(); // immediate tick
  metroTimer = setInterval(tick, metroIntervalMs());
  updateStatus();
}

function stopMetronome() {
  if (metroTimer) clearInterval(metroTimer);
  metroTimer = null;
  metroRunning = false;
  updateStatus();
}

// UI hooks
if ($bpm) {
  $bpm.addEventListener("input", () => {
    metroBpm = parseInt($bpm.value, 10) || 120;
    if ($bpmVal) $bpmVal.textContent = `${metroBpm} BPM`;
    if (metroRunning) {
      clearInterval(metroTimer);
      metroTimer = setInterval(tick, metroIntervalMs());
    }
  });
}
if ($metroStart) $metroStart.addEventListener("click", startMetronome);
if ($metroStop)  $metroStop.addEventListener("click", stopMetronome);

// Metronome volume slider
if ($metroVol) {
  $metroVol.addEventListener("input", () => {
    if (!audioCtx || !metroGain) return;
    metroGain.gain.setTargetAtTime(parseFloat($metroVol.value) / 100, audioCtx.currentTime, 0.01);
  });
}

window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat) {
    e.preventDefault();
    metroRunning ? stopMetronome() : startMetronome();
  }
});

/* ============ Circle of Fourths auto-advance ============ */
const CYCLE4 = ["C","F","A#","D#","G#","C#","F#","B","E","A","D","G"];

let cycleEnabled = false;
let cycleStepBeats = 8;
let cycleIndex = 0;
let cycleBeatCounter = 0;

const $cycle4ths  = el("cycle4ths");
const $cycleBeats = el("cycleBeats");
const $rootSelect = el("root");

function syncCycleIndexToCurrentRoot() {
  const current = $rootSelect?.value || "C";
  const i = CYCLE4.indexOf(current);
  cycleIndex = (i >= 0 ? i : 0);
}

function advanceRootOnceAndReplay() {
  cycleIndex = (cycleIndex + 1) % CYCLE4.length;
  const nextRoot = CYCLE4[cycleIndex];
  if ($rootSelect) $rootSelect.value = nextRoot;

  if (typeof stopAll === "function") stopAll();
  if (typeof playRootSelection === "function") playRootSelection();
}

function onBeatForCycle() {
  if (!cycleEnabled) return;
  if (!metroRunning) return;

  cycleBeatCounter++;
  if (cycleBeatCounter >= cycleStepBeats) {
    cycleBeatCounter = 0;
    advanceRootOnceAndReplay();
  }
}

if ($cycle4ths) {
  $cycle4ths.addEventListener("change", () => {
    cycleEnabled = $cycle4ths.checked;
    cycleBeatCounter = 0;
    syncCycleIndexToCurrentRoot();
  });
}
if ($cycleBeats) {
  $cycleBeats.addEventListener("change", () => {
    cycleStepBeats = parseInt($cycleBeats.value, 10) || 8;
    cycleBeatCounter = 0;
  });
}
if ($cycleBeats) cycleStepBeats = parseInt($cycleBeats.value, 10) || 8;

// ===== end
