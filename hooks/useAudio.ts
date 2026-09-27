"use client";

import { useState, useRef, useCallback, useEffect } from "react";

/** The distinct notification cues the chat can play. */
export type SoundCue = "done" | "attention" | "error";

/** A single synthesized note within a cue. */
export interface ToneSpec {
  /** Frequency in Hz. */
  freq: number;
  /** Start offset from the cue's beginning, in seconds. */
  startOffset: number;
  /** Note length in seconds. */
  duration: number;
  /** Peak gain (0..1) reached during the short attack. */
  peakGain: number;
  /** Oscillator waveform. */
  type: OscillatorType;
}

// Each cue is a small chord/arpeggio built from sine (soft, pleasant) or
// triangle (a touch harsher, for errors) oscillators. All synthesized through
// the Web Audio API — no external files, no CDN.
const CUE_TONES: Record<SoundCue, ToneSpec[]> = {
  // Two ascending notes: a calm "task finished".
  done: [
    { freq: 523.25, startOffset: 0, duration: 0.45, peakGain: 0.18, type: "sine" },
    { freq: 659.25, startOffset: 0.18, duration: 0.45, peakGain: 0.18, type: "sine" },
  ],
  // Rising three-note chime: draws attention without alarming (agent needs input).
  attention: [
    { freq: 659.25, startOffset: 0, duration: 0.3, peakGain: 0.16, type: "sine" },
    { freq: 830.61, startOffset: 0.14, duration: 0.3, peakGain: 0.16, type: "sine" },
    { freq: 987.77, startOffset: 0.28, duration: 0.36, peakGain: 0.18, type: "sine" },
  ],
  // Two descending, slightly harsh notes: something went wrong.
  error: [
    { freq: 392.0, startOffset: 0, duration: 0.32, peakGain: 0.17, type: "triangle" },
    { freq: 293.66, startOffset: 0.16, duration: 0.4, peakGain: 0.19, type: "triangle" },
  ],
};

/** Pure accessor for a cue's tone specs — unit-tested without any AudioContext. */
export function getCueTones(cue: SoundCue): ToneSpec[] {
  return CUE_TONES[cue];
}

function playCue(ctx: AudioContext, cue: SoundCue) {
  const now = ctx.currentTime;
  for (const spec of getCueTones(cue)) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = spec.type;
    osc.frequency.value = spec.freq;
    const start = now + spec.startOffset;
    const end = start + spec.duration;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(spec.peakGain, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, end);
    osc.start(start);
    osc.stop(end);
  }
}

export function useAudio() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("omp-sound-enabled");
    return stored === null ? true : stored === "true";
  });

  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Reuse a single AudioContext so it can be resumed if the browser
  // autoplay policy suspends it (contexts created outside user gestures
  // start in "suspended" state and produce no sound).
  const ctxRef = useRef<AudioContext | null>(null);
  const getCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current && ctxRef.current.state !== "closed") return ctxRef.current;
    try {
      ctxRef.current = new AudioContext();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  const unlockAudio = useCallback((force = false) => {
    if (!force && !enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx || ctx.state !== "suspended") return;
    ctx.resume().catch(() => {});
  }, [getCtx]);

  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    if (next) unlockAudio(true);
    enabledRef.current = next;
    localStorage.setItem("omp-sound-enabled", String(next));
    setEnabled(next);
  }, [unlockAudio]);

  const playSound = useCallback((cue: SoundCue = "done") => {
    if (!enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx) return;
    const play = () => {
      try {
        playCue(ctx, cue);
      } catch {
        // AudioContext not available
      }
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(play).catch(() => {});
      return;
    }
    play();
  }, [getCtx]);

  const playAttentionSound = useCallback(() => playSound("attention"), [playSound]);
  const playErrorSound = useCallback(() => playSound("error"), [playSound]);

  return {
    soundEnabled: enabled,
    onSoundToggle: toggle,
    // `playDoneSound` accepts an optional cue so a single threaded prop can play
    // any of the cues; callers that pass nothing get the completion tone.
    playDoneSound: playSound,
    playAttentionSound,
    playErrorSound,
    unlockAudio,
    soundEnabledRef: enabledRef,
  };
}
