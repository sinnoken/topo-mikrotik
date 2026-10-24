/*
 * 檢查規則目錄（CATALOG）：每項規則的編號、嚴重度、類別、標題、需要的資料，以及給使用者看的常見原因與處理方式。
 * 判斷邏輯在 checks.js；兩者以規則編號對應，規則說明見 docs/基準檢查規則.md（tests/docs.js 檢查標題與嚴重度一致）。
 * 必須在 checks.js 之前載入（tools/core-files.js）。
 *
 * 欄位：
 *   severity：error／warn／info；cat：類別；title：畫面上的標題。
 *   data：規則需要的資料類別（設備的 data）。外層每一組都要有，組內任一種即可；沒有 data 的規則（輸入、覆蓋）一律會檢查。
 *         只用來區分「通過」與「沒有資料可檢查」，不影響檢查本身。
 *   evidenceLimit：每筆 finding 最多附幾筆證據，沒寫時用 checks.js 的預設值。
 *   facet：只有「同一組 id＋實體可能產生多筆 finding」的規則才有，說明 finding.facet 的格式（檢查的是哪一個項目）。
 *         有宣告的規則每筆 finding 都帶 facet，沒宣告的都不帶（checks.js 的 add() 檢查）；facet 會進入 findingKey（query.js）。
 *         格式中的 <…> 是取自設定的值（已正規化），其餘是固定字樣；多段以「|」分隔，固定字樣在前。
 *   causes：常見原因，每條一句。action：怎麼處理，可以照著做的步驟。
 *         這兩項只放在 CATALOG（S.check.CATALOG[f.id]），不複製到 finding，也不進 Snapshot。
 */
