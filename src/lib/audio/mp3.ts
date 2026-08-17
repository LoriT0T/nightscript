'use client';

/**
 * MP3 encoding, in the browser.
 *
 * The brief asked for Opus in WebM/CAF with an AAC fallback for iOS Safari. That needs
 * WebCodecs plus a container muxer, and Safari's AudioEncoder support is the exact thing
 * that would break on the one platform the fallback existed to serve. MP3 at 32 kbps mono
 * is 14 MB per hour — comfortably inside the 30 MB budget — and plays on every browser and
 * every lock screen without a codec question. One encoder that always works beat two that
 * mostly do.
 *
 * If Opus becomes worth the size saving later, this is the only file that changes.
 */

/**
 * 48 kbps, and NOT 32.
 *
 * At 32 kbps the encoder emits frames that decode to near-silence for any sample rate below
 * 44.1 kHz — the MPEG-2 LSF path. Measured 2026-08-15 with a -12.3 dBFS sine at 24 kHz:
 *
 *   32 kbps → mean -53.8 dB   ← broken, and the file is still the right size
 *   40 kbps → mean -15.8 dB   ← correct
 *   48 kbps → mean -15.8 dB   ← correct, chosen for margin
 *   64 kbps → mean -15.8 dB
 *
 * The same input at 44.1 kHz/32 kbps encodes correctly, which is why this looked like a
 * sample-rate problem and is not. 48 rather than 40 because being one step from a cliff whose
 * cause is not understood is not worth the 3.6 MB.
 *
 * Cost: ~21.9 MB an hour, still well inside the 30 MB budget.
 */
const BITRATE_KBPS = 48;
const SAMPLES_PER_FRAME = 1152;

/**
 * Hand the main thread back without using setTimeout.
 *
 * Browsers clamp timers to roughly one per second in a tab that is not focused. Encoding an
 * hour yields a few hundred times, so a setTimeout-based loop that finishes in under a
 * minute while you watch it takes ten minutes the moment you switch tabs — which is exactly
 * what someone does while waiting for a long generation. Measured: an hour-long encode sat
 * apparently frozen for over five minutes in a background tab.
 *
 * `scheduler.yield()` is the right tool where it exists; a MessageChannel round-trip is the
 * fallback, and is a task rather than a timer, so it is not throttled the same way.
 */
const yieldToBrowser: () => Promise<void> = (() => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return () => scheduler.yield!();
  if (typeof MessageChannel !== 'undefined') {
    return () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          resolve();
        };
        channel.port2.postMessage(undefined);
      });
  }
  return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
})();

export interface EncodeResult {
  blob: Blob;
  mime: string;
  bytes: number;
}

/**
 * Prove the encoder settings actually produce sound before trusting them with an hour.
 *
 * This exists because a silent MP3 plays perfectly: it has the right duration, the right size,
 * `currentTime` advances, `canPlayType` says yes. Every check that was being run passed while
 * the listener heard nothing. The only honest test is to decode the output and look at the
 * level, so that is what this does — on half a second of known-loud sine, once per session.
 */
let encoderVerified: Promise<void> | null = null;

async function verifyEncoderAudible(sampleRate: number): Promise<void> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const probe = new Mp3Encoder(1, sampleRate, BITRATE_KBPS);
  const n = Math.round(sampleRate * 0.5);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 8000);

  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i += SAMPLES_PER_FRAME) {
    const out = probe.encodeBuffer(pcm.subarray(i, Math.min(i + SAMPLES_PER_FRAME, n)));
    if (out.length) parts.push(new Uint8Array(out));
  }
  const tail = probe.flush();
  if (tail.length) parts.push(new Uint8Array(tail));

  const blob = new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
  const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const ch = decoded.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i];
      if (a > peak) peak = a;
    }
    const peakDb = 20 * Math.log10(peak || 1e-12);
    // The probe is -12.3 dBFS. Anything below -30 means the encoder is emitting silence.
    if (peakDb < -30) {
      throw new Error(
        `The MP3 encoder is producing silence at ${sampleRate} Hz / ${BITRATE_KBPS} kbps ` +
          `(probe decoded at ${peakDb.toFixed(1)} dB, expected about -12). Refusing to render a ` +
          `track that would have no sound.`,
      );
    }
  } finally {
    await ctx.close();
  }
}

export async function encodeMp3(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void,
): Promise<EncodeResult> {
  // Cheap, cached, and it would have caught the silent-track bug on the first run.
  encoderVerified ??= verifyEncoderAudible(sampleRate);
  await encoderVerified;

  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const encoder = new Mp3Encoder(1, sampleRate, BITRATE_KBPS);
  const chunks: Uint8Array[] = [];

  // Convert in blocks rather than allocating a second full-length Int16Array: an hour is
  // 86 million samples and the browser tab has to survive this.
  const block = SAMPLES_PER_FRAME * 64;
  const buffer = new Int16Array(block);
  let lastYield = performance.now();

  for (let i = 0; i < samples.length; i += block) {
    const n = Math.min(block, samples.length - i);
    for (let j = 0; j < n; j++) {
      const s = Math.max(-1, Math.min(1, samples[i + j]));
      buffer[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const encoded = encoder.encodeBuffer(n === block ? buffer : buffer.subarray(0, n));
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));

    // Hand the main thread back periodically so the progress UI keeps painting.
    if (performance.now() - lastYield > 250) {
      onProgress?.(i / samples.length);
      await yieldToBrowser();
      lastYield = performance.now();
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));
  onProgress?.(1);

  const blob = new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
  return { blob, mime: 'audio/mpeg', bytes: blob.size };
}
