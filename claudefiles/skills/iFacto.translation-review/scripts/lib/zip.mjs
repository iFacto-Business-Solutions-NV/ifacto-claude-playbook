// zip.mjs — read and write zip archives with the Node standard library only.
//
// Part of the iFacto.translation-review skill. Reads the .app packages in .alpackages (a zip
// behind a NAVX header) and the .xlsx workbooks a customer sends back; writes the .xlsx
// workbooks we send out. No zip64, no encryption: neither occurs in those files.

import zlib, { deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const UTF8_NAMES = 0x0800;
const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1; // 1980-01-01: a fixed date keeps the output reproducible

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(buf) {
    if (typeof zlib.crc32 === 'function') { return zlib.crc32(buf) >>> 0; } // Node 22.2+, much faster
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
    return (c ^ 0xffffffff) >>> 0;
}

function findEnd(buf) {
    const stop = Math.max(0, buf.length - 22 - 0xffff);
    for (let p = buf.length - 22; p >= stop; p--) {
        if (buf.readUInt32LE(p) === SIG_END) { return p; }
    }
    throw new Error('not a zip archive (no end of central directory)');
}

/**
 * The entries of a zip archive. Bytes before the archive are allowed — an .app package starts
 * with a NAVX header — because offsets are resolved against where the central directory
 * really is.
 */
export function readZip(buf) {
    const end = findEnd(buf);
    const count = buf.readUInt16LE(end + 10);
    const cdSize = buf.readUInt32LE(end + 12);
    const cdOffset = buf.readUInt32LE(end + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) { throw new Error('zip64 archives are not supported'); }
    const cdStart = end - cdSize;
    const base = cdStart - cdOffset;
    const entries = new Map();
    let p = cdStart;
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== SIG_CENTRAL) { throw new Error('zip: damaged central directory'); }
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const compSize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const local = base + buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        entries.set(name, { method, crc, compSize, size, local });
        p += 46 + nameLen + extraLen + commentLen;
    }
    const data = (name) => {
        const e = entries.get(name);
        if (!e) { return null; }
        if (buf.readUInt32LE(e.local) !== SIG_LOCAL) { throw new Error(`zip: damaged local header for ${name}`); }
        const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
        const raw = buf.subarray(start, start + e.compSize);
        let out;
        if (e.method === 0) { out = Buffer.from(raw); }
        // The declared size caps the inflation, so a damaged or hostile entry cannot exhaust memory.
        else if (e.method === 8) {
            try { out = e.size ? inflateRawSync(raw, { maxOutputLength: e.size }) : Buffer.alloc(0); } catch {
                throw new Error(`zip: ${name} is damaged (it does not inflate to its declared size)`);
            }
        }
        else { throw new Error(`zip: compression method ${e.method} of ${name} is not supported`); }
        if (out.length !== e.size || crc32(out) !== e.crc) { throw new Error(`zip: ${name} is damaged (size or checksum does not match)`); }
        return out;
    };
    return {
        names: () => [...entries.keys()],
        data,
        text: (name) => {
            const b = data(name);
            return b === null ? null : b.toString('utf8').replace(/^﻿/, '');
        },
    };
}

/** A zip archive of `files` ([{ name, data: Buffer | string }]), every entry deflated. */
export function writeZip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
        const comp = deflateRawSync(data);
        const name = Buffer.from(file.name, 'utf8');
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(SIG_LOCAL, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(UTF8_NAMES, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(DOS_DATE_1980, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        parts.push(local, name, comp);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(SIG_CENTRAL, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(UTF8_NAMES, 8);
        cd.writeUInt16LE(8, 10);
        cd.writeUInt16LE(0, 12);
        cd.writeUInt16LE(DOS_DATE_1980, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(comp.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(cd, name);

        offset += local.length + name.length + comp.length;
    }
    const cdBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cdBuf, end]);
}