(function (S) {
  'use strict';
  const CATALOG = {
    // ---- 輸入
    I01: {
      severity: 'error', cat: '輸入', title: '無法辨識的內容',
      causes: [
        '收集檔缺少設備標頭或 `### 指令` 標記，不知道屬於哪台設備或哪個指令。',
        '`print` 沒有加 `detail without-paging`，解析器認得指令但解析不出資料。',
        '收集器註解（`# collected-at:`、`# collection failed:`）的格式或位置不對。',
        '貼入了沒有解析器支援的指令輸出。',
      ],
      action: '依訊息補上設備標頭或指令標記，或改用 `print detail without-paging` 重新收集（格式見收集清單 §2）。修正前這段資料不會進入基準。',
    },
    I02: {
      severity: 'warn', cat: '輸入', title: '同一設備重複提供同類資料（以後者為準）',
      facet: '<adapter id>（例如 mikrotik.arp）',
      causes: [
        '合併多次收集的檔案，同一台設備的同一個指令出現兩次以上。',
        '同一段輸出被重複貼上。',
      ],
      action: '確認最後一份是想要的資料（較早的不會進入基準）；若是合併多次收集造成的，刪除舊的那段。',
    },
    I03: {
      severity: 'warn', cat: '輸入', title: '已解析的區塊中有無法辨識的行',
      causes: [
        '收集檔中混入了其他文字，例如手動編輯時貼入的說明、markdown 標記或另一段輸出。',
        'RouterOS 回傳錯誤訊息（`bad command name`、`syntax error`、`expected end of command`、`no such item`、`failure:` 等），指令可能沒有完整執行。',
        '`print` 沒有加 `without-paging`，輸出夾帶分頁提示。',
        'RouterOS 版本的輸出格式與解析器預期不同，例如某一列缺少必要欄位。',
      ],
      action: '依證據的行號打開收集檔核對：混入的文字刪除後重新載入；RouterOS 錯誤訊息要確認該指令在這個版本可以執行，修正後重新收集。確認是正常的 RouterOS 輸出卻被列出時，把那幾行去識別化後回報給維護者。同一區塊其他已解析的內容仍會進入基準。',
    },
    // ---- 覆蓋
    C01: {
      severity: 'info', cat: '覆蓋', title: '網路設備僅由鄰居發現、沒有收集資料',
      causes: [
        '這台設備還沒加入收集清單。',
        '這台設備不在管理範圍，例如 ISP 端設備。',
        '設備的 identity 與收集檔標頭不同，同一台設備被當成兩台。',
      ],
      action: '若它是應管理的網路設備，把它加入收集清單；不在管理範圍（例如 ISP 端）可以忽略。名稱對不上時，讓 `/system identity` 與收集檔標頭一致（見收集清單 §3）。',
    },
    C02: {
      severity: 'warn', cat: '覆蓋', title: '缺少應收集的資料', evidenceLimit: Infinity, // 列出全部失敗註解與已收集區塊，才能對照收了哪些
      causes: [
        '漏收依設備類型應有的指令，例如 `/ip neighbor`、`/export`、`/interface bridge host`、`/ip route`。',
        '指令或連線收集失敗（收集檔中有 `# collection failed:`），輸出可能不完整。',
        '設備類型推論錯誤，要求的資料也跟著錯。',
      ],
      action: '依訊息補收對應指令（清單見收集清單 §1）；收集失敗時，先查看收集器在終端機列出的錯誤再重收。設備類型判斷錯誤時，用命名規則覆寫類型。',
    },
    // ---- 鏈路
    K01: {
      severity: 'warn', cat: '鏈路', title: 'LLDP 單向（對端沒有回報這條鏈路）', data: [['lldp']],
      causes: [
        '對端的該埠關閉了 LLDP 收送。',
        '兩次收集之間鏈路異動。',
        '中間有不轉送 LLDP 的設備，例如部分媒體轉換器、未管理交換器。',
      ],
      action: '檢查對端該埠的 neighbor discovery 設定（`/ip neighbor discovery-settings` 的 `discover-interface-list`、`protocol`），或重新收集兩端的 `/ip neighbor`。',
    },
    K02: {
      severity: 'warn', cat: '鏈路', title: '同一介面對應到多個鄰居', data: [['lldp']],
      causes: [
        '埠下掛了未管理交換器或集線器。',
        'hypervisor 的虛擬交換器把多台主機的 LLDP 轉出來。',
        '資料在兩次收集之間改變。',
      ],
      action: '到現場或用 MAC 表（`/interface bridge host`）確認該埠下實際接了什麼。確認前，拓樸圖在這個埠的配對不可信。',
    },
    K03: {
      severity: 'warn', cat: '鏈路', title: '聚合鏈路兩端成員不一致', data: [['lldp'], ['config']],
      causes: [
        '兩端 `/interface bonding` 的 `slaves` 設定不同。',
        '有成員埠的線路未接或接錯埠。',
        '一端設了聚合，另一端的埠沒有加入任何聚合介面。',
      ],
      action: '比對兩端 `/interface bonding` 的 `slaves`，並確認每個成員埠的線路都接到對端的成員埠。',
    },
    K04: {
      severity: 'info', cat: '鏈路', title: '對端回報的埠名稱與本機不同', data: [['lldp']],
      causes: [
        '對端的埠改過名稱。',
        '對端 LLDP 的 port ID 送的是描述或預設名稱。',
      ],
      action: '鏈路已採用對端自己回報的埠，通常不需處理。若要確認，查看對端該埠的名稱與 LLDP 設定，再重新收集兩端的 `/ip neighbor`。',
    },
    // ---- VLAN
    V01: {
      severity: 'warn', cat: 'VLAN', title: '鏈路兩端 VLAN 不一致', data: [['lldp'], ['config', 'vlans']],
      causes: [
        '兩端 `/interface bridge vlan` 的成員設得不同，某些 VLAN 只在一端。',
        '兩端 bridge port 的 `pvid` 不同。',
        '一端是路由器介面上的 VLAN 子介面（`/interface vlan`，例如單臂路由），少建、多建或停用了某個 VLAN。',
      ],
      action: '比對兩端的 `/interface bridge vlan` 與 `/interface bridge port` 的 `pvid`，找出訊息中只在一端的 VLAN 並修正。',
    },
    V04: {
      severity: 'warn', cat: 'VLAN', title: '鏈路兩端 native VLAN（PVID）不一致', data: [['lldp'], ['config']],
      causes: [
        '兩端 `/interface bridge port` 的 `pvid` 設得不同。',
        '改了一端的 native VLAN，另一端沒有跟著改。',
      ],
      action: '比對兩端 `/interface bridge port` 的 `pvid` 並改成一致；不一致時，未標記的流量會進到不同 VLAN。',
    },
    V05: {
      severity: 'info', cat: 'VLAN', title: 'VLAN 介面沒有任何成員埠（孤立 VLAN）', data: [['config', 'vlans']],
      causes: [
        'VLAN 已停用，但 `/interface vlan` 沒有刪除。',
        '漏設 bridge VLAN 成員（`/interface bridge vlan` 的 `tagged`／`untagged`）。',
      ],
      action: '確認這個 VLAN 是否還要用：不用就刪除該 `/interface vlan`；要用就在 `/interface bridge vlan` 補上成員埠。',
    },
    V06: {
      severity: 'info', cat: 'VLAN', title: '同一 VLAN 在不同設備的名稱或說明不同', data: [['config']],
      facet: 'vlan-interface-name／vlan-interface-comment／bridge-vlan-comment',
      causes: [
        '各設備各自命名，沒有統一的命名方式。',
        '改名或修改說明時只改了部分設備。',
      ],
      action: '統一 `/interface vlan` 的 `name`、`comment` 與 `/interface bridge vlan` 的 `comment`，讓維運人員在每台設備看到同一個名稱。有推定偏離時，先從偏離的設備查起。',
    },
    V07: {
      severity: 'warn', cat: 'VLAN', title: '同一名稱在不同設備對應到不同 VLAN', data: [['config']],
      facet: '<V06 的屬性>|<名稱或說明（trim、小寫）>',
      causes: [
        '某台設備的 VLAN ID 設錯。',
        '不同站點刻意沿用同一個名稱。',
      ],
      action: '確認是 VLAN ID 設錯，還是不同站點刻意沿用同一個名稱；後者可改用帶站點的名稱。有推定偏離時，先從偏離的設備查起。',
    },
    V08: {
      severity: 'warn', cat: 'VLAN', title: '鏈路兩端同一 VLAN 的 tagged／untagged 不一致', data: [['lldp'], ['config', 'vlans']],
      causes: [
        '一端把這個 VLAN 設成 untagged（access 或 PVID），另一端設成 tagged（trunk）。',
        '只改了一端 `/interface bridge vlan` 的 `tagged`／`untagged` 清單。',
      ],
      action: '比對兩端 `/interface bridge vlan` 的 `tagged`／`untagged` 與 bridge port 的 `pvid`、`frame-types`，改成同一種標記方式；不一致時，這個 VLAN 的流量進到對端會被丟掉或進到 native VLAN。',
    },
    V09: {
      severity: 'info', cat: 'VLAN', title: '鏈路一端在未開 vlan-filtering 的 bridge 上（VLAN 無法比較）', data: [['lldp'], ['config']],
      causes: [
        '這台設備刻意不做 VLAN 過濾，只把 tagged 訊框原樣轉送。',
        '忘了在 bridge 開啟 `vlan-filtering=yes`，`/interface bridge vlan` 與 bridge port 的 `pvid` 因此沒有作用。',
      ],
      action: '確認這個 bridge 是否應該做 VLAN 過濾：要的話先設好 `/interface bridge vlan` 的成員與 bridge port 的 `pvid`，再設定 `vlan-filtering=yes`；刻意透通則不需處理，但這條鏈路的 VLAN 一致性無法由基準確認。',
    },
    // ---- 位址
    A01: {
      severity: 'warn', cat: '位址', title: '同一 IP 對應多個 MAC', data: [['arp']],
      causes: [
        'IP 衝突。',
        'VRRP 或 HA 切換。',
        'proxy ARP。',
        '兩次收集之間 DHCP 位址被重新分配。',
      ],
      action: '用 MAC 的廠商與所在位置（`/ip arp`、`/interface bridge host`）判斷是否為 IP 衝突。',
    },
    A02: {
      severity: 'warn', cat: '位址', title: '同一 MAC 在同一 VLAN 出現在多個終端埠', data: [['mac']],
      facet: '<VLAN ID>，VLAN 不明時為 unknown',
      causes: [
        '同一台主機的兩個網路卡共用 MAC，例如部分 bonding 模式。',
        '虛擬機遷移。',
        'L2 迴圈。',
        'MAC 表在兩次收集之間更新。',
      ],
      action: '查看訊息列出的每個位置（`/interface bridge host`），確認是否為同一台設備；這只是可能的重複或迴圈，需要人工核實。',
    },
    A03: {
      severity: 'info', cat: '位址', title: '介面有學到 MAC 但沒有 LLDP／CDP 鄰接（未知對端）', data: [['mac']],
      causes: [
        '接的是 PC、印表機、IoT 等不送 LLDP 的設備，屬於正常情況。',
        '對端是網路設備，但沒有開啟 LLDP。',
      ],
      action: '多半不需處理。若該埠應該接網路設備，在對端開啟 LLDP（RouterOS 為 `/ip neighbor discovery-settings`）。',
    },
    A04: {
      severity: 'info', cat: '位址', title: '單一埠學到過多 MAC（可能下掛未管理交換器或 hypervisor）', data: [['mac']],
      causes: [
        '埠下掛了未管理交換器。',
        '埠下接了 AP。',
        '埠下接了虛擬化主機（hypervisor）。',
      ],
      action: '到現場確認是否接了未管理交換器、AP 或虛擬化主機；若是網路設備，開啟它的 LLDP 並納入收集。',
    },
    A05: {
      severity: 'info', cat: '位址', title: 'ARP 位址不屬於該設備任何直連網段', data: [['arp'], ['config', 'ipaddr']],
      causes: [
        '主機設錯網段或遮罩。',
        'IP 漂移。',
        'proxy ARP。',
      ],
      action: '用 ARP 的 MAC 找出主機，確認它的位址設定。',
    },
    A06: {
      severity: 'warn', cat: '位址', title: '同一 VLAN 在不同設備設定不同網段', data: [['config']],
      causes: [
        '某台設備 VLAN 介面上的網段或遮罩設錯。',
        '調整網段時只改了部分設備。',
      ],
      action: '比對各設備 VLAN 介面的 `/ip address`，確認哪一台的網段或遮罩設錯並修正；遮罩不同時，兩台設備對廣播位址與直連範圍的認定不同。有推定偏離時，先從偏離的設備查起。',
    },
    A07: {
      severity: 'warn', cat: '位址', title: '同一網段在不同設備屬於不同 VLAN', data: [['config']],
      facet: '<網段 net/len>，非 main 的 VRF 加上 @<VRF>',
      causes: [
        '某台設備的 VLAN ID 設錯。',
        '位址設在錯的 VLAN 介面上。',
        '各站點刻意重用同一個私有網段（不同 VRF 已分開比較；同一個 VRF 內重用仍會列出）。',
      ],
      action: '確認 `/interface vlan` 的 `vlan-id` 或 `/ip address` 是否設錯；同一個網段跨在兩個 VLAN，兩邊的主機無法在 L2 互通。有推定偏離時，先從偏離的設備查起。',
    },
    A08: {
      severity: 'warn', cat: '位址', title: '重疊網段在不同設備的遮罩不同', data: [['config', 'ipaddr']],
      facet: '<最外層的網段 net/len>，非 main 的 VRF 加上 @<VRF>',
      causes: [
        '交換器管理位址的遮罩和閘道不一致。',
        '調整網段大小時只改了部分設備。',
      ],
      action: '確認正確的遮罩並修正 `/ip address`。有推定偏離時，先從偏離的設備查起。',
    },
    A09: {
      severity: 'warn', cat: '位址', title: '同一 IP 位址設定在多台設備', data: [['config', 'ipaddr']],
      causes: [
        'IP 衝突：同一個位址設在兩台設備上。',
        'HA 架構的共用位址沒有設在 VRRP 介面上。',
      ],
      action: 'IP 衝突時，修改其中一台的 `/ip address`；若是 HA 架構，確認位址是否應設在 VRRP 介面（`/interface vrrp`）上。',
    },
    A10: {
      severity: 'warn', cat: '位址', title: '同一名稱在不同設備對應到不同 IP', data: [['config']],
      facet: '<選單路徑>|<名稱（trim、小寫；DHCP lease 為正規化的 MAC）>',
      causes: [
        'HA 成對設備或同一角色的設備之間，清單漏同步。',
        '各設備刻意設定不同的值。',
      ],
      action: '比對各設備的 address-list、DNS static、pool 或 DHCP 靜態租約；HA 成對設備或同一角色的設備應有相同的清單，確認是漏同步還是刻意不同。有推定偏離時，先從偏離的設備查起。',
    },
    A11: {
      severity: 'info', cat: '位址', title: '同一 IP 在不同設備以不同名稱設定', data: [['config']],
      facet: '<選單路徑>|<IP 或網段（正規化）>',
      causes: [
        '各設備各自為同一個位址命名，沒有共同的名稱。',
        '改名時只改了部分設備。',
      ],
      action: '統一名稱，避免兩台設備的防火牆規則或 DNS 對同一個位址有不同認定。有推定偏離時，先從偏離的設備查起。',
    },
    A12: {
      severity: 'warn', cat: '位址', title: '各設備的 DNS／NTP 伺服器設定不同', data: [['config']],
      facet: 'dns／ntp',
      causes: [
        '更換 DNS 或 NTP 伺服器時只改了部分設備。',
        '分層設定（交換器指向核心、核心指向 ISP），可能是刻意的。',
      ],
      action: '統一 `/ip dns` 的 `servers` 與 `/system ntp client` 的伺服器；分層設定需人工判斷是否刻意。NTP 不一致會讓各設備的日誌時間難以對照。有推定偏離時，先從偏離的設備查起。',
    },
    // ---- 路由
    R01: {
      severity: 'info', cat: '路由', title: '路由下一跳不屬於任何已知設備', data: [['route']],
      causes: [
        '下一跳是 ISP。',
        '下一跳是未收集的設備。',
        '缺少對方設備的位址資料。',
      ],
      action: '若下一跳應該是管理範圍內的設備，把它加入收集清單，或補收它的 `/ip address`。',
    },
    R02: {
      severity: 'info', cat: '路由', title: 'OSPF 鄰居無法對應到已收集的設備', data: [['ospf']],
      facet: '<本端介面名稱>',
      causes: [
        'OSPF 鄰居設備沒有收集。',
        '鄰居的 router-id 或介面位址沒有收集到。',
        '鄰居是不在管理範圍的設備，例如 ISP 或其他單位的路由器。',
      ],
      action: '把該鄰居設備加入收集清單，或確認它的 router-id 與介面位址（`/ip address`）是否已收集。',
    },
    R03: {
      severity: 'warn', cat: '路由', title: '路由下一跳形成迴圈', data: [['route']],
      causes: [
        '兩條靜態路由的閘道互相指向。',
        '遞迴路由少了一條。',
      ],
      action: '檢查 `/ip route` 中相關的靜態路由，修正互相指向的閘道或補上缺少的路由。',
    },
    R04: {
      severity: 'warn', cat: '路由', title: '路由下一跳落入黑洞路由', data: [['route']],
      causes: [
        '黑洞路由的範圍太大，涵蓋了下一跳。',
        '路由的下一跳設錯。',
      ],
      action: '在 `/ip route` 確認黑洞路由的範圍是否太大，或下一跳是否設錯。',
    },
    R05: {
      severity: 'warn', cat: '路由', title: 'DHCP 網路的閘道不在該網段內', data: [['config']],
      facet: '<DHCP 網段 net/len>',
      causes: [
        '`/ip dhcp-server network` 的 `gateway` 打錯或沿用其他網段的設定。',
        '網段改過，但閘道沒有跟著改。',
        '閘道使用的 VRRP 虛擬位址和網段不一致。',
      ],
      action: '修正 `/ip dhcp-server network` 的 `gateway`；閘道是 VRRP 虛擬位址時，確認它和網段一致。',
    },
    R06: {
      severity: 'warn', cat: '路由', title: '同一 DHCP 網段在不同設備的閘道、DNS 或 NTP 不同', data: [['config']],
      facet: 'gateway|<網段>／dns|<網段>／ntp|<網段>（<網段> 為 net/len，非 main 的 VRF 加上 @<VRF>）',
      causes: [
        'HA 成對的 DHCP 伺服器設定沒有同步。',
        '只改了其中一台的閘道或伺服器。',
      ],
      action: '讓同一網段的 `/ip dhcp-server network` 送出相同的 `gateway`、`dns-server`、`ntp-server`，否則客戶端拿到的設定取決於哪一台先回應。有推定偏離時，先從偏離的設備查起。',
    },
    // ---- 防火牆
    F01: {
      severity: 'warn', cat: '防火牆', title: '規則被前面的規則完全遮蔽，永遠不會命中', data: [['config']],
      causes: [
        '新規則加在範圍較寬的既有規則之後。',
        '前面那條規則的比對條件比預期寬。',
        '規則已經不需要，但沒有刪除。',
      ],
      action: '刪除或調整被遮蔽的規則；若它本來應該生效，把它移到遮蔽規則之前（例如 `/ip firewall filter move`）。',
    },
    F02: {
      severity: 'info', cat: '防火牆', title: '重複的規則（比對條件與動作相同）', data: [['config']],
      causes: [
        'defconf 被匯入兩次。',
        '手動新增時沒注意已經有相同的規則。',
      ],
      action: '刪除重複的那條。',
    },
    F03: {
      severity: 'warn', cat: '防火牆', title: 'WAN 可主動建立新連線的放行規則', data: [['config']],
      causes: [
        '服務刻意對外開放。',
        '放行規則沒有限制來源位址或入介面。',
        '前面缺少擋下從 WAN 進來連線的 drop 規則。',
        '前面的 drop 用了無法判斷的條件（例如 `dst-address-list`），檢查時當成不命中，可能多報。',
      ],
      action: '確認這個服務是否應該對外開放；不應開放時，加上來源位址限制（`src-address` 或 `src-address-list`），或在它之前放一條從 WAN 進來的 drop。',
    },
    F04: {
      severity: 'info', cat: '防火牆', title: 'WAN 可連入的 dst-nat（連接埠轉送）', data: [['config']],
      causes: [
        '刻意對外提供服務的連接埠轉送。',
        '已經不再使用、但沒有刪除的轉送。',
      ],
      action: '確認 `/ip firewall nat` 的這個轉送是否仍需要；需要時考慮限制來源位址。訊息提醒可能是 hairpin NAT 需要的放行規則時，收緊前先確認。',
    },
    F05: {
      severity: 'warn', cat: '防火牆', title: 'IPv6 forward 放行只限目的埠、沒有限目的位址', data: [['config']],
      causes: [
        '沿用 IPv4 的寫法只限目的埠，但 IPv6 沒有 NAT，等於對整個網段開放這些埠。',
        '要開放給特定主機，卻沒有寫目的位址。',
      ],
      action: '在 `/ipv6 firewall filter` 的這條規則加上 `dst-address`（或 `dst-address-list`），限定要開放的主機。',
    },
    F06: {
      severity: 'warn', cat: '防火牆', title: '以固定來源埠放行', data: [['config']],
      causes: [
        '想放行回應封包，卻用來源埠判斷，例如 `src-port=53`。',
        '把 `dst-port` 誤寫成 `src-port`。',
      ],
      action: '改成以目的埠（`dst-port`）或 `connection-state` 判斷；來源埠由對方決定，攻擊者可以用它繞過防火牆。',
    },
    F07: {
      severity: 'warn', cat: '防火牆', title: '管理服務沒有限制來源位址，且 WAN 可以連入', data: [['config']],
      causes: [
        '服務沿用出廠設定啟用，沒有設定 `available-from`。',
        '不需要的管理服務沒有停用。',
        'input chain 沒有擋下從 WAN 進來的連線。',
      ],
      action: '在 `/ip service` 停用不需要的服務，或設定 `available-from` 限定管理來源；也可以在 input chain 擋下從 WAN 進來的連線。',
    },
    F08: {
      severity: 'info', cat: '防火牆', title: '無法判斷 WAN 介面（WAN 相關的防火牆檢查未執行）', data: [['config']],
      causes: [
        '沒有名稱含 `WAN` 的 interface list，例如不是從 defconf 建立的組態。',
        'WAN 清單沒有成員，或 `include` 了無法展開的清單。',
      ],
      action: '建立名稱含 `WAN` 的 interface list（`/interface list add name=WAN`），把對外介面加進去（`/interface list member add list=WAN interface=<介面>`）；RouterOS 的 defconf 就是 `WAN`／`LAN`。',
    },
    F09: {
      severity: 'info', cat: '防火牆', title: '防火牆命中次數對不上 export 的規則（這個表的命中次數不採用）', data: [['fwstats']],
      causes: [
        '收集 `/export` 與 `print stats` 之間有人新增、刪除或搬動了規則。',
        '有 export 沒有列出的靜態規則來源（例如腳本在收集時才加入規則）。',
        '註解含特殊字元，print 與 export 的寫法不同。',
      ],
      action: '重新收集這台設備（`/export` 與 `print stats` 一起收）；仍對不上時，對照訊息中的列與規則找出差異。對上之前，這個表的規則沒有命中次數。',
    },
  };

  // 靜態目錄：載入後凍結（含 data、causes 等巢狀陣列），畫面經 S.query.rule() 取得的物件不會被改到
  const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
  deepFreeze(CATALOG);
  S.check = Object.assign(S.check || {}, { CATALOG });
})(globalThis.SSOT);
