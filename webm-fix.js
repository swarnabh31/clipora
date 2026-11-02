'use strict';
/*
 * MediaRecorder writes WebM files without a Duration element, so many players
 * show "0:00" or cannot seek. This inserts one into Segment > Info.
 * It only touches the first 64 KB of the file and leaves everything else as is.
 * If anything looks unexpected, the original blob is returned untouched.
 */

function ebmlReadId(b, p) {
  const f = b[p];
  if (f === undefined || f === 0) return null;
  let len = 1;
  for (let m = 0x80; !(f & m); m >>= 1) len++;
  if (len > 4 || p + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
  return { len, v };
}

function ebmlReadSize(b, p) {
  const f = b[p];
  if (f === undefined || f === 0) return null;
  let len = 1;
  for (let m = 0x80; !(f & m); m >>= 1) len++;
  if (p + len > b.length) return null;
  const mask = 0xFF >> len;
  let v = f & mask, ones = v === mask;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[p + i];
    if (b[p + i] !== 0xFF) ones = false;
  }
  return { len, v, unknown: ones };
}

function ebmlEncodeSize(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < Math.pow(2, 7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
      out[0] |= 0x80 >> (len - 1);
      return out;
    }
  }
  return null;
}

function webmPatchHead(b, durationMs) {
  let p = 0;
  let id = ebmlReadId(b, p);
  if (!id || id.v !== 0x1A45DFA3) return null;           // EBML header
  let sz = ebmlReadSize(b, p + id.len);
  if (!sz || sz.unknown) return null;
  p += id.len + sz.len + sz.v;

  id = ebmlReadId(b, p);
  if (!id || id.v !== 0x18538067) return null;           // Segment
  sz = ebmlReadSize(b, p + id.len);
  if (!sz) return null;
  p += id.len + sz.len;                                  // step inside the segment

  while (p < b.length) {
    id = ebmlReadId(b, p);
    if (!id) return null;
    const s = ebmlReadSize(b, p + id.len);
    if (!s || s.unknown) return null;
    const dataStart = p + id.len + s.len;
    const dataEnd = dataStart + s.v;
    if (id.v === 0x114D9B74 || id.v === 0x1F43B675) return null;   // SeekHead or Cluster before Info: leave alone
    if (id.v === 0x1549A966) {                                      // Info
      if (dataEnd > b.length) return null;
      let scale = 1000000, q = dataStart;
      while (q < dataEnd) {
        const cid = ebmlReadId(b, q);
        if (!cid) return null;
        const cs = ebmlReadSize(b, q + cid.len);
        if (!cs || cs.unknown) return null;
        if (cid.v === 0x4489) return null;                          // already has a Duration
        if (cid.v === 0x2AD7B1) {                                   // TimecodeScale
          let v = 0;
          for (let i = 0; i < cs.v; i++) v = v * 256 + b[q + cid.len + cs.len + i];
          if (v > 0) scale = v;
        }
        q += cid.len + cs.len + cs.v;
      }
      const dur = new Uint8Array(11);
      dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88;                  // Duration, 8-byte float
      new DataView(dur.buffer).setFloat64(3, durationMs * 1e6 / scale, false);
      const newSize = ebmlEncodeSize(s.v + dur.length);
      if (!newSize) return null;
      const idBytes = b.subarray(p, p + id.len);
      const info = b.subarray(dataStart, dataEnd);
      const before = b.subarray(0, p);
      const out = new Uint8Array(before.length + idBytes.length + newSize.length + info.length + dur.length);
      let o = 0;
      [before, idBytes, newSize, info, dur].forEach((part) => { out.set(part, o); o += part.length; });
      return { bytes: out, consumed: dataEnd };
    }
    p = dataEnd;
  }
  return null;
}

async function fixWebmDuration(blob, durationMs) {
  try {
    if (!durationMs || durationMs < 1 || blob.size < 64 || !/webm/.test(blob.type)) return blob;
    const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    const patched = webmPatchHead(head, durationMs);
    if (!patched) return blob;
    return new Blob([patched.bytes, blob.slice(patched.consumed)], { type: blob.type });
  } catch {
    return blob;
  }
}
