/**
 * Minimal ZIP writer and reader (deflate + store), on node:zlib alone.
 *
 * An .mcpb bundle is a ZIP, and Node ships no ZIP API. This is here rather than
 * a dependency because it is build tooling for an artifact channel: nothing it
 * produces or reads reaches the server's runtime, and the alternative is a new
 * package in the toolchain of a repo whose whole dependency story is "one
 * runtime dependency, stdio only".
 *
 * Scope, stated so nobody mistakes it for a zip library: no zip64 (so under
 * 65,535 entries and under 4 GB, asserted below), no encryption, no directory
 * entries, no symlinks, no per-file permissions. Fixed timestamps, so the same
 * inputs produce the same bytes.
 *
 * Format reference: PKWARE APPNOTE.TXT 6.3.10, sections 4.3.7 (local file
 * header), 4.3.12 (central directory), 4.3.16 (end of central directory).
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;
/** 1980-01-01 00:00:00 in DOS date/time: the epoch of the format itself. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * Write a ZIP archive.
 * @param {string} outPath
 * @param {Array<{name: string, data: Buffer}>} entries  names use forward slashes
 */
export function writeZip(outPath, entries) {
  if (entries.length > 0xffff) throw new Error(`zip: ${entries.length} entries exceeds the non-zip64 limit of 65535`);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    if (name.includes("\\")) throw new Error(`zip: entry name must use forward slashes: ${name}`);
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    // Storing is honest when deflate makes a file bigger (already-compressed
    // payloads: .png, .gz, some .node binaries).
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const crc = crc32(data);
    if (data.length > 0xffffffff || body.length > 0xffffffff) {
      throw new Error(`zip: ${name} exceeds the non-zip64 4 GB limit`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL_SIG, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(FLAG_UTF8, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number start
    dir.writeUInt16LE(0, 36); // internal attributes
    dir.writeUInt32LE(0, 38); // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, eocd]));
  return { entries: entries.length, bytes: offset + centralBuf.length + eocd.length };
}

/**
 * Read a ZIP archive's central directory.
 * @returns {Map<string, {size: number, compressedSize: number, method: number, read: () => Buffer}>}
 */
export function readZip(path) {
  const buf = readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 0xffff - 22; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`zip: no end-of-central-directory record in ${path}`);

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error(`zip: bad central directory entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");

    out.set(name, {
      size,
      compressedSize,
      method,
      read() {
        if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`zip: bad local header for ${name}`);
        const localNameLen = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLen + localExtraLen;
        const body = buf.slice(start, start + compressedSize);
        const data = method === METHOD_DEFLATE ? inflateRawSync(body) : Buffer.from(body);
        if (crc32(data) !== crc) throw new Error(`zip: CRC mismatch for ${name}`);
        return data;
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
