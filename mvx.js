/*
 * Liest MangaVault-Exportdateien (.mvx) direkt im Browser – nur lesend, alles bleibt im Arbeitsspeicher.
 *
 *   Kopf:      "MVX1"(4) | Version(1) | 0(1) | Iterationen u32(4) | Salt(32)         = 42 Byte
 *   Schluessel: PBKDF2-HMAC-SHA512(Passwort, Salt) -> 32 Byte AES-256 + 32 Byte HMAC-SHA256
 *   Datensatz: Laenge u32 | IV(16) | AES-256-CBC | HMAC(Kopf | Nummer | Laenge | IV | Chiffrat)(32)
 *   Datensatz 0 = Inhaltsverzeichnis, 1..N = Seiten, N+1 = Endmarke.
 *
 * Jeder Datensatz wird vor dem Entschluesseln geprueft (Manipulation, Vertauschen, Abschneiden).
 */
'use strict';

const MVX = (() => {
  const HEADER_LEN = 42, IV_LEN = 16, TAG_LEN = 32;
  const MAGIC = [0x4D, 0x56, 0x58, 0x31];
  const MANIFEST_MAGIC = 0x4D58564D;
  const END_MARKER = new TextEncoder().encode('MVXEND');
  const MAX_RECORD = 100 * 1024 * 1024 + 1024;
  const MIN_ITER = 600000, MAX_ITER = 50000000;
  const TICKS_EPOCH = 621355968000000000n; // .NET-Ticks am 1.1.1970

  class WrongPasswordError extends Error {}
  class CorruptError extends Error {}
  const BROKEN = 'Die Datei ist unvollständig oder beschädigt.';

  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  async function readSlice(file, start, len) {
    if (start < 0 || start + len > file.size) throw new CorruptError(BROKEN);
    return new Uint8Array(await file.slice(start, start + len).arrayBuffer());
  }

  // ------------------------------------------------ .NET BinaryReader-Format (Inhaltsverzeichnis)
  class Reader {
    constructor(bytes) {
      this.b = bytes;
      this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.o = 0;
      this.dec = new TextDecoder('utf-8', { fatal: true });
    }
    need(n) { if (this.o + n > this.b.length) throw new CorruptError('Ungültiges Inhaltsverzeichnis.'); }
    u32() { this.need(4); const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
    i32() { this.need(4); const x = this.v.getInt32(this.o, true); this.o += 4; return x; }
    bool() { this.need(1); return this.b[this.o++] !== 0; }
    ticks() {
      this.need(8);
      const t = this.v.getBigInt64(this.o, true); this.o += 8;
      return t <= TICKS_EPOCH ? 0 : Number((t - TICKS_EPOCH) / 10000n);
    }
    str() {
      let len = 0, shift = 0, byte;
      do {
        this.need(1);
        byte = this.b[this.o++];
        len |= (byte & 0x7F) << shift;
        shift += 7;
        if (shift > 35) throw new CorruptError('Ungültiges Inhaltsverzeichnis.');
      } while (byte & 0x80);
      this.need(len);
      const s = this.dec.decode(this.b.subarray(this.o, this.o + len));
      this.o += len;
      return s;
    }
  }

  function parseManifest(bytes) {
    const r = new Reader(bytes);
    if (r.u32() !== MANIFEST_MAGIC) throw new CorruptError('Ungültiges Inhaltsverzeichnis.');
    const n = r.i32();
    if (n < 0 || n > 100000) throw new CorruptError('Ungültiges Inhaltsverzeichnis.');
    const series = [];
    let rec = 1;
    for (let i = 0; i < n; i++) {
      const s = { index: i, title: r.str(), folder: r.str().trim(), added: r.ticks(), lastRead: r.ticks(), chapters: [] };
      const cc = r.i32();
      if (cc < 0 || cc > 100000) throw new CorruptError('Ungültiges Inhaltsverzeichnis.');
      for (let k = 0; k < cc; k++) {
        const c = { index: k, series: s, title: r.str(), added: r.ticks(), lastRead: r.ticks(), lastPage: r.i32(), finished: r.bool(), pages: [] };
        const pc = r.i32();
        if (pc < 0 || pc > 1000000 || rec + pc > 10000001) throw new CorruptError('Ungültiges Inhaltsverzeichnis.');
        for (let q = 0; q < pc; q++) c.pages.push({ w: r.i32(), h: r.i32(), rec: rec++ });
        c.lastPage = Math.max(0, Math.min(c.lastPage, Math.max(0, pc - 1)));
        s.chapters.push(c);
      }
      series.push(s);
    }
    return { series, pageCount: rec - 1 };
  }

  // ------------------------------------------------ Geoeffnete Datei
  class Vault {
    constructor(file, header, encKey, macKey) {
      this.file = file;
      this.header = header;
      this.encKey = encKey;
      this.macKey = macKey;
      this.offsets = [HEADER_LEN]; // offsets[i] = Beginn von Datensatz i
      this.scanLock = Promise.resolve();
      this.closed = false;
    }

    /** Ermittelt die Dateiposition von Datensatz idx (Laengenfelder werden der Reihe nach gelesen). */
    async offsetOf(idx) {
      while (this.offsets.length <= idx) await this.scanStep(idx);
      return this.offsets[idx];
    }

    /** Liest bis zu 32 weitere Laengenfelder. Kleine Schritte, damit Seitenanfragen nicht hinter dem Hintergrund-Scan warten. */
    scanStep(target) {
      const p = this.scanLock.then(async () => {
        for (let n = 0; n < 32 && this.offsets.length <= target; n++) {
          if (this.closed) throw new Error('Geschlossen');
          const off = this.offsets[this.offsets.length - 1];
          const len = u32(await readSlice(this.file, off, 4), 0);
          if (len === 0 || len % 16 !== 0 || len > MAX_RECORD) throw new CorruptError(BROKEN);
          this.offsets.push(off + 4 + IV_LEN + len + TAG_LEN);
        }
      });
      this.scanLock = p.catch(() => {});
      return p;
    }

    async readRecord(idx) {
      if (this.closed) throw new Error('Geschlossen');
      const off = await this.offsetOf(idx);
      const len = u32(await readSlice(this.file, off, 4), 0);
      if (len === 0 || len % 16 !== 0 || len > MAX_RECORD) throw new CorruptError(BROKEN);
      const rec = await readSlice(this.file, off, 4 + IV_LEN + len + TAG_LEN);
      // MAC ueber Kopf | Nummer | Laenge | IV | Chiffrat
      const msg = new Uint8Array(HEADER_LEN + 4 + 4 + IV_LEN + len);
      msg.set(this.header, 0);
      new DataView(msg.buffer).setUint32(HEADER_LEN, idx, true);
      msg.set(rec.subarray(0, 4 + IV_LEN + len), HEADER_LEN + 4);
      const tag = rec.subarray(4 + IV_LEN + len);
      const ok = await crypto.subtle.verify('HMAC', this.macKey, tag, msg);
      if (!ok) throw idx === 0 ? new WrongPasswordError('Falsches Passwort') : new CorruptError(BROKEN);
      const iv = rec.slice(4, 4 + IV_LEN);
      const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, this.encKey, rec.subarray(4 + IV_LEN, 4 + IV_LEN + len));
      return new Uint8Array(plain);
    }

    /** Prueft im Hintergrund, ob die Datei vollstaendig ist (Endmarke mit Seitenzahl). */
    async verifyComplete() {
      const end = await this.readRecord(this.pageCount + 1);
      let ok = end.length === END_MARKER.length + 4 && u32(end, END_MARKER.length) === this.pageCount;
      for (let i = 0; ok && i < END_MARKER.length; i++) ok = end[i] === END_MARKER[i];
      if (!ok) throw new CorruptError(BROKEN);
      return true;
    }

    close() {
      this.closed = true;
      this.encKey = this.macKey = null;
      this.offsets = [];
    }
  }

  /** Oeffnet eine .mvx-Datei. Wirft WrongPasswordError oder CorruptError. */
  async function open(file, password) {
    if (!file || file.size < HEADER_LEN) throw new CorruptError('Das ist keine Reader-Exportdatei (.mvx).');
    const header = await readSlice(file, 0, HEADER_LEN);
    for (let i = 0; i < 4; i++) if (header[i] !== MAGIC[i]) throw new CorruptError('Das ist keine Reader-Exportdatei (.mvx).');
    if (header[4] !== 1 || header[5] !== 0) throw new CorruptError('Diese Exportversion wird nicht unterstützt.');
    const iter = u32(header, 6);
    if (iter < MIN_ITER || iter > MAX_ITER) throw new CorruptError('Ungültige Schlüsselparameter.');
    const salt = header.slice(10, 42);

    const pwBytes = new TextEncoder().encode(password);
    let bits;
    try {
      const base = await crypto.subtle.importKey('raw', pwBytes, 'PBKDF2', false, ['deriveBits']);
      bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: iter }, base, 512));
    } finally { pwBytes.fill(0); }
    const encRaw = bits.slice(0, 32), macRaw = bits.slice(32, 64);
    bits.fill(0);
    const encKey = await crypto.subtle.importKey('raw', encRaw, { name: 'AES-CBC' }, false, ['decrypt']);
    const macKey = await crypto.subtle.importKey('raw', macRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    encRaw.fill(0); macRaw.fill(0);

    const v = new Vault(file, header, encKey, macKey);
    const manifestBytes = await v.readRecord(0);
    const m = parseManifest(manifestBytes);
    manifestBytes.fill(0);
    v.series = m.series;
    v.pageCount = m.pageCount;
    return v;
  }

  /** Erkennt das Bildformat anhand der ersten Bytes (fuer den Blob-Typ). */
  function imageType(b) {
    if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
    if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
    if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
      return 'image/heic';
    }
    if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4D && b[1] === 0x4D)) return 'image/tiff';
    return 'application/octet-stream';
  }

  return { open, imageType, WrongPasswordError, CorruptError };
})();
