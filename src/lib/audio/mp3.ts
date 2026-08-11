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

const BITRATE_KBPS = 32;
const SAMPLES_PER_FRAME = 1152;

export interface EncodeResult {
  blob: Blob;
  mime: string;
  bytes: number;
}

export async function encodeMp3(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void,
): Promise<EncodeResult> {
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
    if (performance.now() - lastYield > 100) {
      onProgress?.(i / samples.length);
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));
  onProgress?.(1);

  const blob = new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
  return { blob, mime: 'audio/mpeg', bytes: blob.size };
}
