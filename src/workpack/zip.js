/*
 * 不壓縮（stored）的 ZIP 讀寫，零相依。工作包（ssot-workpack/1）與之後 patch 的整批下載共用。
 * 只處理 Uint8Array：不碰 DOM、Blob 或檔案系統，也不讀目前時間（修改時間由呼叫端傳入，省略時用固定值）。
 *
 *   S.zip.write([{ path, bytes }], { mtime? }) → Uint8Array
 *   S.zip.read(bytes) → { entries: [{ path, bytes, crc32, mtime }], dirs: [path] }
 *
 * 格式依 PKWARE APPNOTE.TXT（https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT）：
 *   - 4.3.7 local file header、4.3.12 central directory、4.3.16 end of central directory（EOCD）
 *   - 4.4.4 general purpose bit flag：bit 0 加密、bit 3 data descriptor、bit 6 strong encryption、bit 11 檔名是 UTF-8、bit 13 加密的 central directory
 *   - 4.4.5 compression method：0 是 stored（不壓縮）
 *   - 4.4.6 MS-DOS 時間與日期（2 秒精度，沒有時區）
 *   - 4.4.7 CRC-32（多項式 0xEDB88320）
 * 不支援 ZIP64（超過 65535 個項目或 4 GiB），寫入時超過就丟錯，讀到 ZIP64 也明確拒絕。
 *
 * 寫入：每個項目 version needed 2.0、旗標只有 bit 11、method 0；MS-DOS 時間以 UTC 的年月日時分秒寫入（ZIP 沒有時區欄位）。
 *   version made by 為 2.0／MS-DOS（host 0），外部屬性 0：解壓工具會給一般檔案的預設權限。
 * 讀取：驗證全部結構，任何一項不符就丟出 Error（name 'ZipError'，errors 是全部問題 [{ code, path, message }]），不略過、不猜測：
 *   壓縮過的項目、加密的項目、不安全的路徑（含 .. 或以 / 開頭等，見 checkPath）、重複的檔名（大小寫不同也算，解壓到
 *   不分大小寫的檔案系統會互相覆蓋）、CRC 不符、大小或 offset 超出範圍、項目重疊、local header 與 central directory 不一致。
 *   目錄項目（以 / 結尾、大小 0）只列在 dirs，不是檔案。
 */
