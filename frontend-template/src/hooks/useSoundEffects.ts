import { useCallback, useRef, useState } from "react";

/** Synthesized sound effects via Web Audio API — no external audio files needed. */
export function useSoundEffects() {
  const ctxRef = useRef<AudioContext | null>(null);
  const musicNodesRef = useRef<{
    snareOsc: OscillatorNode;
    snareGain: GainNode;
    bassOsc: OscillatorNode;
    bassGain: GainNode;
    droneOsc: OscillatorNode;
    droneGain: GainNode;
    masterGain: GainNode;
    timer: number;
  } | null>(null);
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [musicVolume, setMusicVolumeState] = useState(0.3);

  const getCtx = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
    }
    return ctxRef.current;
  }, []);

  /** Low-frequency boom (80Hz → 40Hz, 0.3s) */
  const playShot = useCallback(() => {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(80, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  }, [getCtx]);

  /** Noise burst + low oscillator (0.5s) */
  const playHit = useCallback(() => {
    const ctx = getCtx();
    // Noise burst
    const bufferSize = ctx.sampleRate * 0.5;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.1));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.3, ctx.currentTime);
    noise.connect(noiseGain).connect(ctx.destination);
    noise.start();

    // Low boom
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(30, ctx.currentTime + 0.5);
    oscGain.gain.setValueAtTime(0.3, ctx.currentTime);
    oscGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.connect(oscGain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  }, [getCtx]);

  /** Filtered white noise — water splash (0.4s) */
  const playMiss = useCallback(() => {
    const ctx = getCtx();
    const bufferSize = ctx.sampleRate * 0.4;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.15));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 800;
    filter.Q.value = 1;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    noise.connect(filter).connect(gain).connect(ctx.destination);
    noise.start();
  }, [getCtx]);

  /** Descending tone + noise (0.8s) */
  const playSunk = useCallback(() => {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(400, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.8);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.8);

    // Noise burst
    const bufferSize = ctx.sampleRate * 0.8;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.2));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.15, ctx.currentTime);
    noise.connect(noiseGain).connect(ctx.destination);
    noise.start();
  }, [getCtx]);

  /** Ascending major arpeggio (1.5s) */
  const playVictory = useCallback(() => {
    const ctx = getCtx();
    const notes = [261.63, 329.63, 392.0, 523.25]; // C4, E4, G4, C5
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.3;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.3, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.01, start + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  }, [getCtx]);

  /** Descending minor chord (1.5s) */
  const playDefeat = useCallback(() => {
    const ctx = getCtx();
    const notes = [392.0, 311.13, 261.63, 196.0]; // G4, Eb4, C4, G3
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.35;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.01, start + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.5);
    });
  }, [getCtx]);

  /** Start procedural war drums loop (~100 BPM march tempo) */
  const startMusic = useCallback(() => {
    if (musicNodesRef.current) return;
    const ctx = getCtx();
    const masterGain = ctx.createGain();
    masterGain.gain.value = musicVolume;
    masterGain.connect(ctx.destination);

    // Drone: filtered sawtooth for tension
    const droneOsc = ctx.createOscillator();
    const droneFilter = ctx.createBiquadFilter();
    const droneGain = ctx.createGain();
    droneOsc.type = "sawtooth";
    droneOsc.frequency.value = 55; // A1
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 200;
    droneFilter.Q.value = 2;
    droneGain.gain.value = 0.12;
    droneOsc.connect(droneFilter).connect(droneGain).connect(masterGain);
    droneOsc.start();

    // Bass drum oscillator (retriggered via gain scheduling)
    const bassOsc = ctx.createOscillator();
    const bassGain = ctx.createGain();
    bassOsc.type = "sine";
    bassOsc.frequency.value = 60;
    bassGain.gain.value = 0;
    bassOsc.connect(bassGain).connect(masterGain);
    bassOsc.start();

    // Snare: noise source via oscillator + distortion for texture
    const snareOsc = ctx.createOscillator();
    const snareGain = ctx.createGain();
    snareOsc.type = "triangle";
    snareOsc.frequency.value = 180;
    snareGain.gain.value = 0;
    snareOsc.connect(snareGain).connect(masterGain);
    snareOsc.start();

    // Schedule pattern: 100 BPM = 0.6s per beat, 16th = 0.15s
    const BEAT = 0.6;
    const SIXTEENTH = BEAT / 4;

    const scheduleBar = () => {
      const now = ctx.currentTime;

      // Bass drum on beats 1 and 3
      for (const beatOffset of [0, 2]) {
        const t = now + beatOffset * BEAT;
        bassOsc.frequency.setValueAtTime(90, t);
        bassOsc.frequency.exponentialRampToValueAtTime(50, t + 0.15);
        bassGain.gain.setValueAtTime(0.35, t);
        bassGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      }

      // Snare hits on beats 2 and 4 with ghost 16th notes
      for (const beatOffset of [1, 3]) {
        const t = now + beatOffset * BEAT;
        // Main snare hit
        snareOsc.frequency.setValueAtTime(200, t);
        snareGain.gain.setValueAtTime(0.2, t);
        snareGain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        // Ghost notes (softer 16th note rolls before the hit)
        const ghost = t - SIXTEENTH;
        if (ghost > now) {
          snareGain.gain.setValueAtTime(0.07, ghost);
          snareGain.gain.exponentialRampToValueAtTime(0.001, ghost + 0.06);
        }
      }

      // Subtle snare roll on beat 4.5 (fill every bar)
      const fillStart = now + 3.5 * BEAT;
      for (let i = 0; i < 3; i++) {
        const t = fillStart + i * SIXTEENTH * 0.5;
        snareGain.gain.setValueAtTime(0.05 + i * 0.03, t);
        snareGain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      }
    };

    // Schedule first bar immediately, then repeat
    scheduleBar();
    const timer = window.setInterval(scheduleBar, BEAT * 4 * 1000);

    musicNodesRef.current = {
      snareOsc, snareGain, bassOsc, bassGain,
      droneOsc, droneGain, masterGain, timer,
    };
    setMusicPlaying(true);
  }, [getCtx, musicVolume]);

  /** Stop the war drums loop */
  const stopMusic = useCallback(() => {
    const nodes = musicNodesRef.current;
    if (!nodes) return;
    clearInterval(nodes.timer);
    nodes.droneOsc.stop();
    nodes.bassOsc.stop();
    nodes.snareOsc.stop();
    nodes.masterGain.disconnect();
    musicNodesRef.current = null;
    setMusicPlaying(false);
  }, []);

  /** Adjust music volume (0–1) */
  const setMusicVolume = useCallback((vol: number) => {
    setMusicVolumeState(vol);
    if (musicNodesRef.current) {
      musicNodesRef.current.masterGain.gain.value = vol;
    }
  }, []);

  return {
    playShot, playHit, playMiss, playSunk, playVictory, playDefeat,
    startMusic, stopMusic, setMusicVolume, musicPlaying, musicVolume,
  };
}
