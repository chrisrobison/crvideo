// Minimal ISO-BMFF (MP4) box-walking utilities — no DOM/browser dependency,
// works against a plain ArrayBuffer so it can run in the page or under Node
// for testing. Used by channel.html's chunked player to parse just enough
// of a *fragmented* MP4 (ftyp/moov/moof/mdat) to feed MediaSource without
// ever downloading (or even knowing) the whole file.
//
// Deliberately minimal: reads only the boxes needed to (a) confirm a file is
// fragmented, (b) build a MediaSource-compatible init segment + codec
// string, and (c) find a fragment's start time (tfdt) for seeking. It is not
// a general-purpose MP4 parser.

/** Read a big-endian box header at `offset`. Returns null if not enough bytes. */
export function readBoxHeader(view, offset) {
  if (offset + 8 > view.byteLength) return null;
  const size32 = view.getUint32(offset);
  const type = String.fromCharCode(
    view.getUint8(offset + 4), view.getUint8(offset + 5),
    view.getUint8(offset + 6), view.getUint8(offset + 7));
  if (size32 === 1) {
    if (offset + 16 > view.byteLength) return null;
    const hi = view.getUint32(offset + 8), lo = view.getUint32(offset + 12);
    return { type, size: hi * 2 ** 32 + lo, headerSize: 16 };
  }
  if (size32 === 0) return { type, size: Infinity, headerSize: 8 }; // extends to EOF
  return { type, size: size32, headerSize: 8 };
}

/** Walk top-level boxes within [start,end) of `buffer`. Stops at the first box that doesn't fully fit. */
export function* walkBoxes(buffer, start = 0, end = buffer.byteLength) {
  const view = new DataView(buffer);
  let pos = start;
  while (pos + 8 <= end) {
    const h = readBoxHeader(view, pos);
    if (!h) break;
    const boxEnd = Number.isFinite(h.size) ? pos + h.size : end;
    const complete = boxEnd <= end;
    yield { type: h.type, start: pos, headerSize: h.headerSize, contentStart: pos + h.headerSize, end: boxEnd, complete };
    if (!complete) break; // box extends past what's been fetched — caller should fetch more and retry
    if (!Number.isFinite(h.size) || h.size < 8) break;
    pos += h.size;
  }
}

