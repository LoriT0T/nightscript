/**
 * The API returns raw headerless PCM (`audio/l16; rate=24000; channels=1`), base64
 * encoded. There is no RIFF header in the payload — writing the bytes straight to a
 * .wav file yields noise. See docs/GEMINI-TTS.md §5.
 */

export const SAMPLE_RATE = 24000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;

/** Prepend a canonical 44-byte RIFF/WAVE header to raw signed 16-bit LE PCM. */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate = SAMPLE_RATE,
  channels = CHANNELS,
  bitsPerSample = BITS_PER_SAMPLE,
): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true); // ChunkSize
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // Subchunk1Size, PCM
  v.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  v.setUint32(40, pcm.byteLength, true);

  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/** Seconds of audio in a raw PCM buffer. */
export function pcmDurationSec(pcm: Uint8Array, sampleRate = SAMPLE_RATE): number {
  return pcm.byteLength / ((BITS_PER_SAMPLE / 8) * CHANNELS) / sampleRate;
}

/** RMS in dBFS of raw signed-16 LE PCM. Used for drift detection across chunks. */
export function pcmRmsDb(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = Math.floor(pcm.byteLength / 2);
  if (n === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}
