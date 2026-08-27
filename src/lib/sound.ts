/**
 * Dock ses efektleri.
 *
 * Nexus ses semalarini .wav dosyalariyla dagitir; burada sesler Web Audio ile
 * ANLIK URETILIYOR: paket buyumez, lisans derdi yok, her sema birkac satir.
 * Tek bir AudioContext acilir ve ses kapaliyken hic acilmaz.
 */

export type SoundScheme = "soft" | "click" | "retro";
export type SoundEvent = "hover" | "launch" | "show" | "hide" | "add" | "remove";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
/** Ayni sesin saniyede onlarca kez calmasini engeller (hover) */
let lastAt: Record<string, number> = {};

function audio(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.connect(ctx.destination);
    return ctx;
  } catch {
    return null;
  }
}

/** Tarayici otomatik oynatmayi askiya aldiysa ilk kullanici hareketinde devam ettir. */
export function resumeAudio() {
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

/** Kisa gurultu patlamasi (mekanik tik sesi icin) */
function noise(c: AudioContext, dur: number) {
  const frames = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    // Sona dogru sonen beyaz gurultu
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  return src;
}

interface Tone {
  /** Baslangic ve bitis frekansi (Hz) */
  from: number;
  to: number;
  /** Sure (sn) */
  dur: number;
  /** Bagil ses seviyesi */
  gain: number;
}

const TONES: Record<SoundEvent, Tone> = {
  hover: { from: 1180, to: 1180, dur: 0.035, gain: 0.16 },
  launch: { from: 540, to: 880, dur: 0.11, gain: 0.5 },
  show: { from: 420, to: 700, dur: 0.13, gain: 0.32 },
  hide: { from: 700, to: 380, dur: 0.13, gain: 0.28 },
  add: { from: 620, to: 1040, dur: 0.15, gain: 0.42 },
  remove: { from: 520, to: 240, dur: 0.16, gain: 0.38 },
};

const WAVE: Record<SoundScheme, OscillatorType> = {
  soft: "sine",
  click: "triangle",
  retro: "square",
};

/** En kisa tekrar araligi (ms): hover cok siklasmasin */
const THROTTLE: Partial<Record<SoundEvent, number>> = { hover: 70 };

export function playSound(
  event: SoundEvent,
  opts: { enabled: boolean; volume: number; scheme: SoundScheme }
) {
  if (!opts.enabled || opts.volume <= 0) return;

  const gap = THROTTLE[event] ?? 0;
  const now = performance.now();
  if (gap && now - (lastAt[event] ?? 0) < gap) return;
  lastAt[event] = now;

  const c = audio();
  if (!c || !master) return;
  if (c.state === "suspended") void c.resume();

  const t = c.currentTime;
  const tone = TONES[event];
  const vol = Math.min(1, Math.max(0, opts.volume)) * tone.gain;

  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + tone.dur);
  g.connect(master);

  if (opts.scheme === "click") {
    // Mekanik tik: bant gecirgen suzulmus kisa gurultu + hafif ton
    const src = noise(c, tone.dur);
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(tone.from * 1.4, t);
    bp.Q.value = 1.4;
    src.connect(bp).connect(g);
    src.start(t);
    src.stop(t + tone.dur);
    return;
  }

  const osc = c.createOscillator();
  osc.type = WAVE[opts.scheme] ?? "sine";
  osc.frequency.setValueAtTime(tone.from, t);
  if (tone.to !== tone.from) osc.frequency.exponentialRampToValueAtTime(tone.to, t + tone.dur);
  osc.connect(g);
  osc.start(t);
  osc.stop(t + tone.dur + 0.02);
}
