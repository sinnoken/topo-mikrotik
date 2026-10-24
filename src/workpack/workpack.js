/*
 * 工作包（ssot-workpack/1）：用一個不壓縮的 ZIP 帶走、帶回一整輪的資料。
 * 只產生與讀取 bytes：不碰 DOM、Blob、IndexedDB，不讀目前時間（now 由呼叫端傳入），不修改傳入的物件。
 * 核心不讀 store：要放進工作包的內容（parts）由畫面提供。
 *
 *   S.workpack.build(parts, { now }) → Uint8Array
 *   S.workpack.read(bytes) → pack（{ manifest, files, sources, snapshot, ledger, profile, expectedData, expected, warnings }）
 *   S.workpack.validate(pack, { now, profile, expectedData }) → { ok, errors, warnings, snapshot }（以收集檔重建基準並核對）
 *
 * ZIP 的內容：
 *   manifest.json                   清單（第一個項目）
 *   sources/<名稱>                  收集檔（原始輸入，一個以上；順序就是 S.build 的順序，決定 inputHash）
 *   baseline/<名稱>                 基準（Snapshot JSON，恰好一份）
 *   ledger/<名稱>                   處理紀錄（ssot-ledger/1，最多一份）
 *   profile/<名稱>                  命名規則（ssot-profile，最多一份）
 *   build/<名稱>                    S.build 的 expectedData 選項（各類設備應有的資料，最多一份）
 *   expected/<名稱>                 預期資料（ssot-expected/1，S.compare 用，最多一份）
 *   reports/<名稱>、patches/<名稱>  報表（CSV、Markdown…）與修正 patch（.rsc…），任意份數，不解讀內容
 *
 * manifest（見 docs 的工作包 ADR）：
 *   { schema: 'ssot-workpack/1', toolVersion, createdAt, inputHash, baselineKey,
 *     baseline: { schema, version, createdAt, profile },
 *     files: [{ role, path, name, bytes, sha256 }] }
 *   name 是畫面提供的原始名稱（收集檔的 name 就是 S.build 的來源名稱）；path 是 ZIP 內的安全路徑（S.zip.safeSegment）。
 *
 * 版本（ADR-010）：工作包內有處理紀錄、命名規則與預期資料，無法從輸入重新產生，屬於「使用者長期保存的格式」：
 *   讀舊版、寫新版。目前只有 /1；讀到更新的 major 時明確拒絕。相容修改只新增選用欄位，讀取時保留不認得的欄位；
 *   不認得的角色列為警告、檔案仍驗證並保留在 files。
 */
