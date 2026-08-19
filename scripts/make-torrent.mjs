#!/usr/bin/env node
/**
 * Build BitTorrent v1 metadata (.torrent + magnet) for one file.
 *
 * Mirrors server/crates/ai00-storage/src/share_storage/torrent.rs
 * `build_torrent`: 256 KiB pieces, single announce, no private flag — so the
 * info_hash produced here MUST equal the one the server would rebuild from
 * the same file (same piece length + same name + same tracker rules).
 *
 * Usage: node make-torrent.mjs <file> <tracker-url> [out.torrent]
 *   (omit out.torrent to write <file>.torrent next to it)
 * Prints JSON on success: { infoHash, magnet, torrentPath }
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { basename, join, dirname } from 'path';

const PIECE_LENGTH = 256 * 1024;

// ── bencode (v1 subset: int / bytes / list / dict) ──────────────────────
function encode(value) {
  if (typeof value === 'number') {
    return Buffer.from(`i${value}e`);
  }
  if (Buffer.isBuffer(value)) {
    const len = Buffer.from(`${value.length}:`);
    return Buffer.concat([len, value]);
  }
  if (typeof value === 'string') {
    return encode(Buffer.from(value, 'utf8'));
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
  }
  if (value && typeof value === 'object') {
    const parts = [Buffer.from('d')];
    for (const key of Object.keys(value).sort()) {
      parts.push(encode(key), encode(value[key]));
    }
    parts.push(Buffer.from('e'));
    return Buffer.concat(parts);
  }
  throw new Error(`cannot bencode ${typeof value}`);
}

function buildTorrent(filePath, trackerUrl) {
  const data = readFileSync(filePath);
  const name = basename(filePath);

  // piece hashes: sha1 per 256 KiB chunk (last one may be shorter)
  const pieces = [];
  for (let off = 0; off < data.length; off += PIECE_LENGTH) {
    pieces.push(createHash('sha1').update(data.subarray(off, off + PIECE_LENGTH)).digest());
  }

  const info = {
    length: data.length,
    name: Buffer.from(name, 'utf8'),
    'piece length': PIECE_LENGTH,
    pieces: Buffer.concat(pieces),
  };
  const torrent = {
    announce: Buffer.from(trackerUrl, 'utf8'),
    info,
  };

  const infoBencoded = encode(info);
  const infoHash = createHash('sha1').update(infoBencoded).digest('hex').toUpperCase();

  const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}&tr=${encodeURIComponent(trackerUrl)}`;
  return { torrentBytes: encode(torrent), infoHash, magnet };
}

function main() {
  const [file, trackerUrl, outArg] = process.argv.slice(2);
  if (!file || !trackerUrl) {
    console.error('usage: node make-torrent.mjs <file> <tracker-url> [out.torrent]');
    process.exit(1);
  }

  const { torrentBytes, infoHash, magnet } = buildTorrent(file, trackerUrl);
  const out = outArg || join(dirname(file), `${basename(file)}.torrent`);
  writeFileSync(out, torrentBytes);
  console.log(JSON.stringify({ infoHash, magnet, torrentPath: out }));
}

main();