/** Find the first direct child box of a given type within [start,end). */
export function findChild(buffer, type, start, end) {
  for (const box of walkBoxes(buffer, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/** Resolve a dotted/array path of nested container boxes, e.g. findPath(buf, moov, ["trak","mdia","mdhd"]). */
export function findPath(buffer, rootBox, path) {
  let box = rootBox;
  for (const type of path) {
    if (!box) return null;
    box = findChild(buffer, type, box.contentStart, box.end);
  }
  return box;
}

/** All direct children of a container box, keyed by type -> first match (good enough for our uses). */
export function childMap(buffer, box) {
  const map = {};
  for (const child of walkBoxes(buffer, box.contentStart, box.end)) {
    if (!(child.type in map)) map[child.type] = child;
  }
  return map;
}

/** All direct children of a container box that share a type (moov has multiple `trak`, moof multiple `traf`). */
export function childList(buffer, box, type) {
  const out = [];
  for (const child of walkBoxes(buffer, box.contentStart, box.end)) {
    if (child.type === type) out.push(child);
  }
  return out;
}

function hex2(n) { return n.toString(16).padStart(2, "0"); }

// --- MPEG-4 descriptor (ES_Descriptor / esds) parsing -----------------------
// esds wraps its config in a nested tag-length-value structure (ISO 14496-1),
// NOT plain fixed-offset fields — the length of each descriptor is itself a
// variable-length "extended length" encoding (continuation bit 0x80 on all
// but the last byte). Scanning bytes for a literal tag value without walking
// this structure will find the wrong byte as soon as any earlier field
// happens to contain that value, so this walks it properly.
function readDescriptorLength(bytes, pos) {
  let len = 0, b;
  do {
    b = bytes[pos++];
    len = (len << 7) | (b & 0x7f);
  } while ((b & 0x80) && pos < bytes.length);
  return { len, pos };
}

function findDescriptor(bytes, start, end, wantTag) {
  let pos = start;
  while (pos < end) {
    const tag = bytes[pos++];
    const { len, pos: afterLen } = readDescriptorLength(bytes, pos);
    pos = afterLen;
    if (tag === wantTag) return { start: pos, end: Math.min(pos + len, end) };
    pos += len;
  }
  return null;
}

/** Read the AudioObjectType (top 5 bits of the AudioSpecificConfig) out of an `esds` box. Returns null if not found. */
function readAacAudioObjectType(buffer, esds) {
  const bytes = new Uint8Array(buffer, esds.contentStart + 4, esds.end - (esds.contentStart + 4)); // +4 skips esds version/flags
  const es = findDescriptor(bytes, 0, bytes.length, 0x03); // ES_DescrTag
  if (!es) return null;
  const flags = bytes[es.start + 2];
  let pos = es.start + 3; // past ES_ID(2) + flags(1)
  if (flags & 0x80) pos += 2; // streamDependenceFlag -> dependsOn_ES_ID
  if (flags & 0x40) pos += 1 + bytes[pos]; // URL_Flag -> URLlength + URLstring
  if (flags & 0x20) pos += 2; // OCRstreamFlag -> OCR_ES_Id

  const decConfig = findDescriptor(bytes, pos, es.end, 0x04); // DecoderConfigDescrTag
  if (!decConfig) return null;
  const decSpecific = findDescriptor(bytes, decConfig.start + 13, decConfig.end, 0x05); // DecSpecificInfoTag (13 = fixed fields before it)
  if (!decSpecific || decSpecific.start >= bytes.length) return null;
  return bytes[decSpecific.start] >> 3;
}

/** Build a MediaSource-compatible codec string for one `stsd` sample entry (avc1 or mp4a). */
function codecStringForSampleEntry(buffer, view, stsd) {
  // stsd: version(1)+flags(3) + entry_count(4), then sample entries
  const entryCountOffset = stsd.contentStart + 4;
  for (const box of walkBoxes(buffer, entryCountOffset + 4, stsd.end)) {
    if (box.type === "avc1" || box.type === "avc3") {
      // avc1 box: 78 bytes of fixed fields, then child boxes incl. avcC
      const avcC = findChild(buffer, "avcC", box.contentStart + 78, box.end);
      if (avcC) {
        const p = avcC.contentStart;
        // avcC: version(1) profile(1) compat(1) level(1) ...
        const profile = view.getUint8(p + 1);
        const compat = view.getUint8(p + 2);
        const level = view.getUint8(p + 3);
        return `avc1.${hex2(profile)}${hex2(compat)}${hex2(level)}`;
      }
      return "avc1";
    }
    if (box.type === "hvc1" || box.type === "hev1") {
      return box.type; // HEVC codec-string construction is more involved; not expected here
    }
    if (box.type === "mp4a") {
      // mp4a box: 28 bytes fixed fields, then child boxes incl. esds
      const esds = findChild(buffer, "esds", box.contentStart + 28, box.end);
      if (esds) {
        const audioObjectType = readAacAudioObjectType(buffer, esds);
        if (audioObjectType != null) return `mp4a.40.${audioObjectType}`;
      }
      return "mp4a.40.2"; // reasonable default (AAC-LC)
    }
    break; // only the first sample entry matters for the codec string
  }
  return null;
}

/**
 * Parse an initial byte window (bytes 0..N) of a fragmented MP4. Returns:
 *   { ok:true, fragmented:true, initSegment: ArrayBuffer, mimeCodec, timescales: {trackId->timescale},
 *     primaryTrackId, duration }
 * or { ok:false, reason: "need-more" | "not-fragmented" | "no-moov" }
 * "need-more" means the window didn't fully contain ftyp+moov — caller should re-fetch a larger window.
 */
export function parseInitSegment(buffer) {
  const view = new DataView(buffer);
  const ftyp = findChild(buffer, "ftyp", 0, buffer.byteLength);
  if (!ftyp || !ftyp.complete) return { ok: false, reason: "need-more" };

  const moov = findChild(buffer, "moov", ftyp.end, buffer.byteLength);
  if (!moov) return { ok: false, reason: "need-more" };
  if (!moov.complete) return { ok: false, reason: "need-more" };

  const moovChildren = childMap(buffer, moov);
  if (!moovChildren.mvex) return { ok: false, reason: "not-fragmented" };

  const traks = childList(buffer, moov, "trak");
  const timescales = {};
  let mimeCodecs = [];
  let primaryTrackId = null;

  for (const trak of traks) {
    const tkhd = findChild(buffer, "tkhd", trak.contentStart, trak.end);
    const mdia = findChild(buffer, "mdia", trak.contentStart, trak.end);
    if (!tkhd || !mdia) continue;
    const version = view.getUint8(tkhd.contentStart);
    const trackId = version === 1
      ? view.getUint32(tkhd.contentStart + 20)
      : view.getUint32(tkhd.contentStart + 12);

    const mdhd = findChild(buffer, "mdhd", mdia.contentStart, mdia.end);
    if (!mdhd) continue;
    const mdhdVersion = view.getUint8(mdhd.contentStart);
    const timescale = mdhdVersion === 1
      ? view.getUint32(mdhd.contentStart + 20)
      : view.getUint32(mdhd.contentStart + 12);
    timescales[trackId] = timescale;

    const stbl = findPath(buffer, mdia, ["minf", "stbl"]);
    const stsd = stbl && findChild(buffer, "stsd", stbl.contentStart, stbl.end);
    if (stsd) {
      const codec = codecStringForSampleEntry(buffer, view, stsd);
      if (codec) mimeCodecs.push(codec);
      if (primaryTrackId == null && /^avc1|^hvc/.test(codec || "")) primaryTrackId = trackId;
    }
  }
  if (primaryTrackId == null && Object.keys(timescales).length) {
    primaryTrackId = Number(Object.keys(timescales)[0]);
  }

  const mvhd = findChild(buffer, "mvhd", moov.contentStart, moov.end);
  let duration = null;
  if (mvhd) {
    const v = view.getUint8(mvhd.contentStart);
    const movieTimescale = v === 1 ? view.getUint32(mvhd.contentStart + 20) : view.getUint32(mvhd.contentStart + 12);
    const rawDuration = v === 1
      ? Number(view.getBigUint64(mvhd.contentStart + 24))
      : view.getUint32(mvhd.contentStart + 16);
    if (movieTimescale > 0 && Number.isFinite(rawDuration)) duration = rawDuration / movieTimescale;
  }

  return {
    ok: true,
    fragmented: true,
    initSegment: buffer.slice(0, moov.end),
    mimeCodec: `video/mp4; codecs="${mimeCodecs.join(", ")}"`,
    timescales,
    primaryTrackId,
    duration,
  };
}

/**
 * Blindly locate the byte offset of a real `moof` box within an arbitrary
 * window that is NOT known to start on a box boundary — needed when seeking,
 * since the window is fetched around an estimated (bitrate-guessed) byte
 * offset that can land anywhere, including mid-`mdat`. `findFragments`/
 * `walkBoxes`, by contrast, assume the position they're given already IS a
 * box boundary (true for sequential streaming, which always resumes from a
 * known-aligned point) and must NOT be used directly on an unaligned window.
 *
 * Scans for the literal 4-byte "moof" tag and, for each candidate, verifies
 * it's a real box header (not a coincidental byte sequence inside compressed
 * media data) by checking that stepping forward by its declared size lands
 * on another plausible box header. Returns the box's start offset (4 bytes
 * before the tag) or -1 if none found.
 */
export function scanForMoof(buffer, searchStart, searchEnd) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const limit = Math.min(searchEnd, bytes.length) - 4;
  for (let i = Math.max(searchStart, 0); i <= limit; i++) {
    if (bytes[i] !== 0x6d || bytes[i + 1] !== 0x6f || bytes[i + 2] !== 0x6f || bytes[i + 3] !== 0x66) continue; // "moof"
    const boxStart = i - 4;
    if (boxStart < 0) continue;
    const h = readBoxHeader(view, boxStart);
    if (!h || h.type !== "moof" || !Number.isFinite(h.size) || h.size < 8) continue;
    const nextPos = boxStart + h.size;
    if (nextPos + 8 <= bytes.length) {
      const nh = readBoxHeader(view, nextPos);
      if (!nh || !/^[a-zA-Z0-9][a-zA-Z0-9 ]{3}$/.test(nh.type)) continue; // doesn't look like a real following box
    }
    return boxStart;
  }
  return -1;
}

/**
 * Given a buffer window known to contain one or more complete `moof` boxes
 * (each immediately followed by its `mdat`), return an array of
 * { moofStart, segmentEnd, startTimeSec (using `timescales`) } describing
 * each complete fragment found — segmentEnd covers through the end of the
 * paired mdat so the pair can be appended to a SourceBuffer as one unit.
 */
export function findFragments(buffer, windowStart, windowEnd, timescales, primaryTrackId) {
  const view = new DataView(buffer);
  const fragments = [];
  let pos = windowStart;
  while (pos + 8 <= windowEnd) {
    const moof = findChild(buffer, "moof", pos, windowEnd);
    if (!moof || !moof.complete) break;
    const mdat = findChild(buffer, "mdat", moof.end, windowEnd);
    if (!mdat || !mdat.complete) break;

    let startTimeSec = null;
    for (const traf of childList(buffer, moof, "traf")) {
      const tfhd = findChild(buffer, "tfhd", traf.contentStart, traf.end);
      const tfdt = findChild(buffer, "tfdt", traf.contentStart, traf.end);
      if (!tfhd || !tfdt) continue;
      const trackId = view.getUint32(tfhd.contentStart + 4);
      const tfdtVersion = view.getUint8(tfdt.contentStart);
      const baseMediaDecodeTime = tfdtVersion === 1
        ? Number(view.getBigUint64(tfdt.contentStart + 4))
        : view.getUint32(tfdt.contentStart + 4);
      const ts = timescales[trackId];
      if (!ts) continue;
      if (trackId === primaryTrackId || startTimeSec == null) {
        startTimeSec = baseMediaDecodeTime / ts;
        if (trackId === primaryTrackId) break;
      }
    }

    fragments.push({ moofStart: moof.start, segmentEnd: mdat.end, startTimeSec });
    pos = mdat.end;
  }
  return fragments;
}