(function (S) {
  'use strict';
  const U = S.util;
  const SCHEMA = 'ssot-workpack/1';
  const MAJOR = 1;
  const MANIFEST = 'manifest.json';
  /**
   * 角色（封閉列舉，依此順序排列檔案）。dir：ZIP 內的目錄；min／max：份數；
   * kind：text（UTF-8 文字）、json（UTF-8 JSON，讀回時解析）、bytes（不解讀）。
   */
  const ROLES = Object.freeze({
    source: { dir: 'sources', min: 1, max: Infinity, kind: 'text', label: '收集檔' },
    snapshot: { dir: 'baseline', min: 1, max: 1, kind: 'json', label: '基準' },
    ledger: { dir: 'ledger', min: 0, max: 1, kind: 'json', label: '處理紀錄' },
    profile: { dir: 'profile', min: 0, max: 1, kind: 'json', label: '命名規則' },
    'expected-data': { dir: 'build', min: 0, max: 1, kind: 'json', label: '建立選項 expectedData' },
    expected: { dir: 'expected', min: 0, max: 1, kind: 'json', label: '預期資料（ssot-expected/1）' },
    report: { dir: 'reports', min: 0, max: Infinity, kind: 'bytes', label: '報表' },
    patch: { dir: 'patches', min: 0, max: Infinity, kind: 'bytes', label: '修正 patch' },
  });
  const ROLE_ORDER = Object.keys(ROLES);
  /** 錯誤與警告代碼（封閉列舉）。ZIP 本身的錯誤沿用 S.zip.CODES */
  const ERRORS = Object.freeze(['no-manifest', 'manifest', 'schema', 'schema-newer', 'missing-file', 'size', 'hash', 'duplicate-path',
    'count', 'encoding', 'json', 'snapshot', 'baseline-mismatch', 'source-mismatch', 'ledger', 'ledger-baseline', 'profile', 'profile-mismatch',
    'expected', 'expected-data', 'rebuild', 'input-hash', 'baseline-key']);
  const WARNINGS = Object.freeze(['unknown-role', 'unlisted-file', 'tool-version', 'snapshot-schema', 'snapshot-sources', 'ledger-newer', 'baseline-key']);

  // ---------------------------------------------------------------- SHA-256（FIPS 180-4），用於 manifest 的檔案雜湊
  // 不用 S.util.hash（FNV，針對字串的輸入指紋）：檔案雜湊要對 bytes 計算，而且使用者可以用 sha256sum 等一般工具核對。
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('S.workpack.sha256：需要 Uint8Array');
    const len = bytes.length; const total = Math.ceil((len + 9) / 64) * 64;
    const buf = new Uint8Array(total); buf.set(bytes); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000), false); dv.setUint32(total - 4, (len * 8) >>> 0, false);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
      for (let t = 0; t < 16; t++) W[t] = dv.getUint32(off + t * 4, false);
      for (let t = 16; t < 64; t++) {
        const a = W[t - 15]; const b = W[t - 2];
        W[t] = (W[t - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[t - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let t = 0; t < 64; t++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + W[t]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, (x) => x.toString(16).padStart(8, '0')).join('');
  }

  // ---------------------------------------------------------------- 共用
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
  const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
  const nowOf = (v, fn) => {
    if (!isIso(v)) throw new TypeError(`S.workpack.${fn}：now 必須是 ISO 8601 時間字串（例如 2026-01-01T00:00:00Z），目前是 ${JSON.stringify(v)}`);
    return new Date(Date.parse(v)).toISOString();
  };
  const minorOf = (v) => String(v || '').split('.').slice(0, 2).join('.');
  const optsOf = (opts, keys, fn, required) => {
    if (!isObj(opts)) throw new TypeError(`S.workpack.${fn}：第二個參數必須是 { ${keys.join(', ')} }`);
    const extra = Object.keys(opts).filter((k) => !keys.includes(k));
    if (extra.length) throw new TypeError(`S.workpack.${fn}：不認得的欄位 ${extra.join('、')}`);
    const missing = (required || []).filter((k) => !(k in opts));
    if (missing.length) throw new TypeError(`S.workpack.${fn}：必須明確指定 ${missing.join('、')}（不使用時傳 null）`);
    return opts;
  };
  function packError(what, errors, warnings) {
    const head = errors.slice(0, 5).map((e) => (e.path ? `${e.path}：` : '') + e.message).join('；');
    const err = new Error(`${what}（${errors.length} 項）：${head}${errors.length > 5 ? '…' : ''}`);
    err.name = 'WorkpackError'; err.errors = errors; err.warnings = warnings || [];
    return err;
  }

  /** ZIP 內的路徑：<角色目錄>/<安全名稱>；名稱經過替換時加上原名雜湊的前 8 碼，重複時再加序號的雜湊 */
  function pathsOf(rows) {
    const used = new Set();
    return rows.map((r, i) => {
      const dir = ROLES[r.role].dir;
      const seg = S.zip.safeSegment(r.name);
      const dot = seg.lastIndexOf('.');
      const stem = dot > 0 && seg.length - dot <= 11 ? seg.slice(0, dot) : seg; const ext = stem === seg ? '' : seg.slice(dot);
      const cands = [seg === r.name ? seg : `${stem}-${U.hash(r.name).slice(0, 8)}${ext}`, `${stem}-${U.hash(r.role + '\n' + r.name + '\n' + i).slice(0, 8)}${ext}`];
      const p = cands.map((c) => `${dir}/${c}`).find((c) => !used.has(c.toLowerCase()));
      if (!p) throw new Error(`S.workpack.build：無法為 ${JSON.stringify(r.name)} 產生不重複的路徑`);
      used.add(p.toLowerCase());
      return p;
    });
  }

  /**
   * 各角色的內容互相核對（build 與 read 共用）。c：{ sources, snapshot, ledger, profile, expectedData, expected, has }，
   * has 是各角色是否存在。回傳 { errors, warnings }，每筆 { code, path, message }。
   */
  function consistency(c, paths) {
    const errors = []; const warnings = [];
    const E = (code, path, message) => errors.push({ code, path: path || null, message });
    const W = (code, path, message) => warnings.push({ code, path: path || null, message });
    const snap = c.snapshot;
    if (!isObj(snap) || !isObj(snap.meta) || typeof snap.meta.inputHash !== 'string' || !snap.meta.inputHash) {
      E('snapshot', paths.snapshot, '基準不是 Snapshot（沒有 meta.inputHash）'); return { errors, warnings };
    }
    const meta = snap.meta;
    if (meta.baselineKey != null && (typeof meta.baselineKey !== 'string' || !meta.baselineKey)) E('snapshot', paths.snapshot, '基準的 meta.baselineKey 必須是非空字串');
    if (meta.schema !== S.SCHEMA) W('snapshot-schema', paths.snapshot, `基準的 schema 是 ${meta.schema || '未標示'}，本工具是 ${S.SCHEMA}；請用收集檔重新建立（validate 會重建）`);
    // 收集檔和基準的 meta.sources 逐一核對名稱、長度與雜湊（順序決定 inputHash）
    if (Array.isArray(meta.sources)) {
      if (meta.sources.length !== c.sources.length) E('source-mismatch', null, `收集檔有 ${c.sources.length} 份，基準記錄的來源有 ${meta.sources.length} 份`);
      else {
        c.sources.forEach((s, i) => {
          const m = meta.sources[i] || {};
          if (m.name !== s.name || m.bytes !== s.text.length || m.hash !== U.hash(s.text)) {
            E('source-mismatch', paths.sources[i], `第 ${i + 1} 份收集檔「${s.name}」和基準記錄的來源「${m.name}」不同（名稱、長度或內容）`);
          }
        });
      }
    } else W('snapshot-sources', paths.snapshot, '基準沒有 meta.sources，無法逐一核對收集檔；用 validate 重建後核對 inputHash');
    // 命名規則：基準用過命名規則時一定要附上，而且 id 與版本相同
    let profile = null;
    if (c.has.profile) {
      try { profile = S.profile.compile(c.profile); } catch (e) { E('profile', paths.profile, e.message); }
      if (!profile && !errors.some((e) => e.code === 'profile')) E('profile', paths.profile, '命名規則是空的');
    }
    const mp = meta.profile || null;
    if (mp && !c.has.profile) E('profile-mismatch', null, `基準使用了命名規則 ${mp.id}（版本 ${mp.version}），工作包沒有附上；重建時無法得到同一份基準`);
    else if (!mp && c.has.profile && profile) E('profile-mismatch', paths.profile, `基準沒有使用命名規則，工作包卻附上了 ${profile.id}`);
    else if (mp && profile && (mp.id !== profile.id || mp.version !== profile.version)) {
      E('profile-mismatch', paths.profile, `命名規則是 ${profile.id}（版本 ${profile.version}），基準使用的是 ${mp.id}（版本 ${mp.version}）`);
    }
    if (c.has['expected-data']) {
      const d = c.expectedData;
      if (!isObj(d) || Object.values(d).some((v) => !Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
        E('expected-data', paths['expected-data'], 'expectedData 必須是 { 設備類型: [資料類別…] }');
      }
    }
    if (c.has.expected && (!isObj(c.expected) || c.expected.schema !== 'ssot-expected/1')) {
      E('expected', paths.expected, `預期資料的 schema 必須是 "ssot-expected/1"，目前是 ${JSON.stringify(isObj(c.expected) ? c.expected.schema : c.expected)}`);
    }
    // 處理紀錄：格式正確，而且推進過這份基準（同一輪）。推進過、但之後又推進了其他基準（例如重新載入舊基準）時是警告
    if (c.has.ledger) {
      const v = S.ledger.validate(c.ledger);
      if (!v.ok) v.errors.forEach((m) => E('ledger', paths.ledger, m));
      else {
        const i = S.ledger.roundOf(c.ledger, meta);
        const n = c.ledger.iterations.length;
        if (i < 0) E('ledger-baseline', paths.ledger, `處理紀錄沒有推進過這份基準（基準鍵 ${meta.baselineKey || meta.inputHash}），兩者不是同一輪`);
        else if (i !== n - 1) W('ledger-newer', paths.ledger, `處理紀錄推進過這份基準（第 ${i + 1} 輪），之後又推進了 ${n - 1 - i} 輪其他基準`);
      }
    }
    return { errors, warnings };
  }

  // ---------------------------------------------------------------- 建立
  const PART_KEYS = ['role', 'name', 'text', 'bytes'];
  /**
   * parts：[{ role, name, text } 或 { role, name, bytes }]（text 是字串、bytes 是 Uint8Array，兩者恰好一個）。
   *   role 是 ROLES 的鍵；name 是非空字串（收集檔的 name 就是 S.build 的來源名稱，報表與 patch 是下載的檔名）。
   * opts：{ now }，ISO 8601；寫進 manifest 的 createdAt 與 ZIP 的修改時間。相同的 parts 與 now 一定得到相同的 bytes。
   * 參數形狀不對丟出 TypeError；內容的問題（份數、格式、基準與收集檔或處理紀錄不是同一輪…）全部列出後丟出
   * WorkpackError（errors、warnings 同 read）。build 不回傳警告，需要時以 read 讀回成品取得。
   */
  function build(parts, opts) {
    const now = nowOf(optsOf(opts, ['now'], 'build', ['now']).now, 'build');
    if (!Array.isArray(parts)) throw new TypeError('S.workpack.build：parts 必須是陣列');
    const rows = parts.map((p, i) => {
      const at = `S.workpack.build：parts[${i}]`;
      if (!isObj(p)) throw new TypeError(`${at} 必須是 { role, name, text | bytes }`);
      const extra = Object.keys(p).filter((k) => !PART_KEYS.includes(k));
      if (extra.length) throw new TypeError(`${at} 不認得的欄位 ${extra.join('、')}`);
      if (!Object.prototype.hasOwnProperty.call(ROLES, p.role)) throw new TypeError(`${at}.role 必須是 ${ROLE_ORDER.join('、')}，目前是 ${JSON.stringify(p.role)}`);
      if (typeof p.name !== 'string' || !p.name || !S.zip.utf8.isWellFormed(p.name)) throw new TypeError(`${at}.name 必須是非空字串`);
      if (('text' in p) === ('bytes' in p)) throw new TypeError(`${at} 必須恰好有 text 或 bytes 其中一個`);
      if ('text' in p && typeof p.text !== 'string') throw new TypeError(`${at}.text 必須是字串`);
      if ('bytes' in p && !(p.bytes instanceof Uint8Array)) throw new TypeError(`${at}.bytes 必須是 Uint8Array`);
      const bytes = 'text' in p ? S.zip.utf8.encode(p.text, `${at}.text`) : p.bytes.slice();
      return { i, role: p.role, name: p.name, bytes };
    });
    // 依角色排序（同角色保留呼叫端的順序：收集檔的順序決定 inputHash）
    rows.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.i - b.i);
    const paths = pathsOf(rows); rows.forEach((r, k) => { r.path = paths[k]; });
    const { content, errors } = interpret(rows);
    const chk = errors.length ? { errors: [], warnings: [] } : consistency(content, content.paths);
    const all = errors.concat(chk.errors);
    if (all.length) throw packError('無法建立工作包', all, chk.warnings);
    const meta = content.snapshot.meta;
    const manifest = {
      schema: SCHEMA, toolVersion: S.VERSION, createdAt: now,
      inputHash: meta.inputHash, baselineKey: meta.baselineKey == null ? null : meta.baselineKey,
      baseline: { schema: meta.schema || null, version: meta.version || null, createdAt: meta.createdAt || null, profile: meta.profile || null },
      files: rows.map((r) => ({ role: r.role, path: r.path, name: r.name, bytes: r.bytes.length, sha256: sha256(r.bytes) })),
    };
    const entries = [{ path: MANIFEST, bytes: S.zip.utf8.encode(JSON.stringify(manifest, null, 2) + '\n') }]
      .concat(rows.map((r) => ({ path: r.path, bytes: r.bytes })));
    return S.zip.write(entries, { mtime: now });
  }

  /**
   * 依角色解讀檔案（build 與 read 共用）：份數、UTF-8 與 JSON。rows：[{ role, path, name, bytes }]，不認得的角色不解讀。
   * 回傳 { content: { sources, snapshot, …, has, paths }, errors }。
   */
  function interpret(rows) {
    const errors = []; const E = (code, path, message) => errors.push({ code, path: path || null, message });
    const content = { sources: [], snapshot: null, ledger: null, profile: null, expectedData: null, expected: null, has: {}, paths: { sources: [] } };
    const FIELD = { snapshot: 'snapshot', ledger: 'ledger', profile: 'profile', 'expected-data': 'expectedData', expected: 'expected' };
    ROLE_ORDER.forEach((role) => {
      const mine = rows.filter((r) => r.role === role); const R = ROLES[role];
      content.has[role] = mine.length > 0;
      if (mine.length < R.min || mine.length > R.max) {
        E('count', null, `${R.label}（${role}）要有 ${R.max === Infinity ? `至少 ${R.min} 份` : R.min === R.max ? `恰好 ${R.min} 份` : `最多 ${R.max} 份`}，目前有 ${mine.length} 份`);
      }
      mine.forEach((r) => {
        if (R.kind === 'bytes') return;
        let text;
        try { text = S.zip.utf8.decode(r.bytes, r.path); } catch (e) { E('encoding', r.path, `${R.label}不是合法的 UTF-8`); return; }
        if (role === 'source') { content.sources.push({ name: r.name, text }); content.paths.sources.push(r.path); return; }
        let v;
        try { v = JSON.parse(text); } catch (e) { E('json', r.path, `${R.label}不是合法的 JSON：${e.message}`); return; }
        if (content[FIELD[role]] === null) { content[FIELD[role]] = v; content.paths[role] = r.path; }
      });
    });
    return { content, errors };
  }

  // ---------------------------------------------------------------- 讀取
  /**
   * bytes（Uint8Array）→ pack：
   *   { manifest（原樣，保留不認得的欄位）, files: [{ role, path, name, bytes }]（manifest 的順序，已驗證大小與 SHA-256）,
   *     sources: [{ name, text }]（S.build 可直接使用）, snapshot, ledger, profile, expectedData, expected（解析後的 JSON，沒有時為 null）,
   *     warnings: [{ code, path, message }] }
   * ZIP 結構錯誤丟出 ZipError（見 S.zip.read）；其他問題全部列出後丟出 WorkpackError（errors、warnings），不略過、不猜測。
   * 報表與 patch 只在 files 中（bytes，不解讀）。
   */
  function read(bytes) {
    const zip = S.zip.read(bytes);
    const byPath = new Map(zip.entries.map((e) => [e.path, e]));
    const errors = []; const warnings = [];
    const E = (code, path, message) => errors.push({ code, path: path || null, message });
    const W = (code, path, message) => warnings.push({ code, path: path || null, message });
    const fail = () => packError('工作包格式錯誤', errors, warnings);
    const me = byPath.get(MANIFEST);
    if (!me) { E('no-manifest', null, `找不到 ${MANIFEST}，不是工作包`); throw fail(); }
    let manifest;
    try { manifest = JSON.parse(S.zip.utf8.decode(me.bytes, MANIFEST)); } catch (e) { E('manifest', MANIFEST, `${MANIFEST} 不是合法的 UTF-8 JSON：${e.message}`); throw fail(); }
    if (!isObj(manifest)) { E('manifest', MANIFEST, 'manifest 必須是物件'); throw fail(); }
    const m = /^ssot-workpack\/(\d+)$/.exec(typeof manifest.schema === 'string' ? manifest.schema : '');
    if (!m) { E('schema', MANIFEST, `schema 必須是 ssot-workpack/<版本>，目前是 ${JSON.stringify(manifest.schema)}`); throw fail(); }
    if (Number(m[1]) > MAJOR) { E('schema-newer', MANIFEST, `這是較新版本的工作包（${manifest.schema}），本工具只能讀 ${SCHEMA}；請用新版工具開啟`); throw fail(); }
    if (Number(m[1]) !== MAJOR) { E('schema', MANIFEST, `不認得的工作包版本 ${manifest.schema}`); throw fail(); }
    // manifest 的欄位
    if (typeof manifest.toolVersion !== 'string' || !manifest.toolVersion) E('manifest', MANIFEST, 'toolVersion 必須是非空字串');
    if (!isIso(manifest.createdAt)) E('manifest', MANIFEST, `createdAt 必須是 ISO 8601 時間，目前是 ${JSON.stringify(manifest.createdAt)}`);
    if (typeof manifest.inputHash !== 'string' || !manifest.inputHash) E('manifest', MANIFEST, 'inputHash 必須是非空字串');
    if (manifest.baselineKey !== null && (typeof manifest.baselineKey !== 'string' || !manifest.baselineKey)) E('manifest', MANIFEST, 'baselineKey 必須是非空字串或 null');
    if (!isObj(manifest.baseline)) E('manifest', MANIFEST, 'baseline 必須是物件');
    if (!Array.isArray(manifest.files)) { E('manifest', MANIFEST, 'files 必須是陣列'); throw fail(); }
    // 每個檔案：欄位、路徑、存在、大小與 SHA-256
    const rows = []; const listed = new Set([MANIFEST]);
    manifest.files.forEach((f, i) => {
      const at = `files[${i}]`;
      if (!isObj(f)) { E('manifest', MANIFEST, `${at} 必須是物件`); return; }
      const bad = [];
      if (typeof f.role !== 'string' || !f.role) bad.push('role 必須是非空字串');
      if (typeof f.name !== 'string' || !f.name) bad.push('name 必須是非空字串');
      if (!Number.isInteger(f.bytes) || f.bytes < 0) bad.push('bytes 必須是非負整數');
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) bad.push('sha256 必須是 64 位小寫十六進位');
      const why = S.zip.checkPath(f.path, false);
      if (why) bad.push(`path 不安全：${why}`);
      if (bad.length) { bad.forEach((b) => E('manifest', MANIFEST, `${at}.${b}`)); return; }
      if (listed.has(f.path)) { E('duplicate-path', f.path, `manifest 重複列出 ${f.path}`); return; }
      listed.add(f.path);
      const e = byPath.get(f.path);
      if (!e) { E('missing-file', f.path, 'manifest 列出的檔案不在 ZIP 中'); return; }
      if (e.bytes.length !== f.bytes) { E('size', f.path, `大小是 ${e.bytes.length} bytes，manifest 記錄的是 ${f.bytes}`); return; }
      if (sha256(e.bytes) !== f.sha256) { E('hash', f.path, 'SHA-256 和 manifest 記錄的不同，內容被修改過'); return; }
      if (!Object.prototype.hasOwnProperty.call(ROLES, f.role)) W('unknown-role', f.path, `不認得的角色 ${JSON.stringify(f.role)}（可能是較新版本寫入的），保留但不解讀`);
      rows.push({ role: f.role, path: f.path, name: f.name, bytes: e.bytes });
    });
    zip.entries.filter((e) => !listed.has(e.path)).forEach((e) => W('unlisted-file', e.path, 'ZIP 中有 manifest 沒有列出的檔案，沒有讀入'));
    if (errors.length) throw fail();

    const { content, errors: ie } = interpret(rows.filter((r) => ROLES[r.role]));
    ie.forEach((x) => errors.push(x));
    if (errors.length) throw fail();
    const chk = consistency(content, content.paths);
    chk.errors.forEach((x) => errors.push(x)); chk.warnings.forEach((x) => warnings.push(x));
    const meta = errors.length ? null : content.snapshot.meta;
    if (meta) {
      if (meta.inputHash !== manifest.inputHash) E('baseline-mismatch', content.paths.snapshot, `基準的 inputHash（${meta.inputHash}）和 manifest（${manifest.inputHash}）不同`);
      const bk = meta.baselineKey == null ? null : meta.baselineKey;
      if (bk !== manifest.baselineKey) E('baseline-mismatch', content.paths.snapshot, `基準的 baselineKey（${bk}）和 manifest（${manifest.baselineKey}）不同`);
    }
    if (manifest.toolVersion !== S.VERSION) W('tool-version', MANIFEST, `工作包由 ${manifest.toolVersion} 版建立，目前是 ${S.VERSION} 版`);
    if (errors.length) throw fail();
    return {
      manifest, files: rows, sources: content.sources, snapshot: content.snapshot, ledger: content.ledger,
      profile: content.profile, expectedData: content.expectedData, expected: content.expected, warnings,
    };
  }

  // ---------------------------------------------------------------- 重建並核對
  /**
   * 以工作包的收集檔重新 S.build，核對結果是否和 manifest 是同一份基準。
   * opts：{ now, profile, expectedData }，三者都要明確給（profile、expectedData 不使用時傳 null）；用哪一份由呼叫端決定，
   *   通常是 pack.profile 與 pack.expectedData（畫面也可以換成使用者目前的命名規則）。
   * 回傳 { ok, errors, warnings, snapshot }：snapshot 是重建的基準（重建失敗時為 null），呼叫端可直接使用，不必再建一次。
   *   - inputHash 不同 → error（input-hash）：inputHash 只由收集檔的名稱與內容決定，收集檔已通過 SHA-256 驗證，
   *     不同表示 manifest 與基準不屬於這些收集檔，不能當成同一輪帶回。
   *   - baselineKey 不同 → 程式的 major.minor、命名規則或 expectedData 和建立時不同時是 warning（baseline-key，說明哪一項不同；
   *     處理紀錄會把它當成新的一輪，這是預期的行為）；三者都相同卻不同時是 error（baseline-key），工作包的內容自相矛盾。
   */
  function validate(pack, opts) {
    const o = optsOf(opts, ['now', 'profile', 'expectedData'], 'validate', ['now', 'profile', 'expectedData']);
    nowOf(o.now, 'validate'); const now = o.now; // 原樣交給 S.build，和直接呼叫 S.build 得到相同的 createdAt
    if (!isObj(pack) || !isObj(pack.manifest) || !Array.isArray(pack.sources)) throw new TypeError('S.workpack.validate：pack 必須是 S.workpack.read 的結果');
    const errors = []; const warnings = [];
    let snap = null;
    try { snap = S.build(pack.sources.map((s) => ({ name: s.name, text: s.text })), { profile: o.profile, expectedData: o.expectedData, now }); } catch (e) {
      errors.push({ code: 'rebuild', path: null, message: `以收集檔重建基準失敗：${e.message}` });
      return { ok: false, errors, warnings, snapshot: null };
    }
    const mf = pack.manifest; const meta = snap.meta;
    if (meta.inputHash !== mf.inputHash) {
      errors.push({ code: 'input-hash', path: null, message: `收集檔重建的 inputHash（${meta.inputHash}）和工作包（${mf.inputHash}）不同，基準與處理紀錄不屬於這些收集檔` });
    } else if (meta.baselineKey !== mf.baselineKey) {
      const why = [];
      const was = mf.baseline && mf.baseline.version;
      if (minorOf(was) !== minorOf(S.VERSION)) why.push(`程式版本（建立時 ${was || '未知'}，目前 ${S.VERSION}）`);
      const same = (a, b) => (a == null ? null : U.canonicalJson(a)) === (b == null ? null : U.canonicalJson(b));
      if (!same(o.profile, pack.profile)) why.push('命名規則和工作包附的不同');
      if (!same(o.expectedData, pack.expectedData)) why.push('expectedData 和工作包附的不同');
      if (why.length) {
        warnings.push({ code: 'baseline-key', path: null, message: `重建的基準鍵和工作包不同：${why.join('、')}；處理紀錄會把它當成新的一輪` });
      } else {
        errors.push({ code: 'baseline-key', path: null, message: `程式版本、命名規則與 expectedData 都和建立時相同，重建的基準鍵（${meta.baselineKey}）卻和工作包（${mf.baselineKey}）不同` });
      }
    }
    return { ok: errors.length === 0, errors, warnings, snapshot: snap };
  }

  S.workpack = { SCHEMA, ROLES, ERRORS, WARNINGS, MANIFEST, build, read, validate, sha256 };
})(globalThis.SSOT = globalThis.SSOT || {});
