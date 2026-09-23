"use client";

/**
 * Sale sounds synthesised with the Web Audio API – no audio files needed.
 * Browsers only allow audio after a user interaction on the page.
 */
export const SOUND_PRESETS = {
  "cha-ching": "Cha-Ching (Kasse)",
  coins: "Münzregen",
  bell: "Glocke",
  fanfare: "Fanfare",
  arcade: "Arcade Level-Up",
  soft: "Dezent",
} as const;
export type SoundPreset = keyof typeof SOUND_PRESETS;

let ctx: AudioContext | null = null;
function audio() {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(c: AudioContext, out: AudioNode, freq: number, start: number, dur: number, type: OscillatorType = "sine", gain = 0.5) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime + start);
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + start + dur);
  o.connect(g).connect(out);
  o.start(c.currentTime + start);
  o.stop(c.currentTime + start + dur + 0.05);
}

function noise(c: AudioContext, out: AudioNode, start: number, dur: number, gain = 0.3) {
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = c.createBufferSource();
  const f = c.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = 3000;
  const g = c.createGain();
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(f).connect(g).connect(out);
  src.start(c.currentTime + start);
}

export function playSound(preset: SoundPreset, volume = 0.7) {
  const c = audio();
  const master = c.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume));
  master.connect(c.destination);
  switch (preset) {
    case "cha-ching":
      noise(c, master, 0, 0.08, 0.25);
      tone(c, master, 1318.5, 0.0, 0.25, "triangle", 0.35);
      tone(c, master, 1760, 0.12, 0.6, "triangle", 0.4);
      tone(c, master, 2637, 0.12, 0.6, "sine", 0.15);
      noise(c, master, 0.12, 0.25, 0.15);
      break;
    case "coins":
      for (let i = 0; i < 7; i++) tone(c, master, 1800 + Math.random() * 1400, i * 0.07, 0.18, "square", 0.08);
      break;
    case "bell":
      [880, 1760, 2640].forEach((f, i) => tone(c, master, f, 0, 1.6 - i * 0.4, "sine", 0.35 / (i + 1)));
      break;
    case "fanfare":
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, master, f, i * 0.12, i === 3 ? 0.7 : 0.14, "sawtooth", 0.12));
      break;
    case "arcade":
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(c, master, f, i * 0.06, 0.1, "square", 0.1));
      break;
    case "soft":
      tone(c, master, 987.77, 0, 0.35, "sine", 0.25);
      tone(c, master, 1318.5, 0.15, 0.5, "sine", 0.2);
      break;
  }
}
