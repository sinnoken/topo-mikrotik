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

OUTPUT=collection.txt
TIMEOUT=30
RETRY=0
DEVICE_FILTER=
COMMAND_FILTER=
DRY_RUN=0
ASK_PASSWORD=0
AUTO=1
SSH_CONTROL_OPTS=()
DEVICE_NAMES=(); DEVICE_ADDRESSES=(); DEVICE_USERS=(); DEVICE_PORTS=(); DEVICE_EXTRAS=(); COMMAND_IDS=(); DEVICE_COMMAND_IDS=()
INVENTORY=

while (($#)); do
  case "$1" in
    -o|--output) (($# >= 2)) || die "$1 需要值"; OUTPUT=$2; shift 2 ;;
    --device) (($# >= 2)) || die "$1 需要值"; DEVICE_FILTER=$2; shift 2 ;;
    --commands) (($# >= 2)) || die "$1 需要值"; COMMAND_FILTER=$2; shift 2 ;;
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
command -v ssh >/dev/null 2>&1 || die "找不到 ssh"
command -v timeout >/dev/null 2>&1 || die "找不到 timeout（WSL 請安裝 coreutils）"

load_inventory "$INVENTORY"
select_commands

if (( DRY_RUN )); then
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

for ((i = 0; i < ${#DEVICE_NAMES[@]}; i++)); do
  name=${DEVICE_NAMES[i]}; address=${DEVICE_ADDRESSES[i]}; user=${DEVICE_USERS[i]}; port=${DEVICE_PORTS[i]}
  selected_device "$name" || continue
  printf '收集 %s (%s)\n' "$name" "$address"
  printf '%s (%s):\n' "$name" "$address" >> "$OUTPUT"
  SSH_CONTROL_OPTS=()
  if (( ASK_PASSWORD )); then
    control_path="$TMP_DIR/cm-$i"
    # 互動式建立共用連線；ControlPersist 讓 ssh 認證後轉入背景，後續命令不再詢問
    # -fN 認證後轉入背景且不執行遠端命令（RouterOS 沒有 true 等 shell 指令）
    if ssh -fN -o ControlMaster=yes -o ControlPath="$control_path" -o ControlPersist=120 -p "$port" "$user@$address"; then
      SSH_CONTROL_OPTS=(-o ControlPath="$control_path")
    else
      printf '  FAIL 無法建立連線（密碼或 host key 錯誤）\n' >&2
      printf '# collection failed: connection\n_____\n' >> "$OUTPUT"
      failures=$((failures + 1))
      continue
    fi
  fi
  device_commands "$i"
  auto=0; AUTO_BOARD=; AUTO_VERSION=
  (( AUTO )) && [[ -z "$COMMAND_FILTER" && -z "${DEVICE_EXTRAS[i]}" ]] && auto=1
  # 用索引走訪：interface 執行後可能在尾端追加自動選用命令。
  # 自動判斷只在用預設清單時發生，預設清單中 system 排在 interface 之前，判斷時已有 board-name 與版本
  for ((c = 0; c < ${#DEVICE_COMMAND_IDS[@]}; c++)); do
    id=${DEVICE_COMMAND_IDS[c]}
    command=$(command_for_id "$id")
    printf '### %s\n# collected-at: %s\n' "$command" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUTPUT"
    stdout_file="$TMP_DIR/stdout"; stderr_file="$TMP_DIR/stderr"
    if run_command "$address" "$user" "$port" "$command" "$stdout_file" "$stderr_file"; then
      cat "$stdout_file" >> "$OUTPUT"
      printf '  OK %s\n' "$id"
      if (( auto )) && [[ "$id" == system ]]; then
        AUTO_BOARD=$(resource_field board-name "$stdout_file"); AUTO_VERSION=$(resource_field version "$stdout_file")
      fi
      if (( auto )) && [[ "$id" == interface ]]; then add_auto_commands 1 "$stdout_file"; fi
    else
      code=$?
      failures=$((failures + 1))
      cat "$stdout_file" >> "$OUTPUT"
      if (( code == 124 )); then
        printf '# collection failed: timeout\n' >> "$OUTPUT"
        printf '  FAIL %s timeout\n' "$id" >&2
      else
        printf '# collection failed: exit code %s\n' "$code" >> "$OUTPUT"
        printf '  FAIL %s (exit %s)\n' "$id" "$code" >&2
      fi
      if [[ -s "$stderr_file" ]]; then sed 's/^/    /' "$stderr_file" >&2; fi
      # interface 失敗時退回只依 board-name 判斷
      if (( auto )) && [[ "$id" == interface ]]; then add_auto_commands 0 "$stdout_file"; fi
    fi
  done
  if ((${#SSH_CONTROL_OPTS[@]})); then ssh "${SSH_CONTROL_OPTS[@]}" -O exit -p "$port" "$user@$address" 2>/dev/null; fi
  printf '_____\n' >> "$OUTPUT"
done

printf '\n輸出：%s；失敗 %d 個指令\n' "$OUTPUT" "$failures"
(( failures == 0 )) || exit 1
