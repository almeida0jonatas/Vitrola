/**
 * Generates lightweight, pleasant royalty-free demo audio tracks using standard Web Audio synthesis.
 * Encodes audio into valid WAV Blobs so they can be played via HTML5 Audio and IndexedDB.
 */

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function bufferToWave(abuffer: AudioBuffer, len: number): Blob {
  const numOfChan = abuffer.numberOfChannels;
  const length = len * numOfChan * 2 + 44;
  const out = new ArrayBuffer(length);
  const view = new DataView(out);
  const channels: Float32Array[] = [];
  let offset = 0;
  let pos = 0;

  // RIFF identifier
  writeString(view, pos, 'RIFF'); pos += 4;
  // file length minus RIFF identifier length and file description length
  view.setUint32(pos, length - 8, true); pos += 4;
  // RIFF type
  writeString(view, pos, 'WAVE'); pos += 4;
  // format chunk identifier
  writeString(view, pos, 'fmt '); pos += 4;
  // format chunk length
  view.setUint32(pos, 16, true); pos += 4;
  // sample format (raw)
  view.setUint16(pos, 1, true); pos += 2;
  // channel count
  view.setUint16(pos, numOfChan, true); pos += 2;
  // sample rate
  view.setUint32(pos, abuffer.sampleRate, true); pos += 4;
  // byte rate (sample rate * block align)
  view.setUint32(pos, abuffer.sampleRate * 2 * numOfChan, true); pos += 4;
  // block align (channel count * bytes per sample)
  view.setUint16(pos, numOfChan * 2, true); pos += 2;
  // bits per sample
  view.setUint16(pos, 16, true); pos += 2;
  // data chunk identifier
  writeString(view, pos, 'data'); pos += 4;
  // data chunk length
  view.setUint32(pos, length - pos - 4, true); pos += 4;

  for (let i = 0; i < abuffer.numberOfChannels; i++) {
    channels.push(abuffer.getChannelData(i));
  }

  while (offset < len) {
    for (let i = 0; i < numOfChan; i++) {
      let sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  return new Blob([out], { type: 'audio/wav' });
}

export async function createDemoTrackBlob(genre: 'bossa' | 'synth' | 'acoustic'): Promise<Blob> {
  const sampleRate = 22050; // efficient sample rate for quick generation
  const durationSec = 16;
  const numSamples = sampleRate * durationSec;
  
  const OfflineCtx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new OfflineCtx(2, numSamples, sampleRate);

  const notes = genre === 'bossa' 
    ? [261.63, 329.63, 392.00, 493.88, 349.23, 440.00, 523.25] // Cmaj7, Dm7
    : genre === 'synth'
    ? [220.00, 261.63, 329.63, 392.00, 174.61, 220.00, 261.63] // Am, F
    : [196.00, 246.94, 293.66, 392.00, 329.63, 392.00, 493.88]; // G, Em

  // Bass line
  const bassOsc = ctx.createOscillator();
  const bassGain = ctx.createGain();
  bassOsc.type = genre === 'synth' ? 'sawtooth' : 'triangle';
  bassOsc.frequency.setValueAtTime(notes[0] / 2, 0);
  for (let t = 0; t < durationSec; t += 2) {
    const noteIdx = Math.floor(t / 2) % notes.length;
    bassOsc.frequency.setValueAtTime(notes[noteIdx] / 2, t);
  }
  bassGain.gain.setValueAtTime(0.25, 0);
  bassOsc.connect(bassGain);
  bassGain.connect(ctx.destination);
  bassOsc.start(0);
  bassOsc.stop(durationSec);

  // Arpeggios / Chords
  for (let t = 0; t < durationSec; t += 0.5) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const noteIdx = (Math.floor(t * 2)) % notes.length;
    osc.type = genre === 'synth' ? 'square' : 'sine';
    osc.frequency.setValueAtTime(notes[noteIdx], t);

    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.48);
  }

  const renderedBuffer = await ctx.startRendering();
  return bufferToWave(renderedBuffer, renderedBuffer.length);
}
