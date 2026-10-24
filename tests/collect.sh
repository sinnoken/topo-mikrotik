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
command_name=
for argument in "$@"; do target=${command_name:-}; command_name=$argument; done
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
run_collector "$TMP_DIR/devices-auto.csv" --output "$TMP_DIR/auto.txt" >"$TMP_DIR/auto.log"
expect_commands AUTO_SWITCH 0 0 "$TMP_DIR/auto.txt"
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
if device_log AUTO_SWITCH "$TMP_DIR/auto.log" | grep -q '^  AUTO'; then
  printf 'switch without wireless must not print AUTO\n' >&2; exit 1
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
if grep -q 'AUTO ' "$TMP_DIR/no-auto.log" || grep -q 'registration-table' "$TMP_DIR/no-auto.txt"; then
  printf '%s\n' '--no-auto must not add commands' >&2; exit 1
fi
run_collector "$TMP_DIR/devices-auto.csv" --device AUTO_AC_BOTH --commands system,interface --output "$TMP_DIR/auto-filter.txt" >"$TMP_DIR/auto-filter.log"
if grep -q 'AUTO ' "$TMP_DIR/auto-filter.log" || grep -q 'registration-table' "$TMP_DIR/auto-filter.txt"; then
  printf '%s\n' '--commands must override automatic commands' >&2; exit 1
fi
# --dry-run 不連線，輸出不含自動加上的命令
run_collector "$TMP_DIR/devices-auto.csv" --dry-run --device AUTO_AC_BOTH >"$TMP_DIR/auto-dry.txt"
if grep -q 'registration-table' "$TMP_DIR/auto-dry.txt"; then
  printf '%s\n' '--dry-run must not list automatic commands' >&2; exit 1
fi

printf 'collector shell tests passed\n'
