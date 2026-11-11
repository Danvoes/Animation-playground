/*
 * audio.js
 * The sound engine (Web Audio).
 *   - decode(blob): turns a sound file (MP3, WAV, M4A, OGG, ...) into playable audio
 *   - peaks(buffer): loudness over time, used to draw waveforms
 *   - schedule(...): plays sounds at exact moments, so they stay in sync with the animation
 *
 * Times are in seconds. "Animation time" counts from the start of frame 1.
 */
(function () {
  'use strict';

  let ctx = null;
  function getCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }

  async function decode(blob) {
    const c = getCtx();
    if (!c) throw new Error('This browser cannot play sound');
    const data = await blob.arrayBuffer();
    // Older Safari only supports the callback form, newer browsers return a promise.
    return new Promise((resolve, reject) => {
      const p = c.decodeAudioData(data, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // Loudest sample in each 1/perSecond slice of the sound (0 to 1).
  function peaks(buffer, perSecond) {
    perSecond = perSecond || 100;
    const n = Math.max(1, Math.ceil(buffer.duration * perSecond));
    const out = new Float32Array(n);
    const chans = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) chans.push(buffer.getChannelData(i));
    const step = buffer.sampleRate / perSecond;
    for (let i = 0; i < n; i++) {
      const s = Math.floor(i * step), e = Math.min(chans[0].length, Math.floor((i + 1) * step));
      let m = 0;
      for (const ch of chans) {
        for (let j = s; j < e; j += 4) {
          const v = Math.abs(ch[j]);
          if (v > m) m = v;
        }
      }
      out[i] = Math.min(1, m);
    }
    return out;
  }

  /**
   * Play the part of each clip that falls between animation times `from` and `to`,
   * with animation time `from` happening at audio-clock time `when`.
   * clip = { buffer, offset (when it starts in the animation), skip (seconds cut from
   *          its beginning), volume, muted }
   * Returns the started sound nodes (so they can be stopped).
   */
  function schedule(clips, from, to, when, destination) {
    const c = getCtx();
    const dest = destination || c.destination;
    const nodes = [];
    for (const clip of clips) {
      if (clip.muted || !clip.buffer) continue;
      const length = clip.buffer.duration - clip.skip;
      if (length <= 0) continue;
      const start = Math.max(clip.offset, from);
      const end = Math.min(clip.offset + length, to);
      if (end <= start) continue;
      let at = when + (start - from);
      let bufferOffset = clip.skip + (start - clip.offset);
      let duration = end - start;
      // If that moment has already passed, start now from the right spot.
      const late = c.currentTime - at;
      if (late > 0) { at += late; bufferOffset += late; duration -= late; }
      if (duration <= 0.01) continue;
      const src = c.createBufferSource();
      src.buffer = clip.buffer;
      const gain = c.createGain();
      gain.gain.value = clip.volume;
      src.connect(gain);
      gain.connect(dest);
      src.start(at, bufferOffset, duration);
      nodes.push(src);
    }
    return nodes;
  }

  function stopAll(nodes) {
    for (const n of nodes) { try { n.stop(); } catch (_) { /* already stopped */ } }
  }

  window.SoundEngine = { getCtx, decode, peaks, schedule, stopAll };
})();
