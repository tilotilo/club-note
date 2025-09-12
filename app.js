/* Mini Web Synth — stable Hold/Release.
   Works in Chrome/Edge/Firefox. WebMIDI optional (Chrome/Edge).
*/

const NOTES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const KEYMAP = { "a":0,"w":1,"s":2,"e":3,"d":4,"f":5,"t":6,"g":7,"y":8,"h":9,"u":10,"j":11 };

let audioCtx = null;
let master = null;
let limiter = null;

// Track voices simply in arrays
let activeVoices = [];   // all currently sounding
let sustaining = false;  // hold state
let heldVoices = [];     // subset of active that are latched

let midiAccess = null;

const el = (id) => document.getElementById(id);
const $root = el("root"), $oct = el("octave"), $mode = el("mode");
const $wave = el("wave"), $dur = el("dur"), $vol = el("vol");
const $a = el("a"), $d = el("d"), $s = el("s"), $r = el("r");
const $status = el("status"), $hold = el("hold");

function updateStatus(msg) {
  const audio = audioCtx ? `Audio: ${audioCtx.state}` : "Audio: idle";
  let midi = "MIDI: unavailable";
  if (midiAccess) {
    const inputs = [...midiAccess.inputs.values()];
    midi = inputs.length ? `MIDI: ${inputs.map(i => i.name).join(", ")}` : "MIDI: no inputs";
  }
  const hold = `Hold: ${sustaining ? "ON" : "OFF"}`;
  $status.textContent = msg || `${audio} • ${midi} • Hold: ${sustaining ? "ON" : "OFF"}`;
}

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
  }
  // Explicit resume helps Firefox/strict autoplay setups
  if (audioCtx.state !== "running") {
    try { await audioCtx.resume(); } catch {}
  }
  updateStatus();
}

$vol.addEventListener("input", () => {
  if (!audioCtx) return;
  master.gain.setTargetAtTime(parseFloat($vol.value), audioCtx.currentTime, 0.01);
});

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function noteNameToMidi(name, octave) { return (octave + 1) * 12 + NOTES.indexOf(name); }

function chordIntervals(mode) {
  switch (mode) {
    case "maj":  return [0, 4, 7];
    case "min":  return [0, 3, 7];
    case "maj7": return [0, 4, 7, 11];
    case "min7": return [0, 3, 7, 10];
    case "dim":  return [0, 3, 6];
    default:     return [0];
  }
}

function startVoice(midi, {wave, a, d, s, r, dur}, sustain=false) {
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

  let stopTimer = null;
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
    // prune from both arrays
    activeVoices = activeVoices.filter(v => v !== voice);
    heldVoices = heldVoices.filter(v => v !== voice);
  });

  return voice;
}

function releaseVoice(voice) {
  if (!audioCtx || !voice || voice.released) return;
  const now = audioCtx.currentTime;
  try {
    voice.g.gain.cancelScheduledValues(now);
    const current = voice.g.gain.value; // fine for a simple ramp
    voice.g.gain.setValueAtTime(current, now);
    voice.g.gain.linearRampToValueAtTime(0, now + voice.r);
    try { voice.osc.stop(now + voice.r + 0.02); } catch {}
  } catch {}
  voice.released = true;
}

function releaseHeld() {
  // copy to avoid mutation issues during iteration
  const toRelease = heldVoices.slice();
  heldVoices.length = 0;
  toRelease.forEach(releaseVoice);
}

function playSelection() {
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

async function handlePlay() {
  await ensureAudio();
  playSelection();
}

function toggleHold() {
  sustaining = !sustaining;
  $hold.classList.toggle("active", sustaining);
  $hold.textContent = sustaining ? "Release" : "Hold";
  if (!sustaining) releaseHeld(); // immediately release any latched voices
  updateStatus();
}

// === MIDI (optional) ===
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

// === UI wiring ===
el("play").addEventListener("click", handlePlay);
el("stop").addEventListener("click", stopAll);
$hold.addEventListener("click", toggleHold);

// ensure clicks resume context (esp. Firefox)
["click","pointerdown","keydown","touchstart"].forEach(evt => {
  window.addEventListener(evt, async () => {
    if (audioCtx && audioCtx.state !== "running") {
      try { await audioCtx.resume(); } catch {}
      updateStatus();
    }
  });
});

// Computer-key keyboard
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
