#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=tools/collector-commands.sh
source "$SCRIPT_DIR/collector-commands.sh"

usage() {
  cat <<'EOF'
用法：tools/collect.sh <devices.csv> [選項]

選項：
  -o, --output FILE       輸出 bundle-v1 檔（預設 collection.txt）
  --device NAME           只收集指定設備
  --commands ID,...       只執行指定命令 ID（指定時忽略設備清單的 extra 欄）
  --timeout SECONDS       單一 SSH 指令 timeout（預設 30）
  --retry COUNT           失敗後重試次數（預設 0）
  --ask-password          每台設備連線一次並手動輸入密碼／確認 host key
  --no-auto               不依型號自動加上選用命令
  --retry-failed FILE     只重收上次收集檔 FILE 中失敗的指令，必須用 -o 指定新檔（見下方）
  --dry-run               只驗證清單並列出命令，不連線（不含自動加上的命令）
  -h, --help              顯示說明

設備清單：name,address,user,port[,extra]
  extra 為選填，列出該設備額外執行的選用命令 ID，以空白或分號分隔，例如：
    TPE_AP_01,192.0.2.31,admin,22,wifi
  選用命令 ID：wifi（RouterOS 7 Wi-Fi 關聯表）、wireless（舊版 wireless）、capsman（舊版 CAPsMAN 控制器）

自動選用命令：extra 欄留空且未用 --commands 時，依 /interface print 的介面 type
  加上選用命令（type=wifi 加 wifi，需 RouterOS 7.13 以上；type=wlan 加 wireless）。
  interface 收集失敗時，改依 /system resource print 的 board-name 判斷（只有
  802.11ax／be 型號、7.13 以上加 wifi）。終端機會標示 AUTO 與依據。

只重收失敗的指令：tools/collect.sh devices.csv --retry-failed 上次.txt -o 新檔.txt
  讀上次收集檔的 # collection failed: 紀錄，只對這些設備重跑這些指令（連線資訊仍取自設備清單），
  輸出合併後的新收集檔：失敗的區塊換成這次的結果，其他內容（含原本的 # collected-at）逐字保留；
  上次是連線失敗（connection）的設備，重收它的全部指令（含 extra 欄與自動選用命令）。
  其他設備不重新判斷自動選用命令：上次有失敗紀錄的才重收。重收仍失敗時寫入新的失敗紀錄。
  -o 必須指定，且不可與上次的收集檔相同；上次的收集檔不會被修改。
  --device NAME,...       只重收這些設備的失敗；指定的設備在上次收集檔沒有失敗紀錄時報錯
  --commands ID,...       只重收這些 ID 的失敗；連線失敗的設備只收這些 ID；
                          指定的 ID 在上次收集檔（選定的設備）沒有失敗紀錄時報錯
  --dry-run               列出會重收的指令與上次失敗原因，不連線，不需要 -o
  --timeout、--retry、--ask-password、--no-auto 照常適用（--no-auto 只影響連線失敗的設備）
  結束碼：
    0  全部重收成功；沒有任何失敗紀錄（印出「沒有需要重收的指令」）；--dry-run 列出完成
    1  合併後仍有失敗（重收仍失敗，或失敗不在 --device／--commands 範圍而未重收）
    2  連線前就中止，不寫輸出檔：
       沒有指定 -o，或 -o 與上次的收集檔相同（--dry-run 不檢查 -o）；
       上次收集檔無法讀取或格式不對（不是 bundle-v1、失敗紀錄位置不對、
       失敗的指令不是收集器的指令、有失敗紀錄的設備在檔案中出現兩次以上）；
       有失敗紀錄的設備不在設備清單，或位址和設備清單不同；
       --device／--commands 指定的設備或 ID 對不到任何失敗紀錄；
       以及與一般收集相同的選項或設備清單錯誤
EOF
}

die() {
  printf 'collect: %s\n' "$*" >&2
  exit 2
}

trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}

csv_error() {
  die "設備清單第 $1 行：$2"
}

