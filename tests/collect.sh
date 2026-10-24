#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/topo-mikrotik-test.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/devices.csv" <<'EOF'
name,address,user,port
TEST_ROUTER,192.0.2.1,admin,2222
EOF

cat > "$TMP_DIR/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
command_name=
for argument in "$@"; do target=${command_name:-}; command_name=$argument; done
# FAKE_SSH_UNREACHABLE：這個位址連不上（OpenSSH 為 255），--ask-password 的 -fN 也失敗
if [[ -n "${FAKE_SSH_UNREACHABLE:-}" && "$command_name $target" == *"@$FAKE_SSH_UNREACHABLE"* ]]; then
  printf 'ssh: connect to host %s port 22: No route to host\n' "$FAKE_SSH_UNREACHABLE" >&2; exit 255
fi
# --ask-password 的共用連線：建立（-fN）與關閉（-O exit）都不執行遠端指令
[[ "${1:-}" == -fN || " $* " == *" -O exit "* ]] && exit 0
# FAKE_SSH_FAIL_ON：「user@位址 指令」符合這個 glob 時失敗
if [[ -n "${FAKE_SSH_FAIL_ON:-}" && "$target $command_name" == $FAKE_SSH_FAIL_ON ]]; then
  printf 'permission denied\n' >&2; exit 7
fi
if [[ "${FAKE_SSH_MODE:-ok}" == "timeout" ]]; then sleep 2; fi
# 依位址模擬不同設備（RouterOS 的 SSH 輸出帶 CR）
board='CRS326-24G-2S+'; version='7.16.1 (stable)'; wireless_types=
case "$target" in
  *@192.0.2.11) board='cAP ax'; wireless_types='wifi wifi' ;;
  *@192.0.2.12) board='C52iG-5HaxD2HaxD-TC'; version='7.15 (stable)'; wireless_types='wifi wifi' ;;
  *@192.0.2.13) board='hAP ax^2'; version='7.12.1 (stable)'; wireless_types='wifi wifi' ;;
  *@192.0.2.14) board='cAP ac'; wireless_types='wlan wlan' ;;
  *@192.0.2.15) board='cAP ac'; wireless_types='wifi wifi' ;;
  *@192.0.2.16) board='cAP ac' ;;
  *@192.0.2.17) board='hAP ac^2'; wireless_types='wifi wlan' ;;
  *@192.0.2.18) board='RB4011iGS+'; version='6.49.10 (long-term)' ;;
esac
if [[ "$command_name" == "/system resource print" ]]; then
  printf '                  version: %s\r\n               board-name: %s\r\n                 platform: MikroTik\r\n' "$version" "$board"
  exit 0
fi
if [[ "$command_name" == "/interface print detail without-paging" ]]; then
  if [[ "${FAKE_SSH_MODE:-ok}" == "fail-interface" ]]; then printf 'timeout\n' >&2; exit 7; fi
  # 註解裡的 type= 不算；欄位可能折行；default-name= 不是 name=
  printf 'Flags: R - RUNNING\r\n 0  R  ;;; uplink type="wlan"\r\n       name="ether1" default-name="ether1" type="ether" mtu=1500\r\n'
  n=1
  for type in $wireless_types; do
    printf ' %d  R  name="%s%d" default-name="%s%d"\r\n       type="%s" mtu=1500\r\n' "$n" "$type" "$n" "$type" "$n" "$type"
    n=$((n + 1))
  done
  exit 0
fi
# 有準備好的回應檔（responses/指令的英數字）時原樣輸出
response="$DIR/responses/$(printf '%s' "$command_name" | tr -c 'A-Za-z0-9' '_')"
if [[ -f "$response" ]]; then cat "$response"; exit 0; fi
if [[ "${FAKE_SSH_MODE:-ok}" == "fail-route" && "$command_name" == *"/ip route "* ]]; then
  printf 'permission denied\n' >&2
  exit 7
fi
printf 'name=test interface=ether1 command=%s\n' "$command_name"
EOF
chmod +x "$TMP_DIR/ssh"

run_collector() {
  PATH="$TMP_DIR:$PATH" "$ROOT/tools/collect.sh" "$@"
}
fail() { printf '%s\n' "$*" >&2; exit 1; }

run_collector "$TMP_DIR/devices.csv" --commands config,neighbor --output "$TMP_DIR/success.txt" >"$TMP_DIR/success.log"
grep -q '^TEST_ROUTER (192.0.2.1):$' "$TMP_DIR/success.txt"
grep -q '^### /export terse$' "$TMP_DIR/success.txt"
grep -q '^### /ip neighbor print detail without-paging$' "$TMP_DIR/success.txt"
grep -q 'port 2222' "$TMP_DIR/success.log" || true

