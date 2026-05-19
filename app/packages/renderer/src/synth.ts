// Pure Web Audio synthesis. No samples, no derivatives of original game audio.
// Both the browser AudioContext and wx.createWebAudioContext() satisfy the
// AudioContextLike shape — entry packages instantiate their own context.

export interface AudioParamLike {
  setValueAtTime(value: number, when: number): AudioParamLike;
  linearRampToValueAtTime(value: number, endTime: number): AudioParamLike;
  exponentialRampToValueAtTime(value: number, endTime: number): AudioParamLike;
}
export interface AudioNodeLike {
  connect(dest: AudioNodeLike): AudioNodeLike;
}
export interface OscillatorLike extends AudioNodeLike {
  type: string;
  frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}
export interface GainLike extends AudioNodeLike {
  gain: AudioParamLike;
}
export interface BiquadLike extends AudioNodeLike {
  type: string;
  frequency: AudioParamLike;
}
export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
  length: number;
  sampleRate: number;
}
export interface BufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  start(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  readonly state?: string;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  createBiquadFilter(): BiquadLike;
  createBufferSource(): BufferSourceLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  resume?(): unknown;
}

export interface Synth {
  click(): void;
  whoosh(steps: number): void;
  thud(): void;
  escape(): void;
  win(): void;
  muted: boolean;
}

export function makeSynth(ctx: AudioContextLike | null): Synth {
  // Wrap each call: if the platform's Web Audio implementation rejects any
  // call (older wxgame base libraries, locked-down browsers), the play just
  // fails silently rather than breaking the input handler.
  const safe = (fn: () => void) => () => {
    if (!canPlay()) return;
    try {
      fn();
    } catch {
      /* swallow */
    }
  };
  const self: Synth = {
    muted: false,
    click: safe(() => playClick(ctx!)),
    whoosh: (steps: number) => {
      if (canPlay()) {
        try {
          playWhoosh(ctx!, steps);
        } catch {
          /* */
        }
      }
    },
    thud: safe(() => playThud(ctx!)),
    escape: safe(() => playEscape(ctx!)),
    win: safe(() => playWin(ctx!)),
  };
  function canPlay(): boolean {
    if (!ctx || self.muted) return false;
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      try {
        ctx.resume();
      } catch {
        /* ignore */
      }
    }
    return true;
  }
  return self;
}

function playClick(ctx: AudioContextLike): void {
  const t0 = ctx.currentTime;
  const sr = ctx.sampleRate;
  const len = Math.max(8, Math.floor(0.04 * sr));
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const env = Math.exp(-(i / len) * 9);
    d[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.setValueAtTime(2800, t0);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.32, t0);
  src.connect(hp);
  hp.connect(g);
  g.connect(ctx.destination);
  src.start(t0);
}

function envOsc(
  ctx: AudioContextLike,
  type: string,
  freqStart: number,
  freqEnd: number,
  dur: number,
  peak: number,
): void {
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freqStart, t0);
  if (freqEnd !== freqStart) {
    o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + Math.min(0.015, dur * 0.15));
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g);
  g.connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function playWhoosh(ctx: AudioContextLike, steps: number): void {
  const dur = Math.min(0.32, 0.1 + steps * 0.035);
  envOsc(ctx, "triangle", 720, 220, dur, 0.18);
}
function playThud(ctx: AudioContextLike): void {
  envOsc(ctx, "sine", 180, 70, 0.15, 0.42);
}
function playEscape(ctx: AudioContextLike): void {
  envOsc(ctx, "sine", 320, 1200, 0.2, 0.22);
}
function playWin(ctx: AudioContextLike): void {
  const t0 = ctx.currentTime;
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  for (let i = 0; i < notes.length; i++) {
    const t = t0 + i * 0.085;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(notes[i]!, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.42);
  }
}
