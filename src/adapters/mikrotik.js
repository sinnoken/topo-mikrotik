/*
 * MikroTik RouterOS adapters（RouterOS 7 為主；6.43+ 的 bridge VLAN filtering 也盡量支援）。
 *
 * 所有 print 指令都要加 detail：`/ip neighbor print detail without-paging`。
 * detail 的 key=value 格式在各版本間最一致，也不受欄寬影響。
 *
 *   mikrotik.neighbor   /ip neighbor print detail          鄰居（LLDP／MNDP／CDP）
 *   mikrotik.config     /export terse（或 compact）          介面、bridge、bridge VLAN、bonding、IP、router-id、
 *                       DHCP 網路、DNS／NTP 伺服器、名稱 ↔ IP 設定（IP_BINDS）、
 *                       防火牆（/ip|ipv6 firewall filter|nat|raw）、位址清單（/ip|ipv6 firewall address-list 與寫入它的設定）、interface list、/ip service、/ip ipsec peer|policy、
 *                       管理面設定（MGMT_MENUS）、export 的範圍與抬頭版本（exportScope）
 *   mikrotik.bridgehost /interface bridge host print detail  MAC 表
 *   mikrotik.vlans      /interface bridge vlan print detail  bridge VLAN 實際成員（含動態）
 *   mikrotik.interface  /interface print detail             介面狀態（running／停用）
 *   mikrotik.ipaddr     /ip address print detail
 *   mikrotik.arp        /ip arp print detail
 *   mikrotik.route      /ip route print detail（所有路由表；VRF 見 ADR-015）
 *   mikrotik.vrf        /ip vrf print detail（RouterOS 7；VRF 的比對順序與內建 main）
 *   mikrotik.fwstats.*  /ip firewall filter|nat|raw、/ipv6 firewall filter|raw print stats detail  防火牆命中次數（每個表一個 adapter）
 *   mikrotik.ospf       /routing ospf neighbor print detail
 *   mikrotik.wifireg    /interface wifi｜wireless registration-table、/caps-man registration-table print detail  Wi-Fi 關聯表
 *   mikrotik.stp        /interface bridge port monitor [find] once、/interface bridge monitor [find] once  RSTP 狀態
 *   mikrotik.system     /system resource print、/system identity print
 *   mikrotik.routerboard /system routerboard print
 */