# 每個指令標記的下一行是收集時間（UTC，秒精度）
awk '
  pending { if ($0 !~ /^# collected-at: [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$/) bad = 1; pending = 0 }
  /^### / { pending = 1; count++ }
  END { exit (bad || pending || count != 2) }
' "$TMP_DIR/success.txt" || { printf 'each ### line must be followed by # collected-at\n' >&2; exit 1; }

run_collector "$TMP_DIR/devices.csv" --dry-run --commands config,neighbor >"$TMP_DIR/dry-run.txt"
grep -q 'TEST_ROUTER: /export terse' "$TMP_DIR/dry-run.txt"
grep -q 'TEST_ROUTER: /ip neighbor print detail without-paging' "$TMP_DIR/dry-run.txt"

# 所有收集指令都是唯讀：只有 /export terse、print 與 monitor … once，不可有 reset-counters 等會改設定或計數器的指令
(
  # shellcheck source=tools/collector-commands.sh
  source "$ROOT/tools/collector-commands.sh"
  print_re='^/[a-z0-9 -]+ print( [a-z-]+)*$'
  monitor_re='^/interface bridge( port)? monitor \[find\] once$'
  write_re=' (reset|reset-counters|reset-counters-all|set|add|remove|move|enable|disable|unset|edit|import|run) '
  for id in "${COLLECT_COMMAND_IDS[@]}" "${OPTIONAL_COMMAND_IDS[@]}"; do
    command=$(command_for_id "$id")
    [[ "$command" == '/export terse' || "$command" =~ $print_re || "$command" =~ $monitor_re ]] ||
      { printf '%s: not a read-only command: %s\n' "$id" "$command" >&2; exit 1; }
    if [[ " $command " =~ $write_re ]]; then printf '%s: command must not change state: %s\n' "$id" "$command" >&2; exit 1; fi
    [[ "$(id_for_command "$command")" == "$id" ]] || { printf '%s: id_for_command must map back\n' "$id" >&2; exit 1; }
  done
)

# 防火牆命中次數：每個表一個指令（print stats），預設清單中緊接在 export 之後
FW_IDS=fwfilter,fwnat,fwraw,fw6filter,fw6raw
cat > "$TMP_DIR/fw-dry.expected" <<'EOF'
TEST_ROUTER: /export terse
TEST_ROUTER: /ip firewall filter print stats detail without-paging
TEST_ROUTER: /ip firewall nat print stats detail without-paging
TEST_ROUTER: /ip firewall raw print stats detail without-paging
TEST_ROUTER: /ipv6 firewall filter print stats detail without-paging
TEST_ROUTER: /ipv6 firewall raw print stats detail without-paging
TEST_ROUTER: /ip neighbor print detail without-paging
EOF
run_collector "$TMP_DIR/devices.csv" --dry-run >"$TMP_DIR/dry-default.txt"
head -n 7 "$TMP_DIR/dry-default.txt" | diff "$TMP_DIR/fw-dry.expected" - || { printf 'firewall stats must follow /export terse\n' >&2; exit 1; }
# RouterOS 7 的 detail 輸出（手寫，格式依手冊推定）：數字以空白分千位、行尾有空白、帶 CR；
# 動態規則（D）與停用規則（X）、沒有規則的表都原樣保留
mkdir -p "$TMP_DIR/responses"
fw_response() { printf '%s\r\n' "${@:2}" > "$TMP_DIR/responses/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"; }
fw_response '/ip firewall filter print stats detail without-paging' \
  'Flags: X - disabled, I - invalid; D - dynamic ' \
  ' 0  D ;;; special dummy rule to show fasttrack counters' \
  '      chain=forward action=passthrough bytes=50 507 925 242 packets=50 048 246 ' '' \
  ' 1    ;;; defconf: drop invalid' \
  '      chain=input action=drop bytes=125 943 packets=2 434 ' '' \
  ' 2 X  ;;; old winbox rule' \
  '      chain=input action=accept bytes=0 packets=0 '
fw_response '/ip firewall nat print stats detail without-paging' \
  'Flags: X - disabled, I - invalid; D - dynamic ' \
  ' 0    ;;; defconf: masquerade' \
  '      chain=srcnat action=masquerade bytes=3 912 448 120 packets=4 101 733 '
fw_response '/ip firewall raw print stats detail without-paging' 'Flags: X - disabled, I - invalid; D - dynamic '
fw_response '/ipv6 firewall filter print stats detail without-paging' \
  'Flags: X - disabled, I - invalid; D - dynamic ' \
  ' 0    ;;; defconf: drop everything else not coming from LAN' \
  '      chain=input action=drop bytes=17 512 packets=146 '
fw_response '/ipv6 firewall raw print stats detail without-paging' 'Flags: X - disabled, I - invalid; D - dynamic '
run_collector "$TMP_DIR/devices.csv" --commands "config,$FW_IDS" --output "$TMP_DIR/fw.txt" >"$TMP_DIR/fw.log"
# 每個區塊：### 指令、# collected-at、RouterOS 的輸出逐位元組不變
# （BINMODE=3：Windows 的 gawk 預設會拿掉 CR；其他 awk 把它當成一般變數）
block_body() { awk -v BINMODE=3 -v marker="### $1" '
  on && (/^### / || /^_____$/) { exit }
  on && stamped { print; next }
  on && /^# collected-at: / { stamped = 1; next }
  $0 == marker { on = 1 }
' "$2"; }
for id in ${FW_IDS//,/ }; do
  command=$(source "$ROOT/tools/collector-commands.sh"; command_for_id "$id")
  [[ $(grep -cxF "### $command" "$TMP_DIR/fw.txt") == 1 ]] || { printf '%s: expected one block\n' "$id" >&2; exit 1; }
  grep -A1 -xF "### $command" "$TMP_DIR/fw.txt" | grep -q '^# collected-at: ' || { printf '%s: missing collected-at\n' "$id" >&2; exit 1; }
  cmp <(block_body "$command" "$TMP_DIR/fw.txt") "$TMP_DIR/responses/$(printf '%s' "$command" | tr -c 'A-Za-z0-9' '_')" ||
    { printf '%s: output must be written unchanged\n' "$id" >&2; exit 1; }
done
grep -q '^# collection failed: ' "$TMP_DIR/fw.txt" && { printf 'firewall stats collection must succeed\n' >&2; exit 1; }
# 網站讀入：每個指令一個區塊，都有收集時間、沒有失敗與註解問題
node -e '
  const S = require(process.argv[1])();
  const text = require("fs").readFileSync(process.argv[2], "utf8");
  const s = S.build([{ name: "fw.txt", text }], { now: "2026-01-01T00:00:00Z" });
  const want = ["/export terse", ...["ip firewall filter", "ip firewall nat", "ip firewall raw", "ipv6 firewall filter", "ipv6 firewall raw"]
    .map((t) => `/${t} print stats detail without-paging`)];
  const got = s.blocks.map((b) => b.command);
  const bad = s.blocks.filter((b) => b.failure || b.issues || !b.collectedAt).length;
  if (JSON.stringify(got) !== JSON.stringify(want) || bad) { console.error(got, bad); process.exit(1); }
' "$ROOT/tests/load.js" "$TMP_DIR/fw.txt" || { printf 'firewall stats blocks must read as one block per command\n' >&2; exit 1; }
# 沒有 IPv6 選單的設備（RouterOS 6 未啟用 ipv6 套件）：IPv6 兩個指令失敗並記錄，可用 --retry-failed 只重收這兩個
if FAKE_SSH_FAIL_ON='*@192.0.2.1 /ipv6 *' run_collector "$TMP_DIR/devices.csv" --commands "$FW_IDS" \
  --output "$TMP_DIR/fw-v6fail.txt" >/dev/null 2>&1; then
  printf 'failed ipv6 firewall stats must fail the collection\n' >&2; exit 1
fi
[[ $(grep -c '^# collection failed: exit code 7$' "$TMP_DIR/fw-v6fail.txt") == 2 ]] || { printf 'expected 2 ipv6 failures\n' >&2; exit 1; }
run_collector "$TMP_DIR/devices.csv" --retry-failed "$TMP_DIR/fw-v6fail.txt" --dry-run >"$TMP_DIR/fw-retry-dry.txt"
cat > "$TMP_DIR/fw-retry-dry.expected" <<'EOF'
TEST_ROUTER: /ipv6 firewall filter print stats detail without-paging（上次失敗：exit code 7）
TEST_ROUTER: /ipv6 firewall raw print stats detail without-paging（上次失敗：exit code 7）
EOF
diff "$TMP_DIR/fw-retry-dry.expected" "$TMP_DIR/fw-retry-dry.txt" || { printf 'retry must list the failed ipv6 commands\n' >&2; exit 1; }
rm -rf "$TMP_DIR/responses"

if FAKE_SSH_MODE=fail-route run_collector "$TMP_DIR/devices.csv" --commands config,route \
  --output "$TMP_DIR/partial.txt" >"$TMP_DIR/partial.log" 2>"$TMP_DIR/partial.err"; then
  printf 'expected partial collection to fail\n' >&2
  exit 1
fi
grep -q '^# collection failed: exit code 7$' "$TMP_DIR/partial.txt"
# 失敗標記仍在輸出之後；收集時間緊接在指令標記之後
awk '
  /^### \/ip route / { route = NR }
  route && NR == route + 1 && /^# collected-at: / { stamped = 1 }
  route && /^# collection failed: exit code 7$/ { failed = NR }
  END { exit !(stamped && failed > route + 1) }
' "$TMP_DIR/partial.txt" || { printf 'failure marker must follow collected-at\n' >&2; exit 1; }
grep -q 'permission denied' "$TMP_DIR/partial.err"

if FAKE_SSH_MODE=timeout run_collector "$TMP_DIR/devices.csv" --commands config \
  --timeout 1 --output "$TMP_DIR/timeout.txt" >"$TMP_DIR/timeout.log" 2>"$TMP_DIR/timeout.err"; then
  printf 'expected timeout collection to fail\n' >&2
  exit 1
fi
grep -q '^# collection failed: timeout$' "$TMP_DIR/timeout.txt"

# 設備清單的 extra 欄：只對指定設備追加選用命令（Wi-Fi 關聯表）；--commands 指定時忽略 extra
cat > "$TMP_DIR/devices-extra.csv" <<'EOF'
name,address,user,port,extra
TEST_SWITCH,192.0.2.1,admin,22
TEST_AP,192.0.2.2,admin,22,wifi;capsman
EOF
run_collector "$TMP_DIR/devices-extra.csv" --dry-run >"$TMP_DIR/extra.txt"
grep -q 'TEST_AP: /interface wifi registration-table print detail without-paging' "$TMP_DIR/extra.txt"
grep -q 'TEST_AP: /caps-man registration-table print detail without-paging' "$TMP_DIR/extra.txt"
if grep -q 'TEST_SWITCH: .*registration-table' "$TMP_DIR/extra.txt"; then
  printf 'switch without extra must not run Wi-Fi commands\n' >&2; exit 1
fi
grep -q 'TEST_SWITCH: /export terse' "$TMP_DIR/extra.txt"
run_collector "$TMP_DIR/devices-extra.csv" --dry-run --commands config >"$TMP_DIR/extra-filter.txt"
if grep -q 'registration-table' "$TMP_DIR/extra-filter.txt"; then
  printf '%s\n' '--commands must override extra' >&2; exit 1
fi
printf 'name,address,user,port\nTEST_AP,192.0.2.2,admin,22,wlan\n' > "$TMP_DIR/devices-bad.csv"
if run_collector "$TMP_DIR/devices-bad.csv" --dry-run >/dev/null 2>"$TMP_DIR/bad.err"; then
  printf 'unknown extra command id must fail\n' >&2; exit 1
fi
grep -q '未知的命令 ID：wlan' "$TMP_DIR/bad.err"

# 依介面 type 自動加上選用命令：type=wifi 加 wifi（7.13 以上）、type=wlan 加 wireless；
# interface 失敗時才退回 board-name；extra 欄、--commands、--no-auto 時不自動加
cat > "$TMP_DIR/devices-auto.csv" <<'EOF'
name,address,user,port,extra
AUTO_SWITCH,192.0.2.10,admin,22
AUTO_CAP_AX,192.0.2.11,admin,22
AUTO_HAP_AX2,192.0.2.12,admin,22
AUTO_OLD_AX,192.0.2.13,admin,22
AUTO_AC_WLAN,192.0.2.14,admin,22
AUTO_AC_WIFI,192.0.2.15,admin,22
AUTO_AC_NONE,192.0.2.16,admin,22
AUTO_AC_BOTH,192.0.2.17,admin,22
AUTO_EXTRA,192.0.2.11,admin,22,capsman
AUTO_V6,192.0.2.18,admin,22
EOF
WIFI_COMMAND='### /interface wifi registration-table print detail without-paging'
WIRELESS_COMMAND='### /interface wireless registration-table print detail without-paging'
device_section() { awk -v name="$1 (" 'index($0, name) == 1 { on = 1 } on { print } on && /^_____$/ { exit }' "$2"; }
device_log() { awk -v name="收集 $1 (" 'index($0, "收集 ") == 1 { on = index($0, name) == 1 } on { print }' "$2"; }
has_section() { device_section "$1" "$3" | grep -qxF "$2"; }
expect_commands() { # 設備 預期有無 wifi(1/0) 預期有無 wireless(1/0) 輸出檔
  local name=$1 want_wifi=$2 want_wireless=$3 file=$4 got_wifi=0 got_wireless=0
  has_section "$name" "$WIFI_COMMAND" "$file" && got_wifi=1
  has_section "$name" "$WIRELESS_COMMAND" "$file" && got_wireless=1
  if [[ "$got_wifi$got_wireless" != "$want_wifi$want_wireless" ]]; then
    printf '%s: wifi=%s wireless=%s, expected wifi=%s wireless=%s\n' "$name" "$got_wifi" "$got_wireless" "$want_wifi" "$want_wireless" >&2
    exit 1
  fi
}
# RouterOS 7 的 /ip vrf print（手寫，依 VRF 手冊的 print 範例）：內建的 main 帶 *，帶 CR
VRF_COMMAND='### /ip vrf print detail without-paging'
mkdir -p "$TMP_DIR/responses"
fw_response '/ip vrf print detail without-paging' \
  'Flags: X - disabled; * - builtin ' \
  ' 0    name="cust-a" interfaces=ether2,vlan110 ' '' \
  ' 1  * name="main" interfaces=all '
cp "$TMP_DIR/responses/_ip_vrf_print_detail_without_paging" "$TMP_DIR/vrf.expected"
run_collector "$TMP_DIR/devices-auto.csv" --output "$TMP_DIR/auto.txt" >"$TMP_DIR/auto.log"
rm -rf "$TMP_DIR/responses"
expect_commands AUTO_SWITCH 0 0 "$TMP_DIR/auto.txt"
expect_commands AUTO_V6 0 0 "$TMP_DIR/auto.txt"
# vrf 只看版本：RouterOS 7 一律加（每台一個區塊、有收集時間、輸出不變），6 不加並印出原因；extra 欄有值時不自動加
for name in AUTO_SWITCH AUTO_CAP_AX AUTO_OLD_AX AUTO_AC_NONE; do
  [[ $(device_section "$name" "$TMP_DIR/auto.txt" | grep -cxF "$VRF_COMMAND") == 1 ]] || fail "$name: expected one vrf block"
  device_section "$name" "$TMP_DIR/auto.txt" | grep -A1 -xF "$VRF_COMMAND" | grep -q '^# collected-at: ' || fail "$name: vrf missing collected-at"
done
# 第一個 vrf 區塊是 AUTO_SWITCH 的
cmp <(block_body '/ip vrf print detail without-paging' "$TMP_DIR/auto.txt") "$TMP_DIR/vrf.expected" || fail 'vrf output must be written unchanged'
device_log AUTO_SWITCH "$TMP_DIR/auto.log" | grep -qxF '  AUTO vrf（version=7.16.1 (stable)）' || fail 'AUTO vrf must show the version'
device_section AUTO_V6 "$TMP_DIR/auto.txt" | grep -qxF "$VRF_COMMAND" && fail 'RouterOS 6 must not run /ip vrf'
device_log AUTO_V6 "$TMP_DIR/auto.log" |
  grep -qxF '  AUTO 略過（vrf：RouterOS 6.49.10 (long-term) 沒有 /ip vrf 選單，VRF 設定在 export 的 /ip route vrf）' || fail 'RouterOS 6 must print why vrf is skipped'
device_section AUTO_EXTRA "$TMP_DIR/auto.txt" | grep -qxF "$VRF_COMMAND" && fail 'extra column must disable automatic vrf'
# system 失敗時版本不明：不加 vrf，印出原因
if FAKE_SSH_FAIL_ON='*@192.0.2.10 /system *' run_collector "$TMP_DIR/devices-auto.csv" --device AUTO_SWITCH \
  --output "$TMP_DIR/auto-nover.txt" >"$TMP_DIR/auto-nover.log" 2>/dev/null; then
  fail 'failed system command must fail the collection'
fi
grep -qxF "$VRF_COMMAND" "$TMP_DIR/auto-nover.txt" && fail 'unknown version must not run /ip vrf'
grep -qxF '  AUTO 略過（vrf：版本不明，無法確認有沒有 /ip vrf 選單）' "$TMP_DIR/auto-nover.log" || fail 'unknown version must print why vrf is skipped'
# 用 --commands 或 extra 欄可以明確指定 vrf
run_collector "$TMP_DIR/devices.csv" --dry-run --commands vrf >"$TMP_DIR/vrf-dry.txt"
[[ $(cat "$TMP_DIR/vrf-dry.txt") == 'TEST_ROUTER: /ip vrf print detail without-paging' ]] || fail '--commands vrf must run /ip vrf'
expect_commands AUTO_CAP_AX 1 0 "$TMP_DIR/auto.txt"
expect_commands AUTO_HAP_AX2 1 0 "$TMP_DIR/auto.txt"
expect_commands AUTO_OLD_AX 0 0 "$TMP_DIR/auto.txt"
expect_commands AUTO_AC_WLAN 0 1 "$TMP_DIR/auto.txt"
expect_commands AUTO_AC_WIFI 1 0 "$TMP_DIR/auto.txt"
expect_commands AUTO_AC_NONE 0 0 "$TMP_DIR/auto.txt"
expect_commands AUTO_AC_BOTH 1 1 "$TMP_DIR/auto.txt"
expect_commands AUTO_EXTRA 0 0 "$TMP_DIR/auto.txt"
device_section AUTO_EXTRA "$TMP_DIR/auto.txt" | grep -q '^### /caps-man registration-table'
device_log AUTO_CAP_AX "$TMP_DIR/auto.log" | grep -qxF '  AUTO wifi（interface type=wifi：wifi1, wifi2）'
device_log AUTO_AC_WLAN "$TMP_DIR/auto.log" | grep -qxF '  AUTO wireless（interface type=wlan：wlan1, wlan2）'
device_log AUTO_AC_WIFI "$TMP_DIR/auto.log" | grep -qxF '  AUTO wifi（interface type=wifi：wifi1, wifi2）'
device_log AUTO_AC_BOTH "$TMP_DIR/auto.log" | grep -qxF '  AUTO wifi（interface type=wifi：wifi1）'
device_log AUTO_AC_BOTH "$TMP_DIR/auto.log" | grep -qxF '  AUTO wireless（interface type=wlan：wlan2）'
device_log AUTO_AC_NONE "$TMP_DIR/auto.log" | grep -qxF '  AUTO 略過（board-name=cAP ac：沒有 type=wifi 或 wlan 的介面）'
device_log AUTO_OLD_AX "$TMP_DIR/auto.log" | grep -qF '  AUTO 略過（interface type=wifi：wifi1, wifi2；RouterOS 7.12.1 (stable) 早於 7.13'
if device_log AUTO_SWITCH "$TMP_DIR/auto.log" | grep -v -xF '  AUTO vrf（version=7.16.1 (stable)）' | grep -q '^  AUTO'; then
  printf 'switch without wireless must not print AUTO for Wi-Fi\n' >&2; exit 1
fi
# 自動加上的指令也有收集時間；只依介面 type，不會因 board-name 重複加
device_section AUTO_CAP_AX "$TMP_DIR/auto.txt" | grep -A1 -xF "$WIFI_COMMAND" | grep -q '^# collected-at: '
[[ $(device_section AUTO_CAP_AX "$TMP_DIR/auto.txt" | grep -cxF "$WIFI_COMMAND") == 1 ]]
# interface 失敗時退回 board-name：ax 加 wifi，ac 判斷不出來就略過
if FAKE_SSH_MODE=fail-interface run_collector "$TMP_DIR/devices-auto.csv" --device AUTO_HAP_AX2,AUTO_AC_WLAN \
  --output "$TMP_DIR/auto-fallback.txt" >"$TMP_DIR/auto-fallback.log" 2>/dev/null; then
  printf 'failed interface command must fail the collection\n' >&2; exit 1
fi
expect_commands AUTO_HAP_AX2 1 0 "$TMP_DIR/auto-fallback.txt"
expect_commands AUTO_AC_WLAN 0 0 "$TMP_DIR/auto-fallback.txt"
grep -qxF '  AUTO wifi（board-name=C52iG-5HaxD2HaxD-TC）' "$TMP_DIR/auto-fallback.log"
grep -qF '  AUTO 略過（board-name=cAP ac：802.11ac 可用 wifi 或 wireless' "$TMP_DIR/auto-fallback.log"
run_collector "$TMP_DIR/devices-auto.csv" --device AUTO_AC_BOTH --no-auto --output "$TMP_DIR/no-auto.txt" >"$TMP_DIR/no-auto.log"
if grep -q 'AUTO ' "$TMP_DIR/no-auto.log" || grep -q 'registration-table\|^### /ip vrf ' "$TMP_DIR/no-auto.txt"; then
  printf '%s\n' '--no-auto must not add commands' >&2; exit 1
fi
run_collector "$TMP_DIR/devices-auto.csv" --device AUTO_AC_BOTH --commands system,interface --output "$TMP_DIR/auto-filter.txt" >"$TMP_DIR/auto-filter.log"
if grep -q 'AUTO ' "$TMP_DIR/auto-filter.log" || grep -q 'registration-table\|^### /ip vrf ' "$TMP_DIR/auto-filter.txt"; then
  printf '%s\n' '--commands must override automatic commands' >&2; exit 1
fi
# --dry-run 不連線，輸出不含自動加上的命令
run_collector "$TMP_DIR/devices-auto.csv" --dry-run --device AUTO_AC_BOTH >"$TMP_DIR/auto-dry.txt"
if grep -q 'registration-table\|/ip vrf ' "$TMP_DIR/auto-dry.txt"; then
  printf '%s\n' '--dry-run must not list automatic commands' >&2; exit 1
fi

# --retry-failed：只重收上次失敗的指令，輸出合併後的新收集檔
expect_exit() { # 預期結束碼 指令…（不因非零結束碼中止測試）
  local want=$1 got=0; shift
  "$@" || got=$?
  [[ "$got" == "$want" ]] || fail "expected exit $want, got $got: $*"
}
cat > "$TMP_DIR/devices-retry.csv" <<'EOF'
name,address,user,port
RETRY_A,192.0.2.1,admin,22
RETRY_B,192.0.2.3,admin,22
RETRY_C,192.0.2.4,admin,22
EOF
RETRY_CMDS=config,route,neighbor
ROUTE_COMMAND='### /ip route print detail without-paging'
# 上次：RETRY_A 的 route 失敗、RETRY_C 連不上（--ask-password 時記為 connection）
FAKE_SSH_FAIL_ON='*@192.0.2.1 /ip route *' FAKE_SSH_UNREACHABLE=192.0.2.4 expect_exit 1 run_collector "$TMP_DIR/devices-retry.csv" \
  --ask-password --commands "$RETRY_CMDS" --output "$TMP_DIR/prev.txt" >/dev/null 2>&1
device_section RETRY_A "$TMP_DIR/prev.txt" | grep -qxF '# collection failed: exit code 7'
device_section RETRY_C "$TMP_DIR/prev.txt" | grep -qxF '# collection failed: connection'
[[ $(grep -c '^# collection failed: ' "$TMP_DIR/prev.txt") == 2 ]] || fail 'previous file must have 2 failures'
prev_sum=$(cksum < "$TMP_DIR/prev.txt")

# --dry-run 列出會重收的指令與上次失敗原因，不連線、不需要 -o
run_collector "$TMP_DIR/devices-retry.csv" --retry-failed "$TMP_DIR/prev.txt" --dry-run --commands "$RETRY_CMDS" >"$TMP_DIR/retry-dry.txt"
cat > "$TMP_DIR/retry-dry.expected" <<'EOF'
RETRY_A: /ip route print detail without-paging（上次失敗：exit code 7）
RETRY_C: /export terse（上次失敗：connection）
RETRY_C: /ip route print detail without-paging（上次失敗：connection）
RETRY_C: /ip neighbor print detail without-paging（上次失敗：connection）
EOF
diff "$TMP_DIR/retry-dry.expected" "$TMP_DIR/retry-dry.txt" || fail '--retry-failed --dry-run must list exactly the failed commands'
run_collector "$TMP_DIR/devices-retry.csv" --retry-failed "$TMP_DIR/prev.txt" --dry-run --device RETRY_A >"$TMP_DIR/retry-dry-device.txt"
[[ $(cat "$TMP_DIR/retry-dry-device.txt") == 'RETRY_A: /ip route print detail without-paging（上次失敗：exit code 7）' ]] ||
  fail '--retry-failed --dry-run --device must list only that device'

# 重收成功：失敗的區塊換成新結果，其他內容逐字保留，上次的收集檔不變
run_collector "$TMP_DIR/devices-retry.csv" --retry-failed "$TMP_DIR/prev.txt" --commands "$RETRY_CMDS" \
  --output "$TMP_DIR/merged.txt" >"$TMP_DIR/merged.log"
[[ $(cksum < "$TMP_DIR/prev.txt") == "$prev_sum" ]] || fail 'previous file must not be modified'
grep -q '^# collection failed: ' "$TMP_DIR/merged.txt" && fail 'merged file must have no failures'
grep -qF '重收 4 個指令，仍失敗 0 個' "$TMP_DIR/merged.log" || fail 'summary must count retried commands'
device_section RETRY_A "$TMP_DIR/merged.txt" | grep -A1 -xF "$ROUTE_COMMAND" | grep -q '^# collected-at: '
device_section RETRY_A "$TMP_DIR/merged.txt" | grep -qxF 'name=test interface=ether1 command=/ip route print detail without-paging'
[[ $(device_section RETRY_A "$TMP_DIR/merged.txt" | grep -cxF "$ROUTE_COMMAND") == 1 ]] || fail 'retried block must replace the old one'
[[ $(device_section RETRY_C "$TMP_DIR/merged.txt" | grep -c '^### ') == 3 ]] || fail 'connection device must collect its commands'
# 拿掉重收的部分（RETRY_A 的 route 區塊、RETRY_C 標頭與分隔線之間）後，兩個檔案逐字相同
without_retried() {
  awk '
    /^[A-Za-z0-9][A-Za-z0-9_.:-]* \(/ { dev = $1; skip = 0; print; next }
    /^_____$/ { skip = 0; print; next }
    /^### / { skip = (dev == "RETRY_A" && $0 ~ /^### \/ip route /) }
    dev == "RETRY_C" { next }
    !skip { print }
  ' "$1"
}
without_retried "$TMP_DIR/prev.txt" > "$TMP_DIR/prev.kept"
without_retried "$TMP_DIR/merged.txt" > "$TMP_DIR/merged.kept"
[[ $(grep -c '^# collected-at: ' "$TMP_DIR/prev.kept") == 5 ]] || fail 'kept part must include the original collected-at lines'
cmp "$TMP_DIR/prev.kept" "$TMP_DIR/merged.kept" || fail 'blocks not retried must be byte-identical'
# 網站讀入合併檔：沒有重複區塊（I02）、收集器註解沒有格式問題、沒有失敗紀錄
# （模擬 ssh 的輸出不是真的 RouterOS 內容，解析不出內容的 I01 不在檢查範圍）
node -e '
  const S = require(process.argv[1])();
  const text = require("fs").readFileSync(process.argv[2], "utf8");
  const s = S.build([{ name: "merged.txt", text }], { now: "2026-01-01T00:00:00Z" });
  const dup = s.findings.filter((f) => f.id === "I02").map((f) => f.message);
  const bad = s.blocks.filter((b) => b.failure || b.issues || !b.collectedAt).length;
  if (dup.length || bad || s.blocks.length !== 9) { console.error(dup, bad, s.blocks.length); process.exit(1); }
' "$ROOT/tests/load.js" "$TMP_DIR/merged.txt" || fail 'merged file must read without I02, annotation issues or failures'

# 重收仍然失敗：保留新的失敗紀錄，不重複區塊；連線失敗的設備仍記 connection
FAKE_SSH_FAIL_ON='*@192.0.2.1 /ip route *' FAKE_SSH_UNREACHABLE=192.0.2.4 expect_exit 1 run_collector "$TMP_DIR/devices-retry.csv" \
  --ask-password --retry-failed "$TMP_DIR/prev.txt" --commands "$RETRY_CMDS" --output "$TMP_DIR/merged-fail.txt" >"$TMP_DIR/merged-fail.log" 2>&1
grep -qF '仍失敗 2 個' "$TMP_DIR/merged-fail.log" || fail 'summary must count commands that still fail'
[[ $(device_section RETRY_A "$TMP_DIR/merged-fail.txt" | grep -cxF "$ROUTE_COMMAND") == 1 ]] || fail 'failed retry must not duplicate the block'
device_section RETRY_A "$TMP_DIR/merged-fail.txt" | grep -A3 -xF "$ROUTE_COMMAND" | grep -qxF '# collection failed: exit code 7'
device_section RETRY_C "$TMP_DIR/merged-fail.txt" | grep -qxF '# collection failed: connection'
device_section RETRY_C "$TMP_DIR/merged-fail.txt" | grep -q '^### ' && fail 'unreachable device must not get command blocks'
# 已有其他區塊的設備連不上時，連線失敗記在重收的指令區塊內
FAKE_SSH_UNREACHABLE=192.0.2.1 expect_exit 1 run_collector "$TMP_DIR/devices-retry.csv" --ask-password \
  --retry-failed "$TMP_DIR/prev.txt" --device RETRY_A --output "$TMP_DIR/merged-conn.txt" >/dev/null 2>&1
device_section RETRY_A "$TMP_DIR/merged-conn.txt" | grep -A2 -xF "$ROUTE_COMMAND" | grep -qxF '# collection failed: connection'

# --device 只重收指定設備；其他失敗原樣保留並以 1 結束
expect_exit 1 run_collector "$TMP_DIR/devices-retry.csv" --retry-failed "$TMP_DIR/prev.txt" --device RETRY_A \
  --output "$TMP_DIR/merged-device.txt" >"$TMP_DIR/merged-device.log"
grep -qF '另有 1 個失敗不在 --device／--commands 範圍' "$TMP_DIR/merged-device.log"
cmp <(device_section RETRY_C "$TMP_DIR/prev.txt") <(device_section RETRY_C "$TMP_DIR/merged-device.txt") || fail 'unselected device must be kept'
device_section RETRY_A "$TMP_DIR/merged-device.txt" | grep -q '^# collection failed: ' && fail 'selected device must be retried'

# 自動選用命令不重新判斷：只重收上次失敗的
cat > "$TMP_DIR/devices-retry-auto.csv" <<'EOF'
name,address,user,port
AUTO_CAP_AX,192.0.2.11,admin,22
AUTO_AC_WLAN,192.0.2.14,admin,22
EOF
FAKE_SSH_FAIL_ON='*@192.0.2.1[14] /interface [pw]*' expect_exit 1 run_collector "$TMP_DIR/devices-retry-auto.csv" \
  --output "$TMP_DIR/prev-auto.txt" >/dev/null 2>&1
device_section AUTO_CAP_AX "$TMP_DIR/prev-auto.txt" | grep -A3 -xF "$WIFI_COMMAND" | grep -qxF '# collection failed: exit code 7'
expect_commands AUTO_AC_WLAN 0 0 "$TMP_DIR/prev-auto.txt"
run_collector "$TMP_DIR/devices-retry-auto.csv" --retry-failed "$TMP_DIR/prev-auto.txt" --output "$TMP_DIR/merged-auto.txt" >"$TMP_DIR/merged-auto.log"
expect_commands AUTO_CAP_AX 1 0 "$TMP_DIR/merged-auto.txt"
expect_commands AUTO_AC_WLAN 0 0 "$TMP_DIR/merged-auto.txt"
grep -q 'AUTO ' "$TMP_DIR/merged-auto.log" && fail 'retry must not re-decide automatic commands'
grep -q '^# collection failed: ' "$TMP_DIR/merged-auto.txt" && fail 'auto retry must succeed'

# 沒有失敗：提示後以 0 結束，不產生輸出檔
run_collector "$TMP_DIR/devices.csv" --retry-failed "$TMP_DIR/success.txt" --output "$TMP_DIR/none.txt" >"$TMP_DIR/none.log"
grep -qF '沒有需要重收的指令' "$TMP_DIR/none.log"
[[ ! -e "$TMP_DIR/none.txt" ]] || fail 'no output file when nothing to retry'

# 檔案格式錯：以 2 結束並說明原因
expect_retry_error() { # 收集檔 預期訊息 [其他選項…]
  local file=$1 message=$2; shift 2
  expect_exit 2 run_collector "$TMP_DIR/devices-retry.csv" --retry-failed "$file" --output "$TMP_DIR/err-out.txt" "$@" 2>"$TMP_DIR/err.log" >/dev/null
  grep -qF -- "$message" "$TMP_DIR/err.log" || { cat "$TMP_DIR/err.log" >&2; fail "expected error: $message"; }
}
expect_retry_error "$TMP_DIR/missing.txt" '無法讀取上次的收集檔'
expect_retry_error "$TMP_DIR/devices-retry.csv" '不是 bundle-v1 收集檔'
printf 'RETRY_A (192.0.2.1):\n### /ip foo print\n# collection failed: timeout\n_____\n' > "$TMP_DIR/bad-command.txt"
expect_retry_error "$TMP_DIR/bad-command.txt" '失敗的指令不是收集器的指令：/ip foo print'
printf 'RETRY_A (192.0.2.1):\n_____\n# collection failed: timeout\n' > "$TMP_DIR/bad-outside.txt"
expect_retry_error "$TMP_DIR/bad-outside.txt" '失敗紀錄不在設備區塊內'
printf 'RETRY_A (192.0.2.9):\n# collection failed: connection\n_____\n' > "$TMP_DIR/bad-address.txt"
expect_retry_error "$TMP_DIR/bad-address.txt" '位址在上次收集檔是 192.0.2.9'
printf 'RETRY_X (192.0.2.1):\n# collection failed: connection\n_____\n' > "$TMP_DIR/bad-device.txt"
expect_retry_error "$TMP_DIR/bad-device.txt" '有失敗紀錄，但不在設備清單'

# 不合理的選項組合：直接報錯，不靜默忽略
expect_exit 2 run_collector "$TMP_DIR/devices-retry.csv" --retry-failed "$TMP_DIR/prev.txt" >/dev/null 2>"$TMP_DIR/err.log"
grep -qF -- '--retry-failed 必須用 -o 指定新的輸出檔' "$TMP_DIR/err.log"
expect_retry_error "$TMP_DIR/prev.txt" '-o 不可與 --retry-failed 的收集檔相同' --output "$TMP_DIR/prev.txt"
[[ $(cksum < "$TMP_DIR/prev.txt") == "$prev_sum" ]] || fail 'previous file must not be overwritten'
expect_retry_error "$TMP_DIR/prev.txt" '--device RETRY_B 在上次收集檔沒有失敗紀錄' --device RETRY_A,RETRY_B
expect_retry_error "$TMP_DIR/prev.txt" '--commands neighbor 在上次收集檔（選定的設備）沒有失敗紀錄' --device RETRY_A --commands route,neighbor

printf 'collector shell tests passed\n'
