/**
 * Shared Web Audio API Analyser helper for Vitrola
 * Safely creates MediaElementAudioSourceNode once and routes to AnalyserNode & destination.
 */

let sharedAudioCtx: AudioContext | null = null;
let sharedAnalyser: AnalyserNode | null = null;
let sharedSource: MediaElementAudioSourceNode | null = null;

export function getAudioContext(): AudioContext | null {
  return sharedAudioCtx;
}

export function getAudioAnalyser(): AnalyserNode | null {
  return sharedAnalyser;
}

export function initAudioAnalyser(audioEl: HTMLAudioElement): AnalyserNode | null {
  if (typeof window === 'undefined' || !audioEl) return null;

  try {
    if (!sharedAudioCtx) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return null;
      sharedAudioCtx = new AudioCtx();
    }

    if (!sharedSource && sharedAudioCtx) {
      sharedSource = sharedAudioCtx.createMediaElementSource(audioEl);
      sharedAnalyser = sharedAudioCtx.createAnalyser();
      // 256 gives 128 frequency bins, perfectly sized for 32~48 WMP bars
      sharedAnalyser.fftSize = 256;
      sharedAnalyser.smoothingTimeConstant = 0.78;
      sharedAnalyser.minDecibels = -90;
      sharedAnalyser.maxDecibels = -10;

      sharedSource.connect(sharedAnalyser);
      sharedAnalyser.connect(sharedAudioCtx.destination);
    }

    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }

    return sharedAnalyser;
  } catch (err) {
    // If already connected or restricted by browser policy
    return sharedAnalyser;
  }
}

export function resumeAudioContext(): void {
  if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
}