(function (S) {
  'use strict';
  const U = S.adapters.util;
  const reg = S.adapters.register;
  const at = (b, i) => b.origin.startLine + i;
  const IPRE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
  const VENDOR = 'mikrotik';
  const has = (lines, key) => { const re = new RegExp('(^|\\s)' + key + '='); return lines.some((l) => re.test(l)); };
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const noop = () => {};

  // ================================================================ detail 輸出解析
  const KVRE = /([\w.\-]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
  function kvOf(text) {
    const kv = {}; let m; KVRE.lastIndex = 0;
    while ((m = KVRE.exec(text))) {
      let v = m[2];
      if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1).replace(/\\(.)/g, '$1');
      kv[m[1]] = v;
    }
    return kv;
  }
  const LEGEND_MORE = /^(?:[A-Za-z+*]\s+-\s+[\w-]+(?:[,;]\s*|\s*$))+$/;
  /** 行尾時是否還在引號裡（\ 跳脫的引號不算；引號外遇到 ;;; 之後是註解，不算） */
  function quoteOpen(text) {
    let open = false;
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (open && ch === '\\') { k++; continue; }
      if (ch === '"') open = !open;
      else if (!open && text.startsWith(';;;', k)) break;
    }
    return open;
  }
  // 列首（序號、旗標後接 key= 或 ;;;）：沒關上的引號不會把下一列吞進來
  const ROW_HEAD = /^\s*\d+(?:\s+[A-Za-z*+]+)*\s+(?:[\w.\-]+=|;;;)/;
  const FIRST_KEY = /(^|\s)[\w.\-]+=/;
  // 行尾是沒有引號、以逗號結尾的 key=值（清單值在逗號後斷開）
  const LIST_CUT = /(^|\s)[\w.\-]+=[^\s"=]*,$/;
  /**
   * 依終端寬度折行時，一個值可能在中間斷開，下一行的縮排比欄位深（不是新欄位）：
   *  - 引號值（tests/fixtures/real/7.25.1-neighbor-wrap.txt：「RBwAPGR-」的下一行是「5HacD2HnD"」）：有 key=value、行尾還在引號裡的行，
   *    接上下一行（去掉縮排），直到引號關上：斷在 - 或 / 之後直接接上，其他補一個空白（在空白處斷行時那個空白不會留在行尾）。
   *  - 沒有引號的清單值（tests/fixtures/real/7.24.4-RB5009UG+S+.txt：system-caps 斷在「docsis-cable-device,」之後）：行尾是以逗號結尾的 key=值，
   *    下一行縮排比這一行第一個欄位深、第一個字不是 key=，直接接上（逗號後沒有空白）。縮排與欄位對齊的下一行是新欄位，不接。
   * 這是依實機輸出的推論，手冊沒有折行規則（無法以手冊確認；手冊只說明終端寬度可設定：https://manual.mikrotik.com/docs/management-tools/console.md）。
   * 回傳 [{ text, i（第一行的索引）, more（接上的其他行的索引）}]。
   */
  function joinQuoted(lines) {
    const out = [];
    const indent = (s) => s.length - s.replace(/^\s+/, '').length;
    for (let i = 0; i < lines.length; i++) {
      const cur = { text: lines[i].replace(/\r$/, ''), i, more: [] };
      const km = FIRST_KEY.exec(cur.text);
      const keyCol = km ? km.index + km[1].length : -1;
      while (km && i + 1 < lines.length) {
        const next = lines[i + 1].replace(/\r$/, '');
        if (!next.trim() || ROW_HEAD.test(next)) break;
        const piece = next.replace(/^\s+/, '');
        if (quoteOpen(cur.text)) cur.text = /[-/]$/.test(cur.text) ? cur.text + piece : cur.text.replace(/\s+$/, '') + ' ' + piece;
        else if (LIST_CUT.test(cur.text) && indent(next) > keyCol && !/=/.test(piece.split(/\s/)[0])) cur.text += piece;
        else break;
        cur.more.push(++i);
      }
      out.push(cur);
    }
    return out;
  }
  const indentOf = (s) => s.length - s.replace(/^\s+/, '').length;
  /** indent：列首那一行的縮排（判斷續行用，不輸出） */
  function newRow(toks, line, indent) {
    return { flags: toks.filter((t) => !/^\d+$/.test(t)).join(''), idx: toks.find((t) => /^\d+$/.test(t)) ?? null, kv: {}, words: [], comment: null, line, lines: [line], indent };
  }
  // 說明行中的旗標字元（「X - disabled」「+ - ECMP」）
  const flagsIn = (text, set) => { const re = /(?:^|[;,\s])([A-Za-z*+])\s*-/g; let m; while ((m = re.exec(text))) set.add(m[1]); };
  // 一行中 key=value 以外的單字（例如路由的 blackhole：手冊 /ip/route 的 blackhole 是 switch，print 時是單獨一個字）
  const bareWords = (text) => text.replace(KVRE, ' ').split(/\s+/).filter(Boolean);
  const joinComment = (a, b) => [a, b].filter(Boolean).join('; ');
  /**
   * 把 detail 輸出切成「列」：
   *  - 列首：`序號 旗標 key=value …`（序號、旗標都可能省略）。有旗標說明時，沒有序號的列首只能是說明列出的旗標字。
   *  - 續行：沒有序號與旗標、直接以 key=value 開頭（終端機換行）→ 併入上一列；
   *    以不是旗標的單字開頭（例如路由的「blackhole immediate-gw=""」）也是續行，那些字記在 words
   *  - `;;; 註解` 屬於它所在或下一個列；列首之後、欄位之前的獨立 `;;;` 行是同一列的另一行註解（CAPsMAN 管理的介面有三行說明）
   *  - 註解依終端寬度硬切時，下一行從註解文字的欄位（`;;; ` 之後）開始、沒有 `;;;`：原樣接上（不補空白），
   *    其後若有 `;;;` 是下一行註解。依實機輸出推論，手冊沒有折行規則（無法以手冊確認）
   *  - 旗標說明可區分列首旗標與 CAPsMAN 等續行說明
   *  - `Flags:`、`Columns:` 說明行略過（傳入 ignore 時列為可忽略）
   * 每列帶 lines（這一列涵蓋的行號）；不屬於任何列的行（沒有 key=value 也不是註解）不在任何列中，由 adapter 層列為無法辨識。
   */
  function parseRows(b, ignore) {
    const flagChars = new Set();
    b.lines.forEach((raw) => {
      const legend = raw.match(/^\s*Flags:\s*(.*)$/i);
      if (legend) flagsIn(legend[1], flagChars);
    });
    const isFlags = (token) => Array.from(token).every((ch) => flagChars.has(ch));
    // note：上一行是列首區（還沒有欄位）的註解，col 是註解文字開始的欄位，供判斷硬切的下一行
    const rows = []; let cur = null; let pending = null; let inLegend = false; let note = null;
    joinQuoted(b.lines).forEach(({ text: line, i, more }) => {
      const t = line.trim();
      if (!t) { note = null; return; }
      if (/^(Flags|Columns):/i.test(t)) { inLegend = /^Flags:/i.test(t); if (ignore) ignore(at(b, i), '說明行'); return; }
      // 旗標說明換到下一行（手冊 VRF 的 /ip/route print detail：「c - connect, s - static, … + - ecmp」）：緊接在 Flags: 之後、整行都是「字元 - 名稱」
      if (inLegend && LEGEND_MORE.test(t)) {
        flagsIn(t, flagChars);
        if (ignore) ignore(at(b, i), '說明行');
        return;
      }
      inLegend = false;
      let comment = null; let body = line;
      const ci = line.indexOf(';;;');
      if (ci >= 0) { comment = line.slice(ci + 3).trim(); body = line.slice(0, ci); }
      // 註解行尾的空白：硬切剛好切在空白之後時，那個空白屬於註解，要等下一行接上時補回（行尾的空白本身不算進註解）
      const tail = (s) => (s.trim() ? /\s*$/.exec(s)[0] : '');
      const noteTail = ci >= 0 ? tail(line.slice(ci + 3)) : '';
      const km = /(^|\s)([\w.\-]+)=/.exec(body);
      const headerOnly = cur && !Object.keys(cur.kv).length;
      // 註解硬切的下一行：從註解文字的欄位開始（之前全是空白），在任何欄位之前
      if (note && headerOnly && !km && body.trim() && !body.slice(0, note.col).trim()) {
        const piece = body.slice(note.col);
        cur.comment += note.tail + piece.replace(/\s+$/, '');
        cur.lines.push(at(b, i));
        note = { col: note.col, tail: tail(piece) };
        if (ci >= 0) { cur.comment = joinComment(cur.comment, comment); note = { col: ci + 4, tail: noteTail }; }
        return;
      }
      note = null;
      if (!km) {
        if (ci >= 0) {
          const toks = body.trim().split(/\s+/).filter(Boolean);
          const indexed = /^\d+$/.test(toks[0] || '');
          const flagTokens = indexed ? toks.slice(1) : toks;
          const rowPrefix = indexed || !flagChars.size || (flagTokens.length && flagTokens.every(isFlags));
          if (toks.length && rowPrefix) { cur = newRow(toks, at(b, i), indentOf(line)); cur.comment = comment; rows.push(cur); note = { col: ci + 4, tail: noteTail }; }
          else if (toks.length && cur) { cur.comment = joinComment(cur.comment, comment); cur.lines.push(at(b, i)); }
          else if (headerOnly) { cur.comment = joinComment(cur.comment, comment); cur.lines.push(at(b, i)); note = { col: ci + 4, tail: noteTail }; }
          else pending = { text: comment, line: at(b, i) };
        } else {
          // 只有序號與旗標、欄位在下一行（與上面 `;;;` 列首同樣的形狀，只是沒有註解）：開新列，否則下一行會被併進上一列。
          // 序號必須有；旗標須是說明行列出的字元（沒有說明行時只接受英文字母），雜訊不會被當成列首
          const toks = t.split(/\s+/);
          const flagOk = (ch) => (flagChars.size ? flagChars.has(ch) : /[A-Za-z]/.test(ch));
          if (/^\d+$/.test(toks[0]) && toks.slice(1).every((token) => Array.from(token).every(flagOk))) {
            cur = newRow(toks, at(b, i), indentOf(line)); rows.push(cur);
            if (pending) { cur.comment = pending.text; cur.lines.unshift(pending.line); pending = null; }
          }
        }
        return;
      }
      const prefix = body.slice(0, km.index + km[1].length).trim();
      const rest = body.slice(km.index + km[1].length);
      const joined = more.map((k) => at(b, k)); // 值斷開而接上的行：屬於同一列
      const toks = prefix.split(/\s+/).filter(Boolean);
      // 有旗標說明時，沒有序號、有不是旗標字的單字、縮排比列首深：是上一列的續行（RouterOS 7 路由的「blackhole immediate-gw=""」）
      const continued = cur && (!toks.length || (flagChars.size && !/^\d+$/.test(toks[0]) && !toks.every(isFlags) && indentOf(line) > cur.indent));
      if (continued) { Object.assign(cur.kv, kvOf(rest)); cur.words.push(...toks, ...bareWords(rest)); cur.lines.push(at(b, i), ...joined); return; }
      cur = newRow(toks, at(b, i), indentOf(line));
      cur.words.push(...bareWords(rest));
      cur.lines.push(...joined);
      cur.comment = comment !== null ? comment : pending && pending.text;
      if (pending) cur.lines.unshift(pending.line);
      pending = null;
      Object.assign(cur.kv, kvOf(rest)); rows.push(cur);
    });
    return rows;
  }
  S.adapters.mikrotikRows = parseRows; // 測試用
  /**
   * 一列處理完：產生事實時，列首以外的行（續行、獨立的 ;;; 註解）是同一筆的一部分；
   * why 有值時整列依該原因略過（停用、非作用中、重複列…）。缺必要欄位的列不呼叫，留給 I03。
   */
  const settle = (r, ignore, why) => r.lines.forEach((n) => { if (why || n !== r.line) ignore(n, why || '續行'); });

  // ================================================================ 鄰居
  const isBridgeName = (n) => /^bridge/i.test(n);
  // LLDP 的 interface-name 在 bridge 成員上為 "bridge/ether2"：前段是對端 bridge，最後一段才是對端實體埠；原文仍留在來源行
  const peerPort = (v) => { const parts = String(v || '').split('/').map((x) => x.trim()).filter(Boolean); return parts.length ? parts[parts.length - 1] : null; };
  reg({
    id: 'mikrotik.neighbor', vendor: VENDOR, dataType: 'lldp', label: 'RouterOS 鄰居（LLDP／MNDP／CDP）',
    command: /^\/?ip\s+neighbou?r\b/i,
    detect: (lines) => has(lines, 'identity') && has(lines, 'mac-address') && has(lines, 'interface'),
    parse(b, emit, ignore = noop) {
      const rows = [];
      parseRows(b, ignore).forEach((r) => {
        const kv = r.kv;
        const locals = list(String(kv.interface || '').replace(/\//g, ','));
        if (!locals.length) return;
        const peer = kv.identity || kv['mac-address'] || kv.address4 || kv.address;
        if (!peer) return;
        const addr = [kv.address4, kv.address].find((a) => a && IPRE.test(a)) || null;
        rows.push({
          local: locals.find((x) => !isBridgeName(x)) || locals[0], viaBridge: locals.every(isBridgeName),
          peer, ident: kv.identity || null, discoveredBy: kv['discovered-by'] || '', peerIfc: peerPort(kv['interface-name']), mac: kv['mac-address'] || null, addr,
          board: kv.board || null, platform: kv.platform || null, version: kv.version || null, caps: kv['system-caps-enabled'] || kv['system-caps'] || null, line: r.line, row: r,
        });
      });
      // 同一台鄰居可能被多個協定（LLDP／MNDP／CDP）、或同時從連接埠與 bridge 看到：
      // 同一個本機介面上，MAC 或 identity 相同的列視為同一個遠端，合併協定與非空欄位；連接埠優先於 bridge
      const norm = (v) => (v ? String(v).toLowerCase() : null);
      const same = (x, y) => (x.macK && x.macK === y.macK) || (x.idK && x.idK === y.idK);
      rows.forEach((r) => {
        r.macK = norm(r.mac); r.idK = norm(r.ident);
        r.protos = list(String(r.discoveredBy || '').toLowerCase());
      });
      const physical = rows.filter((r) => !r.viaBridge);
      const groups = [];
      rows.forEach((r) => { if (r.viaBridge && physical.some((p) => same(p, r))) settle(r.row, ignore, '同一鄰居經 bridge 的重複列'); });
      physical.concat(rows.filter((r) => r.viaBridge && !physical.some((p) => same(p, r)))).forEach((r) => {
        const g = groups.find((x) => x.local === r.local && x.rows.some((y) => same(y, r)));
        if (g) g.rows.push(r); else groups.push({ local: r.local, rows: [r] });
      });
      groups.forEach((g) => {
        g.rows.forEach((r, k) => settle(r.row, ignore, k ? '同一鄰居的其他協定或重複列（已合併）' : null));
        const first = (f, rs) => { const r = rs.find((x) => x[f]); return r ? r[f] : null; };
        const lldp = g.rows.filter((r) => r.protos.includes('lldp'));
        const prefer = lldp.concat(g.rows.filter((r) => !lldp.includes(r)));
        const peerIfcs = Array.from(new Set(g.rows.map((r) => r.peerIfc).filter(Boolean)));
        const protocols = Array.from(new Set([].concat(...g.rows.map((r) => r.protos)))).sort();
        emit({
          t: 'lldp', ifc: g.local, peer: first('ident', g.rows) || first('mac', g.rows) || first('addr', g.rows),
          peerIfc: first('peerIfc', prefer), peerIfcAlt: peerIfcs.length > 1 ? peerIfcs : null, protocols,
          chassis: first('mac', prefer), peerAddr: first('addr', g.rows), board: first('board', g.rows),
          platform: first('platform', g.rows), version: first('version', g.rows), caps: first('caps', g.rows), line: g.rows[0].line,
        });
      });
    },
  });

  /** export 開頭的日期：RouterOS 7 為 2026-10-13，RouterOS 6 為 oct/13/2026 → 2026-10-13T10:00:00（不含時區）。 */
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function exportTime(date, time) {
    if (/^\d{4}-/.test(date)) return `${date}T${time}`;
    const m = date.match(/^([a-z]{3})\/(\d{2})\/(\d{4})$/i); const mon = m && MON[m[1].toLowerCase()];
    return mon ? `${m[3]}-${String(mon).padStart(2, '0')}-${m[2]}T${time}` : null;
  }

  /*
   * 組態中「名稱 ↔ IP」的設定（單一來源）：選單 → 名稱欄位、IP 欄位。產生 { t:'ipBind', section, name, value }，供跨設備比對。
   * multi：值是逗號分隔的多筆（/ip pool 的 ranges）。only：只收這些 type（/ip dns static 只有 A／AAAA 紀錄帶位址，type 省略即 A）。
   */
  const IP_BINDS = {
    '/ip firewall address-list': { name: 'list', value: 'address' },
    '/ip dns static': { name: 'name', value: 'address', only: { key: 'type', values: ['', 'a', 'aaaa'] } },
    '/ip pool': { name: 'name', value: 'ranges', multi: true },
    '/ip dhcp-server lease': { name: 'mac-address', value: 'address' },
  };
  /*
   * 防火牆位址清單（https://manual.mikrotik.com/docs/cli-reference/ip/firewall/address-list.md、…/ipv6/firewall/address-list.md）：
   * 每個項目一筆 { t:'addrListEntry', family, list, address, disabled, timeout, dynamic }，停用的也記（model 決定算不算）。
   * export 只有靜態項目；有逾時或 dynamic=yes 的項目、DNS 名稱解析出的位址都是動態的，不會出現在 export。
   */
  const ADDR_LIST_MENUS = { '/ip firewall address-list': 'ip', '/ipv6 firewall address-list': 'ipv6' };
  /*
   * 會寫入位址清單的其他設定（不是 filter／nat／raw 規則；規則的 add-src-to-address-list 由 model 依規則判斷）：
   * 參數 address-list／address-lists（例如 /ppp profile、/ip dhcp-server、mangle 規則）寫入指名的清單；
   * 其他文字（例如腳本內容）提到 address-list 時，寫入哪些清單無從得知，lists 為 null。
   */
  const ADDR_LIST_PARAMS = ['address-list', 'address-lists'];
  const ADDR_LIST_WORD = /(^|[^\w-])address-list(?=[^\w=-]|$)/;
  // 設備層級的 DNS／NTP 伺服器：0.0.0.0（RouterOS 6 的 primary-ntp／secondary-ntp 預設值）代表未設定
  // 手冊寫 servers 以空白分隔，export 常見逗號；伺服器名稱不含兩者，所以都當分隔
  const serverList = (...vals) => vals.flatMap((v) => String(v || '').split(/[\s,]+/)).filter((v) => v && v !== '0.0.0.0' && v !== '::');

  // ================================================================ 防火牆（/export 的 /ip firewall、/ipv6 firewall 等）
  /**
   * RouterOS export 的字串值：引號內以 \ 跳脫（\" \\ \$ \? \_＝空白、\n \r \t），非 ASCII 位元組寫成 \XX（十六進位）。
   * 位元組依序試 UTF-8、Big5 解碼（註解常見兩種混用）；都失敗、或讀檔時已出現取代字元（U+FFFD）時保留原文，encoding 標為 undecodable。
   * 回傳 { text, encoding: 'ascii'|'utf-8'|'big5'|'undecodable' }。
   */
  const ESC = { n: 10, r: 13, t: 9, _: 32 };
  function rosString(raw) {
    const s = String(raw);
    const body = s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s;
    if (body.includes('�')) return { text: body, encoding: 'undecodable' };
    const cps = Array.from(body); const bytes = []; let wide = false;
    const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    for (let i = 0; i < cps.length; i++) {
      const ch = cps[i];
      if (ch === '\\' && i + 1 < cps.length) {
        const h = (cps[i + 1] || '') + (cps[i + 2] || '');
        if (/^[0-9A-Fa-f]{2}$/.test(h)) { bytes.push(parseInt(h, 16)); wide = true; i += 2; continue; }
        const e = cps[++i]; bytes.push(ESC[e] ?? e.charCodeAt(0)); continue;
      }
      const c = ch.codePointAt(0);
      if (c < 0x80) bytes.push(c);
      else if (enc) { wide = true; enc.encode(ch).forEach((x) => bytes.push(x)); } else return { text: body, encoding: 'undecodable' };
    }
    if (!wide) return { text: String.fromCharCode(...bytes), encoding: 'ascii' };
    for (const [label, name] of [['utf-8', 'utf-8'], ['big5', 'big5']]) {
      try { return { text: new TextDecoder(label, { fatal: true }).decode(new Uint8Array(bytes)), encoding: name }; } catch (e) { /* 換下一種編碼 */ }
    }
    return { text: body, encoding: 'undecodable' };
  }
  S.adapters.rosString = rosString; // 測試用
  const KVRAW = /([\w.\-]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
  /** key=value（依出現順序，值為原始文字，含引號）。 */
  function kvPairs(text) { const out = []; let m; KVRAW.lastIndex = 0; while ((m = KVRAW.exec(text))) out.push([m[1], m[2]]); return out; }
  const FW_TABLES = {
    '/ip firewall filter': ['ip', 'filter'], '/ip firewall nat': ['ip', 'nat'], '/ip firewall raw': ['ip', 'raw'],
    '/ipv6 firewall filter': ['ipv6', 'filter'], '/ipv6 firewall raw': ['ipv6', 'raw'],
  };
  // 不是比對條件的欄位：規則本身的屬性與動作參數（官方手冊 filter／nat 的 action 參數）
  const FW_META = new Set(['chain', 'action', 'comment', 'disabled', 'log', 'log-prefix', 'place-before']);
  const FW_PARAMS = new Set(['jump-target', 'to-addresses', 'to-ports', 'reject-with', 'address-list', 'address-list-timeout']);
  /** 一條防火牆規則：比對條件原樣保留（否定是值前面的 !），chain 內順序由 model 依出現順序編號。 */
  /*
   * 對外與路由網域設定的選單（ADR-023）：kind 是 model 的種類，params 是要記的參數（原值），switches 是單獨一個字的參數，
   * secret 是只記「有沒有設」的參數。參數依手冊：
   *   https://manual.mikrotik.com/docs/cli-reference/ip/dhcp-client.md
   *   https://manual.mikrotik.com/docs/cli-reference/interface/pppoe-client.md（不記 user、password）
   *   https://manual.mikrotik.com/docs/cli-reference/routing/ospf/area.md
   *   https://manual.mikrotik.com/docs/cli-reference/routing/ospf/interface-template.md（auth-key 不記值）
   */
  const CFG_MENUS = {
    '/ip dhcp-client': { kind: 'dhcpClient', params: ['name', 'interface', 'add-default-route', 'default-route-distance', 'check-gateway', 'use-peer-dns', 'disabled', 'comment'] },
    '/interface pppoe-client': { kind: 'pppoeClient', params: ['name', 'interface', 'add-default-route', 'default-route-distance', 'use-peer-dns', 'disabled', 'comment'] },
    '/routing ospf area': { kind: 'ospfArea', params: ['name', 'area-id', 'instance', 'type', 'disabled', 'comment'] },
    '/routing ospf interface-template': { kind: 'ospfTemplate', params: ['area', 'networks', 'interfaces', 'passive', 'auth', 'cost', 'type', 'disabled', 'comment'], switches: ['passive'], secret: 'auth-key' },
  };

  function fwRule(family, table, argText, line) {
    const match = {}; const params = {}; let chain = null; let action = 'accept'; let disabled = false; let comment = null; let commentEncoding = null;
    kvPairs(argText).forEach(([k, raw]) => {
      const v = rosString(raw);
      if (k === 'comment') { comment = v.text; commentEncoding = v.encoding; } else if (k === 'chain') chain = v.text;
      else if (k === 'action') action = v.text; else if (k === 'disabled') disabled = v.text === 'yes';
      else if (FW_PARAMS.has(k)) params[k] = v.text; else if (!FW_META.has(k)) match[k] = v.text;
    });
    return { t: 'fwRule', family, table, chain: chain || '(未指定)', action, match, params, disabled, comment, commentEncoding, line };
  }

  /*
   * 管理面設定（F10–F14）：設定類選單（Settings Directory）的 set 只記這個工具用到的參數，原值照錄；export 只寫非預設值，
   * 預設值由 model 依 S.MGMT_DEFAULTS 補上。選單 → [model 的 area, 參數]，參數語意見 S.MGMT_DEFAULTS.manual 的手冊頁。
   */
  const MGMT_MENUS = {
    '/ip dns': ['dns', ['allow-remote-requests', 'vrf']],
    '/tool mac-server': ['macServer', ['allowed-interface-list']],
    '/tool mac-server mac-winbox': ['macWinbox', ['allowed-interface-list']],
    '/ip neighbor discovery-settings': ['discovery', ['discover-interface-list', 'protocol', 'mode']],
    '/snmp': ['snmp', ['enabled']],
    '/ip upnp': ['upnp', ['enabled']],
    '/ip proxy': ['proxy', ['enabled', 'port']],
    '/ip socks': ['socks', ['enabled', 'port', 'vrf']],
    '/tool bandwidth-server': ['bandwidthServer', ['enabled', 'authenticate']],
  };

  /*
   * 整機 export（/export、/export terse、/export compact…）才涵蓋所有選單：沒寫出的選單＝出廠預設值。
   * 其他區塊（/ip firewall export 這類部分 export、沒有指令標記的段落）只涵蓋裡面出現的選單，依區塊的指令判斷，不看內容。
   */
  const FULL_EXPORT = /^\/?export\b/i;

  // ================================================================ 設定（/export）
  reg({
    id: 'mikrotik.config', vendor: VENDOR, dataType: 'config', label: 'RouterOS 設定',
    command: FULL_EXPORT,
    detect: (lines) => lines.some((l) => /^\s*(\/[\w\- ]+?\s+)?add\s+[\w\-]+=/.test(l)) && lines.some((l) => /^\s*\/(interface|ip|system|routing)\b/.test(l)),
    parse(b, emit, ignore = noop) {
      // 還原斷行：行尾 \ 接到下一行（續行的前導空白去掉）；續行屬於同一個敘述
      const lines = []; let acc = null;
      b.lines.forEach((raw, i) => {
        const l = raw.replace(/\r$/, '');
        if (acc) { acc.text += l.trim(); ignore(at(b, i), '續行'); } else acc = { text: l.trim(), line: at(b, i) };
        if (acc.text.endsWith('\\')) { acc.text = acc.text.slice(0, -1); return; }
        lines.push(acc); acc = null;
      });
      if (acc) lines.push(acc);

      // export 的範圍與 RouterOS 版本（抬頭的「by RouterOS 版本」）：model 判斷能不能用出廠預設值補沒寫出的設定
      const verHdr = lines.find((x) => /^#.*\bby RouterOS\s+\S/i.test(x.text));
      const firstLine = lines.find((x) => x.text);
      if (firstLine) emit({ t: 'exportScope', full: FULL_EXPORT.test(b.command || ''), version: verHdr ? verHdr.text.match(/\bby RouterOS\s+(\S+)/i)[1] : null, line: (verHdr || firstLine).line });

      let ctx = '';
      const bridges = new Map(); const ports = []; const bvlans = []; const ridNames = new Map(); let ospfRid = null; let ospfLine = 0;
      const handle = (path, cmd, argText, line) => {
        let sel = null; let args = argText;
        const sm = args.match(/^\[\s*find\s*([^\]]*)\]\s*(.*)$/);
        if (sm) { sel = kvOf(sm[1].replace(/^where\s+/, '')); args = sm[2]; }
        const kv = kvOf(args);
        if (!FW_TABLES[path] && !ADDR_LIST_MENUS[path]) {
          const named = ADDR_LIST_PARAMS.filter((k) => kv[k]).flatMap((k) => list(kv[k]));
          if (named.length) emit({ t: 'addrListWriter', section: path, lists: S.util.uniq(named), line });
          else if (ADDR_LIST_WORD.test(argText)) emit({ t: 'addrListWriter', section: path, lists: null, line });
        }
        const mm = MGMT_MENUS[path];
        if (mm && cmd === 'set') {
          const values = {}; mm[1].forEach((k) => { if (k in kv) values[k] = kv[k]; });
          if (Object.keys(values).length) emit({ t: 'mgmtSet', area: mm[0], values, line });
        }
        switch (path) {
          // SNMP community（https://manual.mikrotik.com/docs/cli-reference/snmp/community.md）：出廠有一個預設的 community（default 旗標），
          // export 以「set [ find default=yes ] …」改它；add 是新增的。set 也可能用名稱選（[ find name=x ] 或第一個字是名稱）
          case '/snmp community': {
            if (cmd !== 'add' && cmd !== 'set') break;
            const pos = args.match(/^([^\s=\[]+)(?=\s|$)/);
            const f = { t: 'snmpCommunity', cmd, line };
            if (cmd === 'set') {
              if (sel && sel.default === 'yes') f.target = { default: true };
              else if ((sel && sel.name) || pos) f.target = { name: (sel && sel.name) || pos[1] };
              else break;
            }
            if (kv.name !== undefined) f.name = kv.name;
            if (kv.addresses !== undefined) f.addresses = list(kv.addresses);
            if (kv['write-access'] !== undefined) f.write = kv['write-access'] === 'yes';
            if (kv.security !== undefined) f.security = kv.security;
            if (kv.disabled !== undefined) f.disabled = kv.disabled === 'yes';
            emit(f); break;
          }
          // UPnP 的介面角色（https://manual.mikrotik.com/docs/cli-reference/ip/upnp/interfaces.md）：internal 是 UPnP 用戶端所在、服務監聽的介面
          case '/ip upnp interfaces':
            if (cmd === 'add' && kv.interface && kv.type) emit({ t: 'upnpIfc', ifc: kv.interface, type: kv.type, disabled: kv.disabled === 'yes', line });
            break;
          case '/system identity':
            if (kv.name) emit({ t: 'hostname', name: kv.name, line });
            break;
          case '/interface ethernet': {
            if (cmd !== 'set' || !sel) break;
            const name = kv.name || sel['default-name'] || sel.name; if (!name) break;
            const f = { t: 'ifc', ifc: name, line };
            if (kv.comment) f.desc = kv.comment;
            if (kv.disabled === 'yes') f.enabled = false;
            emit(f); break;
          }
          case '/interface bridge': {
            const name = kv.name || (sel && sel.name); if (!name) break;
            const br = bridges.get(name) || { filtering: false }; bridges.set(name, br);
            if (kv['vlan-filtering']) br.filtering = kv['vlan-filtering'] === 'yes';
            const f = { t: 'ifc', ifc: name, rawType: 'bridge', line }; if (kv.comment) f.desc = kv.comment;
            // vlan-filtering 預設 no，terse export 不寫預設值：add 沒寫就是 no；set 只有寫了才改
            if (kv['vlan-filtering']) f.vlanFiltering = kv['vlan-filtering'] === 'yes'; else if (cmd === 'add') f.vlanFiltering = false;
            emit(f); break;
          }
          case '/interface bridge port':
            if (cmd === 'add' && kv.interface) {
              ports.push({ bridge: kv.bridge, ifc: kv.interface, pvid: kv.pvid || '1', line });
              const f = { t: 'ifc', ifc: kv.interface, line }; if (kv.bridge) f.bridge = kv.bridge; if (kv.comment) f.desc = kv.comment;
              if (kv['frame-types']) f.frameTypes = kv['frame-types'];
              if (kv['ingress-filtering']) f.ingressFiltering = kv['ingress-filtering'] === 'yes';
              emit(f);
            }
            break;
          case '/interface bridge vlan':
            if (cmd === 'add') bvlans.push({ bridge: kv.bridge, ids: S.util.vlanTokens(kv['vlan-ids'] || ''), tagged: list(kv.tagged), untagged: list(kv.untagged), comment: kv.comment || null, line });
            break;
          case '/interface vlan':
            if (cmd === 'add' && kv.name && kv['vlan-id']) {
              const f = { t: 'ifc', ifc: kv.name, rawType: 'vlan', parent: kv.interface, encapVlan: +kv['vlan-id'], line }; if (kv.comment) f.desc = kv.comment;
              if (kv.disabled === 'yes') f.enabled = false;
              emit(f);
              emit({ t: 'vlan', id: +kv['vlan-id'], name: null, line });
              // VLAN 介面在 parent 上收送帶這個 VLAN ID 的 tagged 訊框（設定的事實），停用時不收送
              if (kv.disabled !== 'yes') emit({ t: 'vmem', vlan: String(kv['vlan-id']), ifc: kv.interface, tagged: true, src: 'config', line });
            }
            break;
          case '/interface bonding':
            if (cmd === 'add' && kv.name) {
              const f = { t: 'ifc', ifc: kv.name, rawType: 'bond', line }; if (kv.comment) f.desc = kv.comment; emit(f);
              list(kv.slaves).forEach((s) => emit({ t: 'ifc', ifc: s, lag: kv.name, line }));
            }
            break;
          case '/ip address':
            if (cmd === 'add' && kv.address && kv.interface && kv.disabled !== 'yes') emit({ t: 'ifc', ifc: kv.interface, ip: kv.address, line });
            break;
          // VRF（ADR-015，只支援 RouterOS 7）：/ip vrf 的 name、interfaces（https://manual.mikrotik.com/docs/cli-reference/ip/vrf.md）。
          // 依序比對、第一筆列到的介面屬於它（由 model 決定）；export 依設定順序列出，但不寫出內建的 main，所以看不出 main 排在哪裡
          // （model 假設在最後，見 resolveVrfs）。停用的項目照樣記下、不比對介面。手冊範例也有單數的 interface=，一併接受。
          case '/ip vrf':
            if (cmd === 'add' && kv.name) emit({ t: 'vrf', name: kv.name, interfaces: list(kv.interfaces || kv.interface), disabled: kv.disabled === 'yes', builtin: false, source: 'export', line });
            break;
          // 路由表與策略路由（https://manual.mikrotik.com/docs/cli-reference/routing/table.md、…/routing/rule.md、
          // https://manual.mikrotik.com/docs/user-guides/routing-and-networking-protocols/routing-decision.md）：
          // /routing table 的 name 與 fib（單獨的字，表示這張表的路由會裝進 FIB）；/routing rule 依序比對的條件、action 與 table；
          // /routing settings 的 policy-rules 是查表的順序；/ip firewall mangle 只記 mark-routing（改變查哪一張表）
          case '/routing table':
            if (cmd === 'add' && kv.name) emit({ t: 'routingTable', name: kv.name, fib: /(^|\s)fib(\s|$)/.test(args), disabled: kv.disabled === 'yes', line });
            break;
          case '/routing rule':
            if (cmd === 'add') {
              const match = {}; Object.keys(kv).forEach((k) => { if (!['action', 'table', 'disabled', 'comment'].includes(k)) match[k] = kv[k]; });
              emit({ t: 'routingRule', action: kv.action || 'lookup', table: kv.table || null, match, disabled: kv.disabled === 'yes', comment: kv.comment || null, line });
            }
            break;
          case '/routing settings':
            if (cmd === 'set' && kv['policy-rules'] !== undefined) emit({ t: 'policyRules', rules: list(kv['policy-rules']), line });
            break;
          case '/ip firewall mangle':
            if (cmd === 'add' && kv.action === 'mark-routing') {
              const match = {}; Object.keys(kv).forEach((k) => { if (!['action', 'new-routing-mark', 'passthrough', 'disabled', 'comment', 'log', 'log-prefix'].includes(k)) match[k] = kv[k]; });
              emit({ t: 'markRouting', chain: kv.chain || null, mark: kv['new-routing-mark'] || null, match, disabled: kv.disabled === 'yes', line });
            }
            break;
          case '/interface vrrp':
            if (cmd === 'add' && kv.name) { const f = { t: 'ifc', ifc: kv.name, rawType: 'vrrp', line }; if (kv.comment) f.desc = kv.comment; emit(f); }
            break;
          case '/ip dhcp-server network':
            if (cmd === 'add' && kv.address) emit({ t: 'dhcpNet', network: kv.address, gateways: list(kv.gateway), dns: list(kv['dns-server']), ntp: list(kv['ntp-server']), line });
            break;
          // menu／param：值是從哪個選單的哪個參數收集到的（產生修正指令要用）。只讀可設定的 servers；
          // dynamic-servers 是唯讀（DHCP client 等服務學到的），不是設定值，不收
          case '/ip dns':
            if (cmd === 'set' && 'servers' in kv) emit({ t: 'dnsServers', servers: serverList(kv.servers), menu: path, param: 'servers', line });
            break;
          case '/system ntp client': { // RouterOS 7：servers=；RouterOS 6：primary-ntp／secondary-ntp（兩個固定欄位，記成同一個 param）
            if (cmd !== 'set') break;
            if ('servers' in kv) { const servers = serverList(kv.servers); if (servers.length) emit({ t: 'ntpServers', servers, menu: path, param: 'servers', line }); break; }
            const servers = serverList(kv['primary-ntp'], kv['secondary-ntp']);
            if (servers.length) emit({ t: 'ntpServers', servers, menu: path, param: 'primary-ntp/secondary-ntp', line });
            break;
          }
          case '/system ntp client servers': // RouterOS 7 的伺服器清單子選單：每筆 add 一個伺服器
            if (cmd === 'add' && kv.address && kv.disabled !== 'yes') emit({ t: 'ntpServers', servers: serverList(kv.address), menu: path, param: 'address', line });
            break;
          case '/routing id':
            if (cmd === 'add' && kv.name && kv.id) ridNames.set(kv.name, kv.id);
            break;
          case '/routing ospf instance':
            if (kv['router-id']) { ospfRid = kv['router-id']; ospfLine = line; }
            break;
          // 對外與路由網域的設定（ADR-023）：DHCP client、PPPoE client、OSPF area、OSPF interface-template。
          // 只記 export 寫出的參數原值（export 只寫非預設值），預設值由 model 補上（resolveRoutingCfg）；
          // 金鑰與帳密（auth-key、password、user）不記，OSPF 驗證只記類型（auth）與有沒有設金鑰（authKey）
          case '/ip dhcp-client': case '/interface pppoe-client': case '/routing ospf area': case '/routing ospf interface-template': {
            if (cmd !== 'add' && cmd !== 'set') break;
            const spec = CFG_MENUS[path];
            const values = {}; spec.params.forEach((k) => { if (k in kv) values[k] = kv[k]; });
            // switch 參數（passive）在 export 是單獨的字；去掉 key=value（含引號內的文字）後再找
            const bare = args.replace(/^\[[^\]]*\]/, ' ').replace(KVRE, ' ');
            (spec.switches || []).forEach((k) => { if (new RegExp(`(^|\\s)${k}(\\s|$)`).test(bare)) values[k] = 'yes'; });
            if (spec.secret && spec.secret in kv) values[spec.secret] = true; // 只記有設，不記值
            const f = { t: 'cfgItem', kind: spec.kind, cmd, values, line };
            if (cmd === 'set') {
              const pos = args.match(/^([^\s=\[]+)(?=\s|$)/);
              if (sel) f.target = Object.assign({}, sel); else if (pos && !(spec.switches || []).includes(pos[1])) f.target = { name: pos[1] }; else break;
              delete values.name; if (kv.name !== undefined) f.rename = kv.name;
            }
            emit(f); break;
          }
          case '/interface list':
            if (cmd === 'add' && kv.name) emit({ t: 'ifList', name: kv.name, include: list(kv.include), exclude: list(kv.exclude), line });
            break;
          case '/interface list member':
            if (cmd === 'add' && kv.list && kv.interface) emit({ t: 'ifListMember', list: kv.list, ifc: kv.interface, disabled: kv.disabled === 'yes', line });
            break;
          case '/ip service': {
            // 「set telnet disabled=yes」（第一個字是服務名稱）或「set [ find name=ssh ] …」
            const pos = args.match(/^([^\s=\[]+)(?=\s|$)/);
            const name = (sel && sel.name) || (pos && pos[1]); if (cmd !== 'set' || !name) break;
            const f = { t: 'ipService', name, line };
            if (kv.disabled) f.disabled = kv.disabled === 'yes';
            if (kv.port && /^\d+$/.test(kv.port)) f.port = +kv.port;
            // RouterOS 7 的 available-from；舊版 export 為 address。空字串＝不限來源
            const af = kv['available-from'] !== undefined ? kv['available-from'] : kv.address;
            if (af !== undefined) f.addresses = list(af);
            emit(f); break;
          }
          case '/ip ipsec peer':
            if (cmd === 'add') emit({ t: 'ipsecPeer', name: kv.name || null, address: kv.address || null, disabled: kv.disabled === 'yes', line });
            break;
          // IPv6 是否在用（F07 的 IPv6 部分）：有位址或 DHCPv6 client，或整個停用
          case '/ipv6 address':
            if (cmd === 'add' && kv.interface && kv.disabled !== 'yes') emit({ t: 'ipv6Use', kind: 'address', ifc: kv.interface, line });
            break;
          case '/ipv6 dhcp-client':
            if (cmd === 'add' && kv.interface && kv.disabled !== 'yes') emit({ t: 'ipv6Use', kind: 'dhcp-client', ifc: kv.interface, line });
            break;
          case '/ipv6 settings':
            if (cmd === 'set' && kv['disable-ipv6'] === 'yes') emit({ t: 'ipv6Disabled', line });
            break;
          case '/ip ipsec policy':
            // set（例如 [ find default=yes ]）是預設的 template policy，不代表有在跑 IPsec
            if (cmd === 'add') emit({ t: 'ipsecPolicy', srcAddress: kv['src-address'] || null, dstAddress: kv['dst-address'] || null, peer: kv.peer || null, template: kv.template === 'yes', disabled: kv.disabled === 'yes', line });
            break;
          default: {
            if (FW_TABLES[path]) { if (cmd === 'add') emit(fwRule(FW_TABLES[path][0], FW_TABLES[path][1], args, line)); break; }
            if (ADDR_LIST_MENUS[path] && cmd === 'add' && kv.list && kv.address) {
              emit({ t: 'addrListEntry', family: ADDR_LIST_MENUS[path], list: kv.list, address: kv.address.trim(), disabled: kv.disabled === 'yes',
                timeout: kv.timeout || null, dynamic: kv.dynamic === 'yes', line });
            }
            const bind = IP_BINDS[path];
            if (!bind || cmd !== 'add' || kv.disabled === 'yes' || kv.dynamic === 'yes') break;
            if (bind.only && !bind.only.values.includes(String(kv[bind.only.key] || '').toLowerCase())) break;
            const name = kv[bind.name]; const raw = kv[bind.value];
            if (!name || !raw) break;
            (bind.multi ? list(raw) : [raw.trim()]).forEach((value) => emit({ t: 'ipBind', section: path, name, value, line }));
            break;
          }
        }
      };
      // 可忽略：export 抬頭（# 註解）、選單路徑行、語法正確但這個工具沒有使用（或停用、欄位不足）的 add／set 敘述。
      // 其他內容（不是 #、/選單、add／set 開頭，或還沒有選單路徑就出現 add／set）不是 export 的格式，留給 I03。
      lines.forEach(({ text, line }) => {
        // export 開頭的「# 日期 時間 by RouterOS 版本」：設備自己記錄的收集時間（設備本地時間）
        const hdr = text && text.match(/^#\s*(\d{4}-\d{2}-\d{2}|[a-z]{3}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})\s+by RouterOS\b/i);
        if (hdr) { const at = exportTime(hdr[1], hdr[2]); if (at) emit({ t: 'collectedAt', at, line }); }
        if (!text) return;
        if (text.startsWith('#')) { ignore(line, '註解'); return; }
        if (text[0] === '/') {
          // RouterOS 7 也可能輸出斜線分隔的選單路徑（/interface/bridge/port），視同空白分隔
          text = text.replace(/^\/[\w\-/]+/, (p) => '/' + p.slice(1).split('/').filter(Boolean).join(' '));
          const m = text.match(/^(\/[\w\-]+(?:\s+[\w\-]+)*?)(?:\s+(add|set)\b\s*(.*))?$/);
          if (!m) return;
          const path = m[1].replace(/\s+/g, ' ');
          if (m[2]) { handle(path, m[2], m[3] || '', line); ignore(line, '未使用的設定'); } else { ctx = path; ignore(line, '選單路徑'); }
          return;
        }
        const m = text.match(/^(add|set)\b\s*(.*)$/);
        if (m && ctx) { handle(ctx, m[1], m[2], line); ignore(line, '未使用的設定'); }
      });

      // bridge VLAN filtering：只有開啟時，VLAN 成員才有意義
      const filtering = (name) => !!(bridges.get(name) && bridges.get(name).filtering);
      bvlans.forEach((v) => {
        if (!filtering(v.bridge)) return;
        v.ids.forEach((id) => {
          emit({ t: 'vlan', id: +id, name: null, desc: v.comment || undefined, line: v.line });
          v.tagged.forEach((ifc) => emit({ t: 'vmem', vlan: String(id), ifc, tagged: true, src: 'config', line: v.line }));
          v.untagged.forEach((ifc) => emit({ t: 'vmem', vlan: String(id), ifc, src: 'config', line: v.line }));
        });
      });
      ports.forEach((p) => { if (filtering(p.bridge)) emit({ t: 'vmem', vlan: String(p.pvid), ifc: p.ifc, pvid: true, src: 'config', line: p.line }); });
      const rid = IPRE.test(ospfRid || '') ? ospfRid : ridNames.get(ospfRid);
      if (rid && IPRE.test(rid)) emit({ t: 'rid', id: rid, line: ospfLine });
    },
  });

  // ================================================================ MAC 表
  reg({
    id: 'mikrotik.bridgehost', vendor: VENDOR, dataType: 'mac', label: 'RouterOS MAC 表',
    command: /^\/?interface\s+bridge\s+host\b/i,
    detect: (lines) => has(lines, 'mac-address') && has(lines, 'on-interface'),
    parse(b, emit, ignore = noop) {
      parseRows(b, ignore).forEach((r) => {
        const kv = r.kv;
        if (!kv['mac-address'] || !kv['on-interface']) return;
        settle(r, ignore);
        if (r.flags.includes('L')) { emit({ t: 'ownMac', mac: kv['mac-address'], ifc: kv['on-interface'], line: r.line }); return; } // L：設備自己的 MAC，不是學到的位置
        // 沒有 D（dynamic）旗標的是手動設定的靜態項目
        emit({ t: 'mac', vlan: kv.vid && kv.vid !== '0' ? kv.vid : null, mac: kv['mac-address'], ifc: kv['on-interface'], static: !r.flags.includes('D'), line: r.line });
      });
    },
  });

  // ================================================================ Bridge VLAN 實際成員
  reg({
    id: 'mikrotik.vlans', vendor: VENDOR, dataType: 'vlans', label: 'RouterOS VLAN 成員',
    command: /^\/?interface\s+bridge\s+vlan\b/i,
    detect: (lines) => has(lines, 'vlan-ids') && has(lines, 'bridge') && (has(lines, 'tagged') || has(lines, 'untagged') || has(lines, 'current-tagged')),
    parse(b, emit, ignore = noop) {
      parseRows(b, ignore).forEach((r) => {
        const kv = r.kv; const ids = S.util.vlanTokens(kv['vlan-ids'] || ''); if (!ids.length) return;
        settle(r, ignore);
        const tagged = 'current-tagged' in kv ? list(kv['current-tagged']) : list(kv.tagged);
        const untagged = 'current-untagged' in kv ? list(kv['current-untagged']) : list(kv.untagged);
        ids.forEach((id) => {
          emit({ t: 'vlan', id: +id, name: null, desc: r.comment || undefined, line: r.line });
          tagged.forEach((ifc) => emit({ t: 'vmem', vlan: String(id), ifc, tagged: true, active: true, src: 'state', line: r.line }));
          untagged.forEach((ifc) => emit({ t: 'vmem', vlan: String(id), ifc, active: true, src: 'state', line: r.line }));
        });
      });
    },
  });

  // ================================================================ 介面狀態
  reg({
    id: 'mikrotik.interface', vendor: VENDOR, dataType: 'ifstatus', label: 'RouterOS 介面狀態',
    command: /^\/?interface\s+print\b/i,
    detect: (lines) => has(lines, 'name') && has(lines, 'type') && has(lines, 'mtu'),
    parse(b, emit, ignore = noop) {
      parseRows(b, ignore).forEach((r) => {
        const kv = r.kv; if (!kv.name) return;
        settle(r, ignore);
        const f = { t: 'ifc', ifc: kv.name, status: r.flags.includes('R') ? 'up' : 'down', line: r.line };
        f.enabled = !r.flags.includes('X');
        const desc = kv.comment || r.comment; if (desc) f.desc = desc;
        if (kv.type) f.rawType = kv.type.toLowerCase();
        if (kv['mac-address']) f.hwMac = kv['mac-address'];
        if (kv['default-name']) f.defaultName = kv['default-name'];
        ['mtu', 'actual-mtu', 'l2mtu'].forEach((k) => { if (/^\d+$/.test(kv[k] || '')) f[k.replace(/-(\w)/, (_, c) => c.toUpperCase())] = +kv[k]; });
        emit(f);
      });
    },
  });

  // ================================================================ IP 位址
  reg({
    id: 'mikrotik.ipaddr', vendor: VENDOR, dataType: 'ipaddr', label: 'RouterOS IP 位址',
    command: /^\/?ip\s+address\b/i,
    detect: (lines) => lines.some((l) => /(^|\s)address=\d+\.\d+\.\d+\.\d+\/\d+/.test(l)) && has(lines, 'network') && has(lines, 'interface'),
    parse(b, emit, ignore = noop) {
      parseRows(b, ignore).forEach((r) => {
        const kv = r.kv;
        if (!kv.address || !kv.interface || !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(kv.address)) return;
        if (/[XI]/.test(r.flags)) { settle(r, ignore, '停用或無效的項目'); return; }
        settle(r, ignore);
        // vrf=：RouterOS 7 的 print detail 由設備回報位址所在的 VRF（唯讀欄位）；位址屬於 actual-interface（設在 bridge port 上的位址屬於 bridge）
        const f = { t: 'ifc', ifc: kv['actual-interface'] || kv.interface, ip: kv.address, line: r.line };
        if (kv.vrf) f.vrf = kv.vrf;
        emit(f);
      });
    },
  });

  // ================================================================ ARP
  reg({
    id: 'mikrotik.arp', vendor: VENDOR, dataType: 'arp', label: 'RouterOS ARP 表',
    command: /^\/?ip\s+arp\b/i,
    detect: (lines) => has(lines, 'mac-address') && has(lines, 'complete') && has(lines, 'interface'),
    parse(b, emit, ignore = noop) {
      parseRows(b, ignore).forEach((r) => {
        const kv = r.kv;
        if (!kv.address || !IPRE.test(kv.address)) return;
        if (/[XI]/.test(r.flags)) { settle(r, ignore, '停用或無效的項目'); return; }
        // 還沒解析出 MAC 的項目（手冊：status 為 incomplete／failed 時沒有 mac-address）
        if (!kv['mac-address']) { settle(r, ignore, '沒有 MAC 的未完成項目'); return; }
        if (kv.address.startsWith('169.254.') || /^(22[4-9]|23\d)\./.test(kv.address)) { settle(r, ignore, 'link-local 或 multicast 位址'); return; }
        settle(r, ignore);
        const f = { t: 'arp', ifc: kv.interface, ip: kv.address, mac: kv['mac-address'], line: r.line };
        if (kv.vrf) f.vrf = kv.vrf; // RouterOS 7：設備回報的 VRF
        emit(f);
      });
    },
  });

  // ================================================================ VRF（/ip vrf print detail，RouterOS 7）
  /*
   * 手冊 VRF：「Flags: X - disabled; * - builtin」，每列 name=、interfaces=；依序比對介面，內建的 main 是 interfaces=all。
   * 和 export 不同，print 列出 main 的位置（main 排在前面時，後面的 VRF 拿不到介面）。停用（X）的列照樣記下、不比對介面。
   * RouterOS 6 沒有這個選單（VRF 在 export 的 /ip route vrf），執行時只有錯誤訊息，由 pipeline 列為 I01。
   */
  reg({
    id: 'mikrotik.vrf', vendor: VENDOR, dataType: 'vrf', label: 'RouterOS VRF',
    command: /^\/?ip\s+vrf\b/i,
    detect: (lines) => has(lines, 'name') && has(lines, 'interfaces') && !has(lines, 'dst-address') && !has(lines, 'mtu') && !has(lines, 'type'),
    parse(b, emit, ignore = noop) {
      parseRows(b, ignore).forEach((r) => {
        const kv = r.kv;
        if (!kv.name || !('interfaces' in kv)) return; // 缺欄位：留給 I03
        settle(r, ignore);
        emit({ t: 'vrf', name: kv.name, interfaces: list(kv.interfaces), disabled: r.flags.includes('X'), builtin: r.flags.includes('*'), source: 'print', line: r.line });
      });
    },
  });

  // ================================================================ 路由
  /*
   * 所有路由表的路由都是事實（ADR-015，RouterOS 7；非作用中的另標 active false）：routing-table=（main 也會寫出；沒寫時為 main）。
   * 路由表對應到哪個 VRF 由 model 依 /ip vrf 判斷；沒有對應 VRF 的路由表（策略路由）照樣保留。
   * gateway 的寫法（https://manual.mikrotik.com/docs/cli-reference/ip/route.md 只列出欄位；@ 的意義見 VRF 手冊的路由洩漏）：IP、IP%介面、介面，
   * 後面可以再接 @<VRF>，表示在那個 VRF 解析閘道。
   * 下一跳的 vrf 只記寫出來的 @<VRF>（沒寫為 null）；沒寫時在哪裡解析由 model 依版本的規則決定。
   */
  const splitAt = (s) => { const i = s.lastIndexOf('@'); return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1) || null]; };
  reg({
    id: 'mikrotik.route', vendor: VENDOR, dataType: 'route', label: 'RouterOS 路由表',
    command: /^\/?ip\s+route\b/i,
    detect: (lines) => has(lines, 'dst-address') && (has(lines, 'gateway') || has(lines, 'immediate-gw')),
    parse(b, emit, ignore = noop) {
      parseRows(b, ignore).forEach((r) => {
        const kv = r.kv; const m = String(kv['dst-address'] || '').match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
        if (!m) return;
        // 旗標（https://manual.mikrotik.com/docs/cli-reference/ip/route.md）：X 停用、A 作用中；沒有 A 的是非作用中（例如備援的預設路由，閘道不通或 distance 較大），
        // 照樣記下（active false），查詢層的 Q.routesOf 等只給作用中的路由；停用的路由不是設定中會生效的路由，略過
        if (r.flags.includes('X')) { settle(r, ignore, '停用的路由'); return; }
        const distance = /^\d+$/.test(kv.distance || '') ? +kv.distance : null;
        const table = { routingTable: kv['routing-table'] || 'main', active: r.flags.includes('A') };
        // 黑洞／不可達／禁止：RouterOS 6 為 B／U／P 旗標或 type=；RouterOS 7 是列中單獨的 blackhole 字（手冊的 switch 參數，不是 key=value），
        // 可能折到續行的行首；設了 blackhole 時 gateway 照樣列出，但 immediate-gw 是空的，不轉送
        if (/[BUP]/.test(r.flags) || r.words.includes('blackhole') || /^(blackhole|unreachable|prohibit)$/i.test(kv.type || kv.gateway || '')) {
          emit(Object.assign({ t: 'route', prefix: m[1], len: +m[2], proto: 'Blackhole', nh: [], blackhole: true, distance, line: r.line }, table));
          settle(r, ignore);
          return;
        }
        const f = r.flags;
        const proto = /[cC]/.test(f) ? 'Direct' : f.includes('o') ? 'OSPF' : f.includes('b') ? 'BGP' : /[sS]/.test(f) ? 'Static' : f.includes('d') ? 'DHCP' : f.includes('r') ? 'RIP' : f.includes('v') ? 'VPN' : 'Other';
        const gws = list(kv.gateway); const igws = list(kv['immediate-gw']); const nh = [];
        gws.forEach((g, idx) => {
          const [g0, vrf] = splitAt(g);
          const [gip, gif] = g0.split('%');
          if (IPRE.test(gip)) {
            let ifc = gif || null;
            if (!ifc) { const ig = igws[idx] || igws[0]; if (ig && ig.includes('%')) ifc = splitAt(ig.split('%')[1])[0]; }
            nh.push({ ip: gip, ifc, vrf });
          } else if (gip && !/^(blackhole|unreachable|prohibit)$/i.test(gip)) nh.push({ ip: null, ifc: gip, vrf });
        });
        if (!nh.length) return;
        // check-gateway（arp／ping／bfd）：沒設定時不列出（手冊標為可 unset）；none 也視為沒設定
        const cg = kv['check-gateway'] && kv['check-gateway'] !== 'none' ? kv['check-gateway'] : null;
        emit(Object.assign({ t: 'route', prefix: m[1], len: +m[2], proto, nh, distance, checkGateway: cg, line: r.line }, table));
        settle(r, ignore);
      });
    },
  });

  // ================================================================ 防火牆命中次數（print stats）
  /*
   * /ip firewall filter|nat|raw、/ipv6 firewall filter|raw 的 print stats detail：每個表一個 adapter（同一設備、同一個 adapter 只採用最後一個區塊，
   * 五個表若共用一個 adapter 會互相覆蓋）。依手冊（firewall/common-firewall-matchers-and-actions「Stats」）：
   *  - bytes、packets 是收集當下的累積值；RouterOS 7 以空白分千位（bytes=50 507 925 242），RouterOS 6 是純數字。值可能超過 2^53，以十進位字串保存。
   *  - D 旗標是動態規則（FastTrack 的 dummy rule、UPnP 等），export 沒有，對應規則時由 model 去掉；X 是停用、I 是 invalid（照樣佔序位）。
   * 每一列產生 fwStat；另產生一筆 fwStatTable（行號是說明行或第一列），讓「只有說明行、沒有規則」的表也算已收集、0 列。
   * 只有錯誤訊息（例如沒有 ipv6 套件時 bad command name）不產生任何事實，由 pipeline 列為 I01。
   * 對應到 export 的規則在 model（numberFirewallRules 之後），不用 print 的編號（手冊：編號由 print 指派，每次可能不同）。
   */
  const FW_STAT_TABLES = [['ip', 'filter'], ['ip', 'nat'], ['ip', 'raw'], ['ipv6', 'filter'], ['ipv6', 'raw']];
  // 千位的空白：等號後的數字串（\d{1,3}( \d{3})+），去掉空白再交給 kvOf
  const STAT_NUM = /\b(bytes|packets)=(\d{1,3}(?: \d{3})+|\d+)(?=\s|$)/g;
  const statLine = (l) => l.replace(STAT_NUM, (_, k, v) => `${k}=${v.replace(/ /g, '')}`);

  /*
   * 表格格式：RouterOS 7 的 print stats 即使加了 detail，實機輸出仍是表格（tests/fixtures/real/7.x-defconf-fwstats.txt）：
   *  - `Flags:`、`Columns: CHAIN, ACTION, BYTES, PACKETS` 說明行，`#` 開頭的表頭（欄名全大寫）；
   *  - 資料列「序號 旗標 欄…」：表頭中 `#` 到第一個欄名之間是序號與旗標（有旗標時這段會留出寬度，
   *    手冊 bridge VLAN 表的 print 範例同樣如此）；欄與欄之間至少兩個空白，數字靠右、以單一空白分千位；
   *  - `;;; 註解` 在列的前一行；太長時依終端寬度硬切成數行，續行沒有 `;;;`，接起來不加空白；
   *  - 手冊 Stats 範例的舊排法：註解接在「序號 旗標」之後，欄位在下一行。
   * 欄名以表頭為準（實際的順序），沒有表頭才用 Columns。序號與旗標以表頭的位置切出（這一段只有數字與旗標字元，
   * 不受註解或欄值中全形字的寬度影響）；其餘以兩個以上空白切欄。切不出與欄名相同數目的列不產生事實，留給 I03。
   */
  const TABLE_HEAD = /^\s*#\s+[A-Z][A-Z0-9-]*(?:\s+[A-Z][A-Z0-9-]*)*\s*$/;
  const STAT_COUNT = /^\d{1,3}(?: \d{3})*$/;
  // 看起來是資料列（序號後有以兩個以上空白分開的欄）：不能當註解的續行吞掉
  const looksRow = (line) => /^\s*\d+\s/.test(line) && /\S\s{2,}\S/.test(line);
  function statTableRows(b, ignore) {
    const flagChars = new Set(); let columns = null; let head = null; let start = null;
    b.lines.forEach((raw) => {
      const line = raw.replace(/\r$/, '');
      const fl = line.match(/^\s*Flags:\s*(.*)$/i);
      if (fl) { const re = /(?:^|[;,\s])([A-Za-z*])\s*-/g; let m; while ((m = re.exec(fl[1]))) flagChars.add(m[1]); return; }
      const co = line.match(/^\s*Columns:\s*(.*)$/i);
      if (co) { if (!columns) columns = co[1].split(',').map((s) => s.trim()).filter(Boolean); return; }
      if (!head && TABLE_HEAD.test(line)) { head = line.trim().slice(1).trim().split(/\s+/); start = line.search(/[A-Z]/); }
    });
    const names = (head || columns || []).map((x) => x.toLowerCase());
    const allFlags = (s) => Array.from(s).every((ch) => (flagChars.size ? flagChars.has(ch) : /[A-Z*]/.test(ch)));
    const kvFrom = (fields) => {
      const kv = {};
      names.forEach((nm, k) => { const v = fields[k]; kv[nm] = (nm === 'bytes' || nm === 'packets') && STAT_COUNT.test(v) ? v.replace(/ /g, '') : v; });
      return kv;
    };
    const cells = (text) => text.trim().split(/\s{2,}/);
    /** 一行 → { idx, flags, fields（欄值；註解接在序號之後時是 null）, comment }；不是資料列時 null */
    const split = (line) => {
      let idx; let flags = ''; let rest;
      const pre = start !== null ? /^\s*(\d+)((?:\s+\S+)*)\s*$/.exec(line.slice(0, start)) : null;
      if (pre && allFlags(pre[2].replace(/\s+/g, ''))) { idx = pre[1]; flags = pre[2].replace(/\s+/g, ''); rest = line.slice(start); }
      else { const m = /^\s*(\d+)\s+(\S.*)$/.exec(line); if (!m) return null; idx = m[1]; rest = m[2]; }
      const t = rest.trim();
      if (t.startsWith(';;;')) return { idx, flags, fields: null, comment: t.slice(3).trim() };
      const fields = cells(t);
      // 旗標的另一種位置（表頭沒有為旗標留寬度）：旗標成為第一格，或與第一欄只隔一個空白
      if (fields.length === names.length + 1 && allFlags(fields[0])) flags += fields.shift();
      else if (fields.length === names.length && !flags && flagChars.size) {
        const m = /^(\S+) (\S.*)$/.exec(fields[0]);
        if (m && allFlags(m[1])) { flags = m[1]; fields[0] = m[2]; }
      }
      return fields.length === names.length ? { idx, flags, fields, comment: null } : null;
    };
    const rows = []; let note = null; let open = null; let inLegend = false;
    b.lines.forEach((raw, i) => {
      const line = raw.replace(/\r$/, ''); const t = line.trim(); const n = at(b, i);
      if (!t) return;
      if (/^(Flags|Columns):/i.test(t)) { inLegend = /^Flags:/i.test(t); ignore(n, '說明行'); return; }
      if (inLegend && LEGEND_MORE.test(t)) { ignore(n, '說明行'); return; }
      inLegend = false;
      if (TABLE_HEAD.test(line)) { ignore(n, '表頭'); return; }
      if (t.startsWith(';;;')) { note = { text: line.slice(line.indexOf(';;;') + 3).replace(/^\s+/, ''), lines: [n] }; open = null; return; }
      const s = names.length ? split(line) : null;
      if (s && s.fields) {
        rows.push({ idx: s.idx, flags: s.flags, kv: kvFrom(s.fields), comment: note ? note.text.trim() : null, line: n, lines: note ? note.lines.concat(n) : [n] });
        note = null; open = null; return;
      }
      if (s) { open = { idx: s.idx, flags: s.flags, kv: {}, comment: s.comment, line: n, lines: [n] }; rows.push(open); note = null; return; }
      // 舊排法的欄位行（沒有序號）
      if (open && !/^\s*\d+\s/.test(line) && cells(t).length === names.length) { Object.assign(open.kv, kvFrom(cells(t))); open.lines.push(n); open = null; return; }
      // 切不出欄位的資料列：連同它的註解留給 I03，註解不併進註解、也不轉給下一列
      if (looksRow(line)) { note = null; open = null; return; }
      // 註解的續行：依終端寬度硬切，原樣接上
      if (note) { note.text += line; note.lines.push(n); return; }
      if (open) { open.comment += line; open.lines.push(n); }
    });
    return rows;
  }
  FW_STAT_TABLES.forEach(([family, table]) => reg({
    id: `mikrotik.fwstats.${family}-${table}`, vendor: VENDOR, dataType: 'fwstats', label: `RouterOS 防火牆命中次數（${family === 'ip' ? 'IPv4' : 'IPv6'} ${table}）`,
    command: new RegExp(`^\\/?${family}\\s+firewall\\s+${table}\\s+print\\b.*\\bstats\\b`, 'i'),
    detect: () => false, // 內容看不出是哪個表（filter 與 raw 都有 output chain），只依區塊標記的指令辨識
    family, table,
    parse(b, emit, ignore = noop) {
      let legend = null; let tabular = false;
      b.lines.forEach((l, i) => {
        const head = /^\s*(Flags|Columns):/i.test(l) || TABLE_HEAD.test(l);
        if (head && legend === null) legend = at(b, i);
        if (head && !/^\s*Flags:/i.test(l)) tabular = true;
      });
      const rows = tabular ? statTableRows(b, ignore) : parseRows({ lines: b.lines.map(statLine), origin: b.origin }, ignore);
      let first = null;
      rows.forEach((r) => {
        const kv = r.kv;
        if (!kv.chain || !/^\d+$/.test(kv.bytes || '') || !/^\d+$/.test(kv.packets || '')) return; // 缺欄位：留給 I03
        settle(r, ignore);
        if (first === null) first = r.line;
        emit({ t: 'fwStat', family, table, flags: r.flags, chain: kv.chain, action: kv.action || 'accept', comment: r.comment, bytes: kv.bytes.replace(/^0+(?=\d)/, ''), packets: kv.packets.replace(/^0+(?=\d)/, ''), line: r.line });
      });
      const line = legend !== null ? legend : first;
      if (line !== null) emit({ t: 'fwStatTable', family, table, line });
    },
  }));
  S.adapters.mikrotikStatLine = statLine; // 測試用

  // ================================================================ OSPF 鄰居
  /*
   * https://manual.mikrotik.com/docs/cli-reference/routing/ospf/neighbor.md：address 是鄰居的 IPv4 或 IPv6 位址（OSPFv3 是鄰居介面的 link-local 位址），
   * router-id 不論 OSPF 版本都是 IPv4 格式的 ID（不是位址）。family 記鄰居位址的位址族，model 只用 IPv4 位址找介面與網段。
   */
  reg({
    id: 'mikrotik.ospf', vendor: VENDOR, dataType: 'ospf', label: 'RouterOS OSPF 鄰居',
    command: /^\/?routing\s+ospf\s+neighbou?r\b/i,
    detect: (lines) => has(lines, 'router-id') && has(lines, 'state') && lines.some((l) => /(^|\s)address=[\da-f]/i.test(l)),
    parse(b, emit, ignore = noop) {
      parseRows(b, ignore).forEach((r) => {
        const kv = r.kv; const addr = kv.address || '';
        const family = IPRE.test(addr) ? 'ipv4' : S.ip.v6ToBig(addr) !== null ? 'ipv6' : null;
        if (!family || !IPRE.test(kv['router-id'] || '')) return;
        settle(r, ignore);
        emit({ t: 'ospf', nbrAddr: addr, family, nbrId: kv['router-id'], state: kv.state || '', ifc: kv.interface || null, line: r.line });
      });
    },
  });

  // ================================================================ Wi-Fi 關聯表（客戶端關聯在哪個無線介面）
  /** RouterOS 時間長度（1w2d3h4m5s120ms，或 hh:mm:ss 前面可加 w、d：01:02:03、15d04:05:06、1w2d03:04:05）→ 秒；格式不符回傳 null。 */
  function duration(text) {
    const t = String(text || '').trim(); if (!t) return null;
    const hms = t.match(/^(?:(\d+)w\s*)?(?:(\d+)d\s*)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if (hms) return (+hms[1] || 0) * 604800 + (+hms[2] || 0) * 86400 + hms[3] * 3600 + hms[4] * 60 + +hms[5];
    const UNIT = { w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001, us: 1e-6 };
    let sec = 0; let rest = t; let m;
    const re = /^(\d+(?:\.\d+)?)(ms|us|w|d|h|m|s)/;
    while (rest && (m = re.exec(rest))) { sec += m[1] * UNIT[m[2]]; rest = rest.slice(m[0].length); }
    return rest ? null : sec;
  }
  S.adapters.mikrotikDuration = duration; // 測試用
  const dbm = (v) => { const m = String(v || '').match(/^(-?\d+)/); return m ? +m[1] : null; };
  reg({
    id: 'mikrotik.wifireg', vendor: VENDOR, dataType: 'wifireg', label: 'RouterOS Wi-Fi 關聯表',
    command: /^\/?(interface\s+(wifi|wireless)\s+registration-table|caps-man\s+registration-table)\b/i,
    detect: (lines) => has(lines, 'mac-address') && has(lines, 'interface') && has(lines, 'uptime') && (has(lines, 'last-activity') || has(lines, 'rx-signal')),
    parse(b, emit, ignore = noop) {
      // eap-identity、eap-username 是使用者帳號（個資），刻意不讀取；原文仍在收集檔，見 docs/收集清單與輸入格式.md
      let rows = 0; const handled = new Set();
      const mark = (n, why) => { handled.add(n); ignore(n, why); };
      parseRows(b, mark).forEach((r) => {
        const kv = r.kv;
        if (!kv['mac-address'] || !kv.interface) return;
        if (kv.ap === 'yes' || kv.ap === 'true') { settle(r, mark, '對端是 AP，不是客戶端'); return; } // 舊版 wireless：WDS／站台模式
        settle(r, ignore);
        rows++;
        emit({
          t: 'assoc', ifc: kv.interface, mac: kv['mac-address'], ssid: kv.ssid || null, band: kv.band || null,
          vlan: /^\d+$/.test(kv['vlan-id'] || '') ? +kv['vlan-id'] : null,
          uptime: duration(kv.uptime), lastActivity: duration(kv['last-activity']),
          signal: dbm(kv.signal ?? kv['signal-strength'] ?? kv['rx-signal']),
          ip: [kv['dhcp-address'], kv['last-ip']].find((x) => x && IPRE.test(x)) || null, hostname: kv['dhcp-hostname'] || null,
          line: r.line,
        });
      });
      // 沒有客戶端時表格只有說明行（或只有對端 AP）：記為「已收集、0 筆」，避免被當成無法辨識。
      // 有任何其他內容（RouterOS 錯誤訊息、雜訊）時不記，整段由 I01 呈現。事實指向第一個說明行。
      const content = b.lines.map((l, i) => (l.trim() ? at(b, i) : null)).filter((n) => n !== null);
      if (!rows && content.every((n) => handled.has(n))) emit({ t: 'assocTable', rows: 0, line: content.length ? content[0] : b.origin.startLine });
    },
  });

  // ================================================================ RSTP 狀態（monitor once）
  /**
   * monitor 一次列出多個項目時是欄式輸出：每行「key: 值1 值2 …」，冒號對齊，第一行 interface（或 name）決定欄數與每欄的起始位置。
   * 官方手冊的範例裡，某些欄位只有部分埠有值（例如 designated-port 的 designated-bridge-id 是空白），
   * 所以依起始位置切欄；冒號沒有對齊的行（例如手寫資料）才退回以空白切開，且數量必須等於欄數。
   * consumed(行號)：有讀進欄位的行（不是 key: 的行、值的數量對不上欄數的行不算，留給 I03）。
   */
  function monitorColumns(b, consumed) {
    const use = consumed || (() => {});
    let starts = null; let valueAt = -1; let colonAt = -1; const out = [];
    b.lines.forEach((raw, i) => {
      const line = raw.replace(/\r$/, '');
      const m = line.match(/^((\s*[\w-]+):\s*)(.*?)\s*$/); if (!m) return;
      const key = m[2].trim(); const at0 = m[1].length; const colon = m[2].length;
      if (!starts && (key === 'interface' || key === 'name')) {
        starts = []; const re = /\S+/g; let t;
        while ((t = re.exec(m[3]))) { starts.push(at0 + t.index); out.push({ [key]: t[0], _line: at(b, i) }); }
        valueAt = at0; colonAt = colon; use(at(b, i)); return;
      }
      // 只監看一個項目（例如 /interface bridge monitor bridge1）時沒有 interface／name 行：整段是單一欄
      if (!starts) { starts = [at0]; valueAt = at0; colonAt = colon; out.push({ _line: at(b, i) }); }
      // 冒號對齊：第一欄是空白時值會從後面的欄開始（手冊範例的 last-topology-change），仍依起始位置切欄
      if (at0 === valueAt || !m[3] || (colon === colonAt && at0 > valueAt)) {
        starts.forEach((st, k) => { const v = line.slice(st, k + 1 < starts.length ? starts[k + 1] : undefined).trim(); if (v) out[k][key] = v; });
        use(at(b, i));
      } else {
        const vals = m[3].split(/\s+/);
        if (vals.length === starts.length) { vals.forEach((v, k) => { out[k][key] = v; }); use(at(b, i)); }
      }
    });
    return out;
  }
  S.adapters.mikrotikMonitorColumns = monitorColumns; // 測試用
  /*
   * monitor 輸出最前面的 ;;; 行是各項目的 comment（bridge port、bridge 的註解，多欄時對齊各欄；太長時折成幾行、每行都有 ;;;），
   * 不是 monitor 的欄位（https://manual.mikrotik.com/docs/cli-reference/interface/bridge/port/monitor.md 沒有 comment），註解另由 export、/interface print 取得。
   * 有讀到 RSTP 欄位時才列為可忽略；整段認不得時連同註解留給 I03。
   */
  const monitorComments = (b, ignore) => b.lines.forEach((l, i) => { if (/^\s*;;;/.test(l)) ignore(at(b, i), '項目的註解（不是 monitor 的欄位）'); });
  const bridgeIdMac = (v) => { const m = String(v || '').match(/([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i); return m ? m[1] : null; };
  const yes = (v) => (v == null ? null : v === 'yes' || v === 'true');
  // 埠與 bridge 的 monitor 分成兩個解析器：同一設備同一解析器出現兩次時只採用最後一次（I02）
  reg({
    id: 'mikrotik.stp', vendor: VENDOR, dataType: 'stp', label: 'RouterOS RSTP 埠狀態',
    command: /^\/?interface\s+bridge\s+port\s+monitor\b/i,
    detect: (lines) => lines.some((l) => /^\s*(role|designated-bridge(-id)?):/.test(l)),
    parse(b, emit, ignore = noop) {
      const fields = []; let marked = false;
      monitorColumns(b, (n) => fields.push(n)).forEach((c) => {
        if (c.role === undefined && c['designated-bridge-id'] === undefined && c['designated-bridge'] === undefined) return;
        if (!marked) { fields.forEach((n) => ignore(n, '同一筆的其他欄位')); monitorComments(b, ignore); marked = true; }
        const portNo = c['port-number'] || (String(c['port-id'] || '').match(/(\d+)$/) || [])[1];
        const dPort = c['designated-port-number'] || (String(c['designated-port-id'] || '').match(/(\d+)$/) || [])[1];
        emit({ t: 'stpPort', ifc: c.interface, role: c.role || null, portNumber: portNo ? +portNo : null,
          designatedBridge: bridgeIdMac(c['designated-bridge-id'] || c['designated-bridge']), designatedPort: dPort ? +dPort : null,
          edge: yes(c['edge-port']), sendingRstp: yes(c['sending-rstp']), line: c._line });
      });
    },
  });
  reg({
    id: 'mikrotik.stpbridge', vendor: VENDOR, dataType: 'stp', label: 'RouterOS RSTP bridge 狀態',
    command: /^\/?interface\s+bridge\s+monitor\b/i,
    detect: (lines) => lines.some((l) => /^\s*(root-bridge-id|current-mac-address):/.test(l)),
    parse(b, emit, ignore = noop) {
      const fields = []; let marked = false;
      monitorColumns(b, (n) => fields.push(n)).forEach((c) => {
        if (!(c['current-mac-address'] || c['root-bridge-id'])) return;
        if (!marked) { fields.forEach((n) => ignore(n, '同一筆的其他欄位')); monitorComments(b, ignore); marked = true; }
        emit({ t: 'stpBridge', ifc: c.name || c.interface, mac: c['current-mac-address'] || null, rootBridge: bridgeIdMac(c['root-bridge-id']), isRoot: yes(c['root-bridge']), line: c._line });
      });
    },
  });

  // ================================================================ 系統資訊
  reg({
    id: 'mikrotik.system', vendor: VENDOR, dataType: 'system', label: 'RouterOS 系統資訊',
    command: /^\/?system\s+(resource|identity)\b/i,
    detect: (lines) => lines.some((l) => /^\s*board-name:/.test(l)),
    parse(b, emit, ignore = noop) {
      const identity = /identity/i.test(b.command || '');
      b.lines.forEach((l, i) => {
        let m;
        if ((m = l.match(/^\s*board-name:\s*(.+?)\s*$/))) emit({ t: 'sys', board: m[1], line: at(b, i) });
        else if ((m = l.match(/^\s*version:\s*(.+?)\s*$/))) emit({ t: 'sys', version: m[1], line: at(b, i) });
        else if (!identity && (m = l.match(/^\s*uptime:\s*(.+?)\s*$/))) { const sec = duration(m[1]); if (sec !== null) emit({ t: 'sys', uptime: sec, line: at(b, i) }); } // 認不得的格式留給 I03，不猜
        else if (identity && (m = l.match(/^\s*name:\s*(.+?)\s*$/))) emit({ t: 'hostname', name: m[1], line: at(b, i) });
        else if (/^\s*[\w-]+:(\s|$)/.test(l)) ignore(at(b, i), '未使用的欄位'); // print 的「key: value」格式，其他欄位（cpu、memory…）不需要
      });
    },
  });

  // ================================================================ RouterBOARD 韌體
  // /system routerboard print（key: value，同 /system resource）。依據：
  //   https://manual.mikrotik.com/docs/hardware/routerboard.md（print 範例；upgrade-firmware 比 current-firmware 新代表有待套用的 RouterBOOT）
  //   https://manual.mikrotik.com/docs/cli-reference/system/routerboard.md（欄位；Conditions: !i386 —— x86／CHR 沒有這個選單）
  // minimum-firmware 是出廠的韌體版本，RouterOS 6 稱為 factory-firmware。
  // serial-number 不寫入基準：序號可識別實體設備，基準會隨工作包分享（隱私考量；畫面與報表都用不到）。
  // 沒有這個選單時 RouterOS 回「bad command name routerboard」：這一行本身就是「不是 RouterBOARD」的事實，所以產生事實，
  // 其他錯誤（權限不足、語法錯誤）不在此列，照常成為 I01／I03。
  const RB_FIELDS = { routerboard: 'isRouterboard', model: 'model', 'firmware-type': 'firmwareType', 'minimum-firmware': 'factoryFirmware',
    'factory-firmware': 'factoryFirmware', 'current-firmware': 'currentFirmware', 'upgrade-firmware': 'upgradeFirmware' };
  reg({
    id: 'mikrotik.routerboard', vendor: VENDOR, dataType: 'routerboard', label: 'RouterBOARD 韌體',
    command: /^\/?system\s+routerboard\s+print\b/i,
    detect: (lines) => lines.some((l) => /^\s*routerboard:\s*(yes|no)\s*$/.test(l)) && lines.some((l) => /^\s*(current-firmware|model):/.test(l)),
    parse(b, emit, ignore = noop) {
      // 設備的提示訊息：欄位前的 ;;; 行，太長時折成幾行、每行都有 ;;;，以空白接回一句。手冊 routerboard.md：upgrade 之後的訊息是
      // 「Firmware upgraded successfully, please reboot for changes to take effect!」（韌體已寫入，重新開機才生效）；同頁 settings print 的範例也以 ;;; 顯示提示
      const notes = [];
      b.lines.forEach((l, i) => { const m = l.match(/^\s*;;;\s?(.*?)\s*$/); if (m) notes.push({ text: m[1], line: at(b, i) }); });
      if (notes.length) {
        emit({ t: 'rb', field: 'notice', value: notes.map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim(), line: notes[0].line });
        notes.slice(1).forEach((x) => ignore(x.line, '續行'));
      }
      b.lines.forEach((l, i) => {
        let m;
        if (/^\s*;;;/.test(l)) return;
        if (/^\s*bad command name routerboard\b/i.test(l)) emit({ t: 'rb', field: 'isRouterboard', value: false, noMenu: true, line: at(b, i) });
        else if ((m = l.match(/^\s*([\w-]+):\s*(.*?)\s*$/)) && RB_FIELDS[m[1]] && m[2]) {
          const field = RB_FIELDS[m[1]];
          if (field === 'isRouterboard') { if (/^(yes|no)$/.test(m[2])) emit({ t: 'rb', field, value: m[2] === 'yes', line: at(b, i) }); }
          else emit({ t: 'rb', field, value: m[2], line: at(b, i) });
        } else if (/^\s*serial-number:/.test(l)) ignore(at(b, i), '序號不寫入基準（隱私）');
        else if (/^\s*[\w-]+:(\s|$)/.test(l)) ignore(at(b, i), '未使用的欄位'); // board-name、revision…
      });
    },
  });
})(globalThis.SSOT = globalThis.SSOT || {});