(function (S) {
  'use strict';
  const SIG = { LOCAL: 0x04034b50, CENTRAL: 0x02014b50, EOCD: 0x06054b50 };
  const FLAG = { ENCRYPTED: 0x0001, DESCRIPTOR: 0x0008, STRONG: 0x0040, UTF8: 0x0800, CD_ENCRYPTED: 0x2000 };
  const VERSION = 20; // 2.0：stored 與目錄所需的最低版本
  const MAX16 = 0xffff; const MAX32 = 0xffffffff;
  const FIXED_MTIME = '1980-01-01T00:00:00Z'; // MS-DOS 時間能表示的最早時間；呼叫端沒給時間時用它，結果才可重現
  /** 錯誤代碼（封閉列舉，畫面可依代碼說明） */
  const CODES = Object.freeze(['not-bytes', 'no-eocd', 'multi-disk', 'zip64', 'out-of-range', 'bad-central', 'bad-local',
    'local-mismatch', 'name-encoding', 'unsafe-path', 'duplicate', 'encrypted', 'compressed', 'size-mismatch', 'crc', 'overlap']);

  // ---------------------------------------------------------------- CRC-32
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('S.zip.crc32：需要 Uint8Array');
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------------------------------------------------------------- UTF-8（嚴格）
  // 寫入前先確認字串沒有落單的代理字元：TextEncoder 會把它換成 U+FFFD，讀回後內容就不同了（靜默改寫資料）。
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const isWellFormed = (s) => typeof s === 'string' && !LONE_SURROGATE.test(s);
  const utf8 = {
    /** 字串 → UTF-8 bytes；有落單的代理字元（無法以 UTF-8 表示）時丟出 TypeError */
    encode(s, what) {
      if (typeof s !== 'string') throw new TypeError(`${what || '文字'} 必須是字串`);
      if (!isWellFormed(s)) throw new TypeError(`${what || '文字'} 含有落單的 UTF-16 代理字元，無法以 UTF-8 保存`);
      return new TextEncoder().encode(s);
    },
    /** UTF-8 bytes → 字串；不合法的 UTF-8 丟出 TypeError。保留開頭的 BOM（U+FEFF），讀回的文字與寫入前完全相同 */
    decode(bytes, what) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError(`${what || '內容'} 必須是 Uint8Array`);
      try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (e) {
        throw new TypeError(`${what || '內容'} 不是合法的 UTF-8`);
      }
    },
    isWellFormed,
  };

  // ---------------------------------------------------------------- 路徑
  const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  /**
   * ZIP 內的路徑是否安全；安全時回傳 null，否則回傳原因（中文）。讀與寫用同一套規則：
   * 以 / 分隔的相對路徑；不可以空白、以 / 開頭、含 \、磁碟代號（C:）、控制字元、Windows 不允許的字元（< > : " | ? *），
   * 不可以有空的段落、. 或 .. 段落、以空白或 . 結尾的段落，或 Windows 保留名稱（CON、NUL、COM1…）。
   * dir 為 true 時允許（也要求）結尾的 /。
   */
  function checkPath(p, dir) {
    if (typeof p !== 'string' || !p) return '路徑是空的';
    if (!isWellFormed(p)) return '路徑含有落單的 UTF-16 代理字元';
    if (p.startsWith('/')) return '路徑以 / 開頭（絕對路徑）';
    if (p.includes('\\')) return '路徑含有 \\（ZIP 規定以 / 分隔）';
    if (/^[A-Za-z]:/.test(p)) return '路徑以磁碟代號開頭';
    if (/[\u0000-\u001f\u007f]/.test(p)) return '路徑含有控制字元';
    if (/[<>:"|?*]/.test(p)) return '路徑含有 Windows 不允許的字元（< > : " | ? *）';
    let body = p;
    if (dir) { if (!p.endsWith('/')) return '目錄路徑必須以 / 結尾'; body = p.slice(0, -1); } else if (p.endsWith('/')) return '檔案路徑不可以 / 結尾';
    for (const seg of body.split('/')) {
      if (!seg) return '路徑有空的段落（//）';
      if (seg === '.' || seg === '..') return '路徑含有 . 或 .. 段落';
      if (/[ .]$/.test(seg)) return `段落「${seg}」以空白或 . 結尾`;
      if (WIN_RESERVED.test(seg)) return `段落「${seg}」是 Windows 保留名稱`;
    }
    return null;
  }
  /**
   * 把任意名稱轉成一個安全的路徑段落（只保留 Unicode 字母、數字與 _ . -，其他換成 _；開頭的 . 換成 _；
   * 結尾的 . 換成 _；Windows 保留名稱前加 _；最長 120 個字元）。轉換後仍可能和其他名稱相同，由呼叫端處理。
   */
  function safeSegment(name) {
    let s = Array.from(String(name)).map((ch) => (/^[\p{L}\p{N}_.-]$/u.test(ch) ? ch : '_')).slice(0, 120).join('');
    s = s.replace(/^\./, '_').replace(/\.+$/, (m) => '_'.repeat(m.length));
    if (!s) s = '_';
    if (WIN_RESERVED.test(s)) s = '_' + s;
    return s;
  }

  // ---------------------------------------------------------------- MS-DOS 時間
  /** ISO 8601 → { time, date }（以 UTC 的年月日時分秒；秒數取偶數）。超出 1980–2107 時丟出 RangeError */
  function dosTime(iso) {
    const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms)) throw new TypeError(`S.zip.write：mtime 必須是 ISO 8601 時間字串，目前是 ${JSON.stringify(iso)}`);
    const d = new Date(ms); const y = d.getUTCFullYear();
    if (y < 1980 || y > 2107) throw new RangeError(`S.zip.write：mtime 必須在 1980 到 2107 年之間（ZIP 的 MS-DOS 時間），目前是 ${iso}`);
    return {
      time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
  }
  /** { time, date } → ISO（視為 UTC）；欄位不合法（例如月份 0）時為 null */
  function isoOfDos(time, date) {
    const y = 1980 + (date >>> 9); const mo = (date >>> 5) & 15; const day = date & 31;
    const h = time >>> 11; const mi = (time >>> 5) & 63; const s = (time & 31) * 2;
    if (mo < 1 || mo > 12 || day < 1 || h > 23 || mi > 59 || s > 59) return null;
    const ms = Date.UTC(y, mo - 1, day, h, mi, s); const d = new Date(ms);
    if (d.getUTCDate() !== day) return null; // 例如 2 月 30 日
    return d.toISOString().replace('.000Z', 'Z');
  }

  // ---------------------------------------------------------------- 寫入
  /**
   * entries：[{ path, bytes }]，依陣列順序寫入。opts：{ mtime?: ISO 8601 }，省略時用固定的 1980-01-01T00:00:00Z。
   * 路徑不安全或重複、bytes 不是 Uint8Array、項目過多或過大（需要 ZIP64）時丟錯。相同的 entries 與 mtime 一定得到相同的 bytes。
   */
  function write(entries, opts) {
    if (!Array.isArray(entries)) throw new TypeError('S.zip.write：entries 必須是 [{ path, bytes }] 陣列');
    const o = opts == null ? {} : opts;
    if (typeof o !== 'object' || Array.isArray(o)) throw new TypeError('S.zip.write：opts 必須是 { mtime }');
    const extra = Object.keys(o).filter((k) => k !== 'mtime');
    if (extra.length) throw new TypeError(`S.zip.write：opts 不認得的欄位 ${extra.join('、')}`);
    const { time, date } = dosTime(o.mtime == null ? FIXED_MTIME : o.mtime);
    if (entries.length > MAX16 - 1) throw new RangeError(`S.zip.write：項目太多（${entries.length}），超過不使用 ZIP64 的上限`);
    const seen = new Map();
    const rows = entries.map((e, i) => {
      if (!e || typeof e !== 'object') throw new TypeError(`S.zip.write：entries[${i}] 必須是 { path, bytes }`);
      const bad = Object.keys(e).filter((k) => k !== 'path' && k !== 'bytes');
      if (bad.length) throw new TypeError(`S.zip.write：entries[${i}] 不認得的欄位 ${bad.join('、')}`);
      const why = checkPath(e.path, false);
      if (why) throw new TypeError(`S.zip.write：entries[${i}] 的路徑 ${JSON.stringify(e.path)} 不安全：${why}`);
      const fold = e.path.toLowerCase();
      if (seen.has(fold)) throw new TypeError(`S.zip.write：路徑 ${JSON.stringify(e.path)} 與 ${JSON.stringify(seen.get(fold))} 重複（不分大小寫）`);
      seen.set(fold, e.path);
      if (!(e.bytes instanceof Uint8Array)) throw new TypeError(`S.zip.write：${e.path} 的 bytes 必須是 Uint8Array`);
      const name = utf8.encode(e.path, '路徑');
      if (name.length > MAX16) throw new RangeError(`S.zip.write：路徑太長：${e.path}`);
      if (e.bytes.length >= MAX32) throw new RangeError(`S.zip.write：${e.path} 太大，超過不使用 ZIP64 的上限`);
      return { name, bytes: e.bytes, crc: crc32(e.bytes) };
    });
    let size = 22; rows.forEach((r) => { size += 30 + r.name.length + r.bytes.length + 46 + r.name.length; });
    if (size >= MAX32) throw new RangeError('S.zip.write：總大小超過不使用 ZIP64 的上限（4 GiB）');
    const out = new Uint8Array(size); const dv = new DataView(out.buffer);
    let p = 0;
    const u16 = (v) => { dv.setUint16(p, v, true); p += 2; }; const u32 = (v) => { dv.setUint32(p, v >>> 0, true); p += 4; };
    const put = (b) => { out.set(b, p); p += b.length; };
    rows.forEach((r) => {
      r.offset = p;
      u32(SIG.LOCAL); u16(VERSION); u16(FLAG.UTF8); u16(0); u16(time); u16(date);
      u32(r.crc); u32(r.bytes.length); u32(r.bytes.length); u16(r.name.length); u16(0);
      put(r.name); put(r.bytes);
    });
    const cd = p;
    rows.forEach((r) => {
      u32(SIG.CENTRAL); u16(VERSION); u16(VERSION); u16(FLAG.UTF8); u16(0); u16(time); u16(date);
      u32(r.crc); u32(r.bytes.length); u32(r.bytes.length); u16(r.name.length); u16(0); u16(0);
      u16(0); u16(0); u32(0); u32(r.offset); put(r.name);
    });
    const cdSize = p - cd;
    u32(SIG.EOCD); u16(0); u16(0); u16(rows.length); u16(rows.length); u32(cdSize); u32(cd); u16(0);
    return out;
  }

  // ---------------------------------------------------------------- 讀取
  function zipError(errors) {
    const head = errors.slice(0, 5).map((e) => (e.path ? `${e.path}：` : '') + e.message).join('；');
    const err = new Error(`ZIP 格式錯誤（${errors.length} 項）：${head}${errors.length > 5 ? '…' : ''}`);
    err.name = 'ZipError'; err.errors = errors;
    return err;
  }
  const fatal = (code, message) => zipError([{ code, path: null, message }]);

  /**
   * bytes（Uint8Array）→ { entries: [{ path, bytes, crc32, mtime }], dirs: [path] }，依 central directory 的順序。
   * entries[].bytes 是複本，不和輸入共用記憶體；mtime 是項目的 MS-DOS 時間（視為 UTC 的 ISO 字串，不合法時為 null）。
   * 結構無法解析時立即丟錯；逐項的問題全部列出後一起丟錯（ZipError，errors 是全部問題）。
   */
  function read(bytes) {
    if (!(bytes instanceof Uint8Array)) throw fatal('not-bytes', '需要 Uint8Array');
    const n = bytes.length; const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o) => dv.getUint16(o, true); const u32 = (o) => dv.getUint32(o, true);
    // EOCD：從尾端往前找簽章，而且註解長度要剛好到檔案結尾（避免把註解裡的簽章當成 EOCD）
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 22 - MAX16); i--) {
      if (u32(i) === SIG.EOCD && i + 22 + u16(i + 20) === n) { eocd = i; break; }
    }
    if (eocd < 0) throw fatal('no-eocd', '找不到 ZIP 的結尾紀錄（end of central directory），不是 ZIP 檔或檔案不完整');
    const disk = u16(eocd + 4); const cdDisk = u16(eocd + 6); const onDisk = u16(eocd + 8); const total = u16(eocd + 10);
    const cdSize = u32(eocd + 12); const cdOff = u32(eocd + 16);
    if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw fatal('multi-disk', '不支援分割成多個檔案的 ZIP');
    if (total === MAX16 || cdSize === MAX32 || cdOff === MAX32) throw fatal('zip64', '不支援 ZIP64');
    if (cdOff + cdSize !== eocd) throw fatal('out-of-range', `central directory 的位置（${cdOff}＋${cdSize}）和結尾紀錄的位置（${eocd}）對不上`);

    const errors = []; const add = (code, path, message) => errors.push({ code, path, message });
    const cds = []; let p = cdOff;
    for (let k = 0; k < total; k++) {
      if (p + 46 > eocd || u32(p) !== SIG.CENTRAL) throw fatal('bad-central', `central directory 的第 ${k + 1} 筆格式錯誤`);
      const nl = u16(p + 28); const xl = u16(p + 30); const cl = u16(p + 32);
      const end = p + 46 + nl + xl + cl;
      if (end > eocd) throw fatal('out-of-range', `central directory 的第 ${k + 1} 筆超出範圍`);
      cds.push({ flags: u16(p + 8), method: u16(p + 10), time: u16(p + 12), date: u16(p + 14), crc: u32(p + 16),
        csize: u32(p + 20), usize: u32(p + 24), diskStart: u16(p + 34), offset: u32(p + 42), nameBytes: bytes.subarray(p + 46, p + 46 + nl) });
      p = end;
    }
    if (p !== eocd) throw fatal('bad-central', `central directory 的筆數（${total}）和大小（${cdSize} bytes）對不上`);

    const entries = []; const dirs = []; const seen = new Map(); const ranges = [];
    cds.forEach((c, k) => {
      let path;
      if (c.flags & FLAG.UTF8) {
        try { path = utf8.decode(c.nameBytes); } catch (e) { add('name-encoding', null, `第 ${k + 1} 個項目的檔名標示為 UTF-8，但不是合法的 UTF-8`); return; }
      } else if (c.nameBytes.every((b) => b < 0x80)) path = String.fromCharCode(...c.nameBytes);
      else { add('name-encoding', null, `第 ${k + 1} 個項目的檔名不是 UTF-8（沒有設定 bit 11），無法確定編碼`); return; }
      const isDir = path.endsWith('/');
      const why = checkPath(path, isDir);
      if (why) { add('unsafe-path', path, `路徑不安全：${why}`); return; }
      const fold = path.toLowerCase();
      if (seen.has(fold)) { add('duplicate', path, `檔名重複${seen.get(fold) === path ? '' : `（與 ${seen.get(fold)} 只差大小寫）`}`); return; }
      seen.set(fold, path);
      if (c.flags & (FLAG.ENCRYPTED | FLAG.STRONG | FLAG.CD_ENCRYPTED)) { add('encrypted', path, '項目有加密，不支援'); return; }
      if (c.method !== 0) { add('compressed', path, `項目是壓縮過的（method ${c.method}），只支援不壓縮（stored）`); return; }
      if (c.csize !== c.usize) { add('size-mismatch', path, `不壓縮的項目，壓縮前後大小不同（${c.csize}／${c.usize}）`); return; }
      if (c.diskStart !== 0) { add('multi-disk', path, '項目在另一個分割檔'); return; }
      if (c.offset + 30 > cdOff || u32(c.offset) !== SIG.LOCAL) { add(c.offset + 30 > cdOff ? 'out-of-range' : 'bad-local', path, `local header 的位置（${c.offset}）不正確`); return; }
      const lflags = u16(c.offset + 6); const lnl = u16(c.offset + 26); const lxl = u16(c.offset + 28);
      const start = c.offset + 30 + lnl + lxl; const end = start + c.csize;
      if (end > cdOff) { add('out-of-range', path, `資料超出範圍（${start}＋${c.csize} 超過 central directory 的位置 ${cdOff}）`); return; }
      const lname = bytes.subarray(c.offset + 30, c.offset + 30 + lnl);
      if (lnl !== c.nameBytes.length || lname.some((b, i) => b !== c.nameBytes[i])) { add('local-mismatch', path, 'local header 的檔名和 central directory 不同'); return; }
      if (u16(c.offset + 8) !== c.method) { add('local-mismatch', path, 'local header 的壓縮方式和 central directory 不同'); return; }
      if (!(lflags & FLAG.DESCRIPTOR) && (u32(c.offset + 14) !== c.crc || u32(c.offset + 18) !== c.csize || u32(c.offset + 22) !== c.usize)) {
        add('local-mismatch', path, 'local header 的 CRC 或大小和 central directory 不同'); return;
      }
      ranges.push({ start: c.offset, end, path });
      const data = bytes.slice(start, end);
      if (isDir) {
        if (data.length) { add('size-mismatch', path, '目錄項目不可以有內容'); return; }
        dirs.push(path); return;
      }
      if (crc32(data) !== c.crc) { add('crc', path, 'CRC-32 不符，內容損毀或被修改'); return; }
      entries.push({ path, bytes: data, crc32: c.crc, mtime: isoOfDos(c.time, c.date) });
    });
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start < ranges[i - 1].end) add('overlap', ranges[i].path, `和 ${ranges[i - 1].path} 的資料範圍重疊`);
    }
    if (errors.length) throw zipError(errors);
    return { entries, dirs };
  }

  S.zip = { write, read, crc32, utf8, checkPath, safeSegment, CODES, FIXED_MTIME };
})(globalThis.SSOT = globalThis.SSOT || {});