load_inventory() {
  local file=$1 line_number=0 name address user port extra header_seen=0 id ids
  [[ -r "$file" ]] || die "無法讀取設備清單：$file"
  while IFS=, read -r name address user port extra || [[ -n "$name$address$user$port$extra" ]]; do
    line_number=$((line_number + 1))
    name=$(trim "$name"); address=$(trim "$address"); user=$(trim "$user"); port=$(trim "$port")
    [[ -z "$name" ]] && continue
    [[ "$name" == \#* ]] && continue
    if (( ! header_seen )); then
      [[ "$name" == "name" && "$address" == "address" && "$user" == "user" ]] ||
        csv_error "$line_number" "第一個資料列必須是 name,address,user,port"
      header_seen=1
      continue
    fi
    [[ -z "$address" || -z "$user" ]] && csv_error "$line_number" "name、address、user 不可為空"
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || csv_error "$line_number" "設備名稱無效：$name"
    [[ "$address" != *[[:space:],]* ]] || csv_error "$line_number" "address 無效：$address"
    [[ "$user" != *[[:space:],]* ]] || csv_error "$line_number" "user 無效"
    port=${port:-22}
    [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] ||
      csv_error "$line_number" "port 無效：$port"
    ids=()
    if [[ -n "$extra" ]]; then
      read -ra ids <<< "${extra//[,;]/ }"
      for id in "${ids[@]}"; do
        command_for_id "$id" >/dev/null || csv_error "$line_number" "extra 有未知的命令 ID：$id"
      done
    fi
    for existing in "${DEVICE_NAMES[@]-}"; do
      [[ "$existing" != "$name" ]] || csv_error "$line_number" "設備名稱重複：$name"
    done
    DEVICE_NAMES+=("$name"); DEVICE_ADDRESSES+=("$address"); DEVICE_USERS+=("$user"); DEVICE_PORTS+=("$port"); DEVICE_EXTRAS+=("${ids[*]-}")
  done < "$file"
  (( header_seen )) || die "設備清單缺少標題列"
  ((${#DEVICE_NAMES[@]} > 0)) || die "設備清單沒有資料列"
}

select_commands() {
  COMMAND_IDS=()
  local requested id command
  if [[ -z "$COMMAND_FILTER" ]]; then
    COMMAND_IDS=("${COLLECT_COMMAND_IDS[@]}")
    return
  fi
  IFS=, read -ra requested <<< "$COMMAND_FILTER"
  for id in "${requested[@]}"; do
    id=$(trim "$id")
    [[ -n "$id" ]] || continue
    command=$(command_for_id "$id") || die "未知收集指令 ID：$id"
    COMMAND_IDS+=("$id")
  done
  ((${#COMMAND_IDS[@]} > 0)) || die "至少要選擇一個收集指令"
}

# 這台設備要執行的命令 ID：選定的命令＋設備清單 extra 欄（有 --commands 時只用 --commands）
device_commands() {
  local i=$1 id seen=" " extras=()
  [[ -z "$COMMAND_FILTER" ]] && read -ra extras <<< "${DEVICE_EXTRAS[i]}"
  DEVICE_COMMAND_IDS=()
  for id in "${COMMAND_IDS[@]}" ${extras[@]+"${extras[@]}"}; do
    [[ "$seen" == *" $id "* ]] && continue
    seen+="$id "; DEVICE_COMMAND_IDS+=("$id")
  done
}

# 從 /system resource print 輸出取一個欄位的值（RouterOS 的 SSH 輸出可能帶 CR）
resource_field() {
  sed -n "s/^[[:space:]]*$1:[[:space:]]*//p" "$2" | tr -d '\r' | head -n 1
}

# 從 /interface print detail 輸出列出指定 type 的介面名稱（以「, 」分隔）。
# 每筆以編號行開始、可能折行；;;; 之後是註解，不當成欄位
interfaces_of_type() {
  awk -v want="$1" '
    function value(text, key,   v) {
      if (!match(text, "(^|[ \t])" key "=(\"[^\"]*\"|[^ \t]+)")) return ""
      v = substr(text, RSTART, RLENGTH); sub("^[ \t]*" key "=", "", v); gsub(/"/, "", v); return v
    }
    function flush() {
      if (entry != "" && value(entry, "type") == want) names = names (names == "" ? "" : ", ") value(entry, "name")
      entry = ""
    }
    { line = $0; sub(/\r$/, "", line); sub(/;;;.*/, "", line) }
    line ~ /^[ \t]*[0-9]+([ \t]|$)/ { flush(); entry = line; next }
    entry != "" { entry = entry " " line }
    END { flush(); print names }
  ' "$2"
}

# 依介面 type（輔助：board-name）自動加上選用命令到 DEVICE_COMMAND_IDS，並在終端機標示依據
add_auto_commands() {
  local interfaces_ok=$1 stdout_file=$2 wifi_names= wlan_names= id reason k
  if (( interfaces_ok )); then
    wifi_names=$(interfaces_of_type "$WIFI_INTERFACE_TYPE" "$stdout_file")
    wlan_names=$(interfaces_of_type "$WIRELESS_INTERFACE_TYPE" "$stdout_file")
  fi
  auto_optional_commands "$AUTO_BOARD" "$AUTO_VERSION" "$interfaces_ok" "$wifi_names" "$wlan_names"
  for ((k = 0; k < ${#AUTO_COMMAND_IDS[@]}; k++)); do
    id=${AUTO_COMMAND_IDS[k]}
    [[ " ${DEVICE_COMMAND_IDS[*]} " == *" $id "* ]] && continue
    DEVICE_COMMAND_IDS+=("$id")
    printf '  AUTO %s（%s）\n' "$id" "${AUTO_COMMAND_REASONS[k]}"
  done
  for reason in ${AUTO_SKIP_REASONS[@]+"${AUTO_SKIP_REASONS[@]}"}; do
    printf '  AUTO 略過（%s）\n' "$reason"
  done
}

selected_device() {
  [[ -z "$DEVICE_FILTER" || ",$DEVICE_FILTER," == *",$1,"* ]]
}

run_command() {
  local address=$1 user=$2 port=$3 command=$4 stdout_file=$5 stderr_file=$6
  local attempt=0 code
  while :; do
    : > "$stdout_file"; : > "$stderr_file"
    timeout --signal=TERM --kill-after=5 "$TIMEOUT" \
      ssh -o BatchMode=yes ${SSH_CONTROL_OPTS[@]+"${SSH_CONTROL_OPTS[@]}"} -p "$port" "$user@$address" "$command" \
      >"$stdout_file" 2>"$stderr_file"
    code=$?
    (( code == 0 )) && return 0
    attempt=$((attempt + 1))
    (( attempt > RETRY )) && return "$code"
    printf '  RETRY %s (%d/%d)\n' "$command" "$attempt" "$RETRY" >&2
  done
}

now_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# 使用 --ask-password 時，為設備 $1 互動式建立共用連線；失敗時回傳非零
open_connection() {
  local i=$1 control_path
  SSH_CONTROL_OPTS=()
  (( ASK_PASSWORD )) || return 0
  control_path="$TMP_DIR/cm-$i"
  # 互動式建立共用連線；ControlPersist 讓 ssh 認證後轉入背景，後續命令不再詢問
  # -fN 認證後轉入背景且不執行遠端命令（RouterOS 沒有 true 等 shell 指令）
  if ssh -fN -o ControlMaster=yes -o ControlPath="$control_path" -o ControlPersist=120 -p "$port" "$user@$address"; then
    SSH_CONTROL_OPTS=(-o ControlPath="$control_path")
    return 0
  fi
  printf '  FAIL 無法建立連線（密碼或 host key 錯誤）\n' >&2
  return 1
}

close_connection() {
  if ((${#SSH_CONTROL_OPTS[@]})); then ssh "${SSH_CONTROL_OPTS[@]}" -O exit -p "$port" "$user@$address" 2>/dev/null; fi
  SSH_CONTROL_OPTS=()
}

# 執行一個指令，把區塊（指令標記、收集時間、輸出、失敗原因）附加到輸出檔；
# 輸出留在 $TMP_DIR/stdout 供自動判斷使用；失敗時回傳非零
collect_block() {
  local id=$1 command code
  command=$(command_for_id "$id")
  ATTEMPTED=$((ATTEMPTED + 1))
  printf '### %s\n# collected-at: %s\n' "$command" "$(now_utc)" >> "$OUTPUT"
  run_command "$address" "$user" "$port" "$command" "$TMP_DIR/stdout" "$TMP_DIR/stderr"
  code=$?
  if (( code == 0 )); then
    cat "$TMP_DIR/stdout" >> "$OUTPUT"
    printf '  OK %s\n' "$id"
    return 0
  fi
  failures=$((failures + 1))
  cat "$TMP_DIR/stdout" >> "$OUTPUT"
  if (( code == 124 )); then
    printf '# collection failed: timeout\n' >> "$OUTPUT"
    printf '  FAIL %s timeout\n' "$id" >&2
  else
    printf '# collection failed: exit code %s\n' "$code" >> "$OUTPUT"
    printf '  FAIL %s (exit %s)\n' "$id" "$code" >&2
  fi
  if [[ -s "$TMP_DIR/stderr" ]]; then sed 's/^/    /' "$TMP_DIR/stderr" >&2; fi
  return 1
}

# 收集設備 $1 的全部指令（device_commands＋自動選用命令），區塊附加到輸出檔
collect_device() {
  local i=$1 auto=0 c ok
  device_commands "$i"
  AUTO_BOARD=; AUTO_VERSION=
  (( AUTO )) && [[ -z "$COMMAND_FILTER" && -z "${DEVICE_EXTRAS[i]}" ]] && auto=1
  # 用索引走訪：interface 執行後可能在尾端追加自動選用命令。
  # 自動判斷只在用預設清單時發生，預設清單中 system 排在 interface 之前，判斷時已有 board-name 與版本
  for ((c = 0; c < ${#DEVICE_COMMAND_IDS[@]}; c++)); do
    id=${DEVICE_COMMAND_IDS[c]}
    ok=1; collect_block "$id" || ok=0
    (( auto )) || continue
    if (( ok )) && [[ "$id" == system ]]; then
      AUTO_BOARD=$(resource_field board-name "$TMP_DIR/stdout"); AUTO_VERSION=$(resource_field version "$TMP_DIR/stdout")
    fi
    # interface 失敗時退回只依 board-name 判斷
    if [[ "$id" == interface ]]; then add_auto_commands "$ok" "$TMP_DIR/stdout"; fi
  done
}

set_device() {
  name=${DEVICE_NAMES[$1]}; address=${DEVICE_ADDRESSES[$1]}; user=${DEVICE_USERS[$1]}; port=${DEVICE_PORTS[$1]}
}

device_index() {
  local i
  for ((i = 0; i < ${#DEVICE_NAMES[@]}; i++)); do
    [[ "${DEVICE_NAMES[i]}" == "$1" ]] && { printf '%s\n' "$i"; return 0; }
  done
  return 1
}

# 列出上次收集檔的設備與失敗紀錄（只認收集器寫的格式：設備標頭、### 標記、_____），每行一筆、以 tab 分隔：
#   D 行號 設備 位址                 設備標頭
#   F 起始行 結束行 指令 原因        失敗的指令區塊（### 行到區塊最後一行）
#   N 行號 原因                      設備層級的連線失敗（設備標頭之後、任何指令之前）
#   E 行號 訊息                      格式錯誤
# 設備標頭與分隔線的規則和 src/readers/bundle-v1.js 相同；區塊在下一個 ###、設備標頭或分隔線之前結束
read_failures() {
  awk '
    function flush(last) {
      if (bstart && bfail != "") { print "F\t" bstart "\t" last "\t" bcmd "\t" bfail; failed[dev] = 1 }
      bstart = 0; bfail = ""
    }
    function header(text,   h, octets, n, k) {
      if (text !~ /^[ \t]*[A-Za-z0-9][A-Za-z0-9_.:-]*[ \t]*\([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\)[ \t]*:[ \t]*$/) return 0
      h = text; sub(/^[ \t]*/, "", h)
      hname = h; sub(/[ \t]*\(.*$/, "", hname)
      haddr = h; sub(/^[^(]*\(/, "", haddr); sub(/\).*$/, "", haddr)
      n = split(haddr, octets, ".")
      for (k = 1; k <= n; k++) if (length(octets[k]) > 3) return 0
      return 1
    }
    {
      line = $0; sub(/\r$/, "", line)
      if (header(line)) {
        flush(NR - 1)
        dev = hname; seen[dev]++; devices++; indev = 1; connection = 0
        print "D\t" NR "\t" hname "\t" haddr
        next
      }
      if (line ~ /^[ \t]*_____+[ \t]*$/) { flush(NR - 1); indev = 0; next }
      if (line ~ /^[ \t]*###[ \t]*[^ \t]/) {
        flush(NR - 1)
        if (!indev) next
        if (connection) { print "E\t" NR "\t設備 " dev " 已記錄連線失敗，卻還有指令區塊"; next }
        bcmd = line; sub(/^[ \t]*###[ \t]*/, "", bcmd); sub(/[ \t]+$/, "", bcmd)
        bstart = NR
        next
      }
      if (tolower(line) ~ /^[ \t]*#[ \t]*collection failed:/) {
        reason = line; sub(/^[^:]*:[ \t]*/, "", reason); sub(/[ \t]+$/, "", reason)
        if (!indev) print "E\t" NR "\t失敗紀錄不在設備區塊內"
        else if (bstart) { if (bfail == "") bfail = (reason == "" ? "(未寫原因)" : reason) }
        else if (tolower(reason) == "connection") { print "N\t" NR "\t" reason; connection = 1; failed[dev] = 1 }
        else print "E\t" NR "\t設備標頭之後、指令之前的失敗紀錄只能是 connection：" reason
      }
    }
    END {
      flush(NR)
      if (!devices) print "E\t1\t不是 bundle-v1 收集檔（沒有「設備名 (IPv4):」標頭）"
      for (d in seen) if (seen[d] > 1 && failed[d]) print "E\t1\t設備 " d " 出現 " seen[d] " 次，無法判斷要重收哪一段"
    }
  ' "$1"
}

# 讀上次收集檔，決定要重收的項目（ITEM_*，依檔案順序）；格式錯誤或篩選對不上時以結束碼 2 結束
load_retry_plan() {
  local plan kind a b c d dev= dev_addr= index id errors=0 wanted matched_devices=" " matched_ids=" " any_connection=0 reported=" "
  [[ -r "$RETRY_FROM" && -f "$RETRY_FROM" ]] || die "無法讀取上次的收集檔：$RETRY_FROM"
  plan=$(read_failures "$RETRY_FROM") || die "無法讀取上次的收集檔：$RETRY_FROM"
  TOTAL_FAILED=0
  while IFS=$'\t' read -r kind a b c d; do
    case "$kind" in
      E) printf 'collect: 上次收集檔 %s 第 %s 行：%s\n' "$RETRY_FROM" "$a" "$b" >&2; errors=1 ;;
      D) dev=$b; dev_addr=$c ;;
      F|N)
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
        selected_device "$dev" || continue
        matched_devices+="$dev "
        if ! index=$(device_index "$dev"); then
          [[ "$reported" == *" $dev "* ]] || printf 'collect: 上次收集檔的設備 %s 有失敗紀錄，但不在設備清單 %s\n' "$dev" "$INVENTORY" >&2
          reported+="$dev "; errors=1; continue
        fi
        if [[ "${DEVICE_ADDRESSES[index]}" != "$dev_addr" ]]; then
          [[ "$reported" == *" $dev "* ]] ||
            printf 'collect: 設備 %s 的位址在上次收集檔是 %s，設備清單是 %s；請確認是同一台設備\n' "$dev" "$dev_addr" "${DEVICE_ADDRESSES[index]}" >&2
          reported+="$dev "; errors=1; continue
        fi
        if [[ "$kind" == N ]]; then
          ITEM_KIND+=(N); ITEM_START+=("$a"); ITEM_END+=("$a"); ITEM_ID+=(-); ITEM_REASON+=("$b"); ITEM_INDEX+=("$index")
          any_connection=1
          continue
        fi
        id=$(id_for_command "$c") || { printf 'collect: 上次收集檔 %s 第 %s 行：失敗的指令不是收集器的指令：%s\n' "$RETRY_FROM" "$a" "$c" >&2; errors=1; continue; }
        if [[ -n "$COMMAND_FILTER" && " ${COMMAND_IDS[*]} " != *" $id "* ]]; then continue; fi
        matched_ids+="$id "
        ITEM_KIND+=(F); ITEM_START+=("$a"); ITEM_END+=("$b"); ITEM_ID+=("$id"); ITEM_REASON+=("$d"); ITEM_INDEX+=("$index")
        ;;
    esac
  done <<< "$plan"
  (( errors )) && exit 2
  if (( TOTAL_FAILED == 0 )); then
    printf '沒有需要重收的指令：%s 沒有 # collection failed: 紀錄\n' "$RETRY_FROM"
    exit 0
  fi
  # 指定的設備或指令在上次收集檔沒有失敗紀錄時報錯，不靜默略過
  if [[ -n "$DEVICE_FILTER" ]]; then
    IFS=, read -ra wanted <<< "$DEVICE_FILTER"
    for d in "${wanted[@]}"; do
      d=$(trim "$d"); [[ -n "$d" ]] || continue
      [[ "$matched_devices" == *" $d "* ]] || { printf 'collect: --device %s 在上次收集檔沒有失敗紀錄\n' "$d" >&2; errors=1; }
    done
  fi
  if [[ -n "$COMMAND_FILTER" ]] && (( ! any_connection )); then
    for id in "${COMMAND_IDS[@]}"; do
      [[ "$matched_ids" == *" $id "* ]] || { printf 'collect: --commands %s 在上次收集檔（選定的設備）沒有失敗紀錄\n' "$id" >&2; errors=1; }
    done
  fi
  (( errors )) && exit 2
  return 0
}

# 把上次收集檔第 $1 行到第 $2 行（$ 為檔尾）原樣附加到輸出檔
copy_lines() {
  local from=$1 to=$2
  if [[ "$to" == '$' ]]; then sed -n "${from},\$p" "$RETRY_FROM" >> "$OUTPUT"; return; fi
  (( from <= to )) || return 0
  sed -n "${from},${to}p;${to}q" "$RETRY_FROM" >> "$OUTPUT"
}

retry_dry_run() {
  local k i id
  for ((k = 0; k < ${#ITEM_KIND[@]}; k++)); do
    i=${ITEM_INDEX[k]}
    if [[ "${ITEM_KIND[k]}" == N ]]; then
      device_commands "$i"
      for id in "${DEVICE_COMMAND_IDS[@]}"; do
        printf '%s: %s（上次失敗：%s）\n' "${DEVICE_NAMES[i]}" "$(command_for_id "$id")" "${ITEM_REASON[k]}"
      done
    else
      printf '%s: %s（上次失敗：%s）\n' "${DEVICE_NAMES[i]}" "$(command_for_id "${ITEM_ID[k]}")" "${ITEM_REASON[k]}"
    fi
  done
}

# 合併輸出：上次收集檔原樣複製，只把要重收的區塊（或連線失敗行）換成這次的結果
retry_failed() {
  local k i cursor=1 current=-1 connected=1
  for ((k = 0; k < ${#ITEM_KIND[@]}; k++)); do
    i=${ITEM_INDEX[k]}
    copy_lines "$cursor" $((ITEM_START[k] - 1))
    cursor=$((ITEM_END[k] + 1))
    if (( i != current )); then
      (( current < 0 )) || close_connection
      current=$i; set_device "$i"
      printf '重收 %s (%s)\n' "$name" "$address"
      connected=1; open_connection "$i" || connected=0
    fi
    if [[ "${ITEM_KIND[k]}" == N ]]; then
      if (( connected )); then collect_device "$i"; else
        ATTEMPTED=$((ATTEMPTED + 1)); failures=$((failures + 1))
        printf '# collection failed: connection\n' >> "$OUTPUT"
      fi
    elif (( connected )); then
      collect_block "${ITEM_ID[k]}" || true
    else
      # 設備已有其他區塊，連線失敗記在這個指令區塊內
      ATTEMPTED=$((ATTEMPTED + 1)); failures=$((failures + 1))
      printf '### %s\n# collected-at: %s\n# collection failed: connection\n' "$(command_for_id "${ITEM_ID[k]}")" "$(now_utc)" >> "$OUTPUT"
    fi
  done
  (( current < 0 )) || close_connection
  copy_lines "$cursor" '$'
}

OUTPUT=collection.txt
OUTPUT_SET=0
TIMEOUT=30
RETRY=0
DEVICE_FILTER=
COMMAND_FILTER=
RETRY_FROM=
DRY_RUN=0
ASK_PASSWORD=0
AUTO=1
SSH_CONTROL_OPTS=()
DEVICE_NAMES=(); DEVICE_ADDRESSES=(); DEVICE_USERS=(); DEVICE_PORTS=(); DEVICE_EXTRAS=(); COMMAND_IDS=(); DEVICE_COMMAND_IDS=()
ITEM_KIND=(); ITEM_START=(); ITEM_END=(); ITEM_ID=(); ITEM_REASON=(); ITEM_INDEX=()
TOTAL_FAILED=0
ATTEMPTED=0
INVENTORY=

while (($#)); do
  case "$1" in
    -o|--output) (($# >= 2)) || die "$1 需要值"; OUTPUT=$2; OUTPUT_SET=1; shift 2 ;;
    --device) (($# >= 2)) || die "$1 需要值"; DEVICE_FILTER=$2; shift 2 ;;
    --commands) (($# >= 2)) || die "$1 需要值"; COMMAND_FILTER=$2; shift 2 ;;
    --retry-failed) (($# >= 2)) || die "$1 需要值"; RETRY_FROM=$2; shift 2 ;;
    --timeout) (($# >= 2)) || die "$1 需要值"; TIMEOUT=$2; shift 2 ;;
    --retry) (($# >= 2)) || die "$1 需要值"; RETRY=$2; shift 2 ;;
    --ask-password) ASK_PASSWORD=1; shift ;;
    --no-auto) AUTO=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "未知選項：$1" ;;
    *) [[ -z "$INVENTORY" ]] || die "只能指定一個設備清單"; INVENTORY=$1; shift ;;
  esac
done

[[ -n "$INVENTORY" ]] || { usage >&2; exit 2; }
[[ "$TIMEOUT" =~ ^[0-9]+$ && "$TIMEOUT" -ge 1 ]] || die "--timeout 必須是正整數"
[[ "$RETRY" =~ ^[0-9]+$ ]] || die "--retry 必須是非負整數"
if [[ -n "$RETRY_FROM" ]] && (( ! DRY_RUN )); then
  (( OUTPUT_SET )) || die "--retry-failed 必須用 -o 指定新的輸出檔（不覆寫上次的收集檔）"
  [[ ! "$OUTPUT" -ef "$RETRY_FROM" ]] || die "-o 不可與 --retry-failed 的收集檔相同：$OUTPUT"
fi
command -v ssh >/dev/null 2>&1 || die "找不到 ssh"
command -v timeout >/dev/null 2>&1 || die "找不到 timeout（WSL 請安裝 coreutils）"

load_inventory "$INVENTORY"
select_commands
[[ -z "$RETRY_FROM" ]] || load_retry_plan

if (( DRY_RUN )); then
  if [[ -n "$RETRY_FROM" ]]; then retry_dry_run; exit 0; fi
  for ((i = 0; i < ${#DEVICE_NAMES[@]}; i++)); do
    selected_device "${DEVICE_NAMES[i]}" || continue
    device_commands "$i"
    for id in "${DEVICE_COMMAND_IDS[@]}"; do
      printf '%s: %s\n' "${DEVICE_NAMES[i]}" "$(command_for_id "$id")"
    done
  done
  exit 0
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/topo-mikrotik.XXXXXX") || die "無法建立暫存目錄"
trap 'rm -rf "$TMP_DIR"' EXIT
: > "$OUTPUT" || die "無法寫入輸出檔：$OUTPUT"
failures=0

if [[ -n "$RETRY_FROM" ]]; then
  retry_failed
  skipped=$((TOTAL_FAILED - ${#ITEM_KIND[@]}))
  printf '\n輸出：%s；重收 %d 個指令，仍失敗 %d 個' "$OUTPUT" "$ATTEMPTED" "$failures"
  (( skipped == 0 )) || printf '；另有 %d 個失敗不在 --device／--commands 範圍，未重收' "$skipped"
  printf '\n'
  (( failures == 0 && skipped == 0 )) || exit 1
  exit 0
fi

for ((i = 0; i < ${#DEVICE_NAMES[@]}; i++)); do
  set_device "$i"
  selected_device "$name" || continue
  printf '收集 %s (%s)\n' "$name" "$address"
  printf '%s (%s):\n' "$name" "$address" >> "$OUTPUT"
  if ! open_connection "$i"; then
    printf '# collection failed: connection\n_____\n' >> "$OUTPUT"
    failures=$((failures + 1))
    continue
  fi
  collect_device "$i"
  close_connection
  printf '_____\n' >> "$OUTPUT"
done

printf '\n輸出：%s；失敗 %d 個指令\n' "$OUTPUT" "$failures"
(( failures == 0 )) || exit 1
