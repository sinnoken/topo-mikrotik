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
# /system resource print：依位址回傳型號與版本（RouterOS 的 SSH 輸出帶 CR）
if [[ "$command_name" == "/system resource print" ]]; then
  case "$target" in
    *@192.0.2.11) board='cAP ax'; version='7.16.1 (stable)' ;;
    *@192.0.2.12) board='C52iG-5HaxD2HaxD-TC'; version='7.15 (stable)' ;;
    *@192.0.2.13) board='hAP ax^2'; version='7.12.1 (stable)' ;;
    *@192.0.2.14) board='cAP ac'; version='7.16.1 (stable)' ;;
    *) board='CRS326-24G-2S+'; version='7.16.1 (stable)' ;;
  esac
  printf '                  version: %s\r\n               board-name: %s\r\n                 platform: MikroTik\r\n' "$version" "$board"
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

# 依 board-name 自動加上選用命令：只有 802.11ax／be 且 RouterOS 7.13 以上加 wifi；extra 欄或 --commands 指定時不自動加
cat > "$TMP_DIR/devices-auto.csv" <<'EOF'
name,address,user,port,extra
AUTO_SWITCH,192.0.2.10,admin,22
AUTO_CAP_AX,192.0.2.11,admin,22
AUTO_HAP_AX2,192.0.2.12,admin,22
AUTO_OLD_AX,192.0.2.13,admin,22
AUTO_CAP_AC,192.0.2.14,admin,22
AUTO_EXTRA,192.0.2.11,admin,22,capsman
EOF
WIFI_COMMAND='### /interface wifi registration-table print detail without-paging'
device_section() { awk -v name="$1 (" 'index($0, name) == 1 { on = 1 } on { print } on && /^_____$/ { exit }' "$2"; }
run_collector "$TMP_DIR/devices-auto.csv" --output "$TMP_DIR/auto.txt" >"$TMP_DIR/auto.log"
grep -qxF '  AUTO wifi（board-name=cAP ax）' "$TMP_DIR/auto.log"
grep -qxF '  AUTO wifi（board-name=C52iG-5HaxD2HaxD-TC）' "$TMP_DIR/auto.log"
grep -qF '  AUTO 略過（board-name=hAP ax^2：RouterOS 7.12.1 (stable) 早於 7.13' "$TMP_DIR/auto.log"
grep -qF '  AUTO 略過（board-name=cAP ac：802.11ac' "$TMP_DIR/auto.log"
device_section AUTO_CAP_AX "$TMP_DIR/auto.txt" | grep -qxF "$WIFI_COMMAND"
device_section AUTO_HAP_AX2 "$TMP_DIR/auto.txt" | grep -qxF "$WIFI_COMMAND"
for name in AUTO_SWITCH AUTO_OLD_AX AUTO_CAP_AC AUTO_EXTRA; do
  if device_section "$name" "$TMP_DIR/auto.txt" | grep -qxF "$WIFI_COMMAND"; then
    printf '%s must not get automatic wifi\n' "$name" >&2; exit 1
  fi
done
device_section AUTO_EXTRA "$TMP_DIR/auto.txt" | grep -q '^### /caps-man registration-table'
# 自動加上的指令也有收集時間
device_section AUTO_CAP_AX "$TMP_DIR/auto.txt" | grep -A1 -xF "$WIFI_COMMAND" | grep -q '^# collected-at: '
run_collector "$TMP_DIR/devices-auto.csv" --device AUTO_CAP_AX --no-auto --output "$TMP_DIR/no-auto.txt" >"$TMP_DIR/no-auto.log"
if grep -q 'AUTO ' "$TMP_DIR/no-auto.log" || grep -q 'registration-table' "$TMP_DIR/no-auto.txt"; then
  printf '%s\n' '--no-auto must not add commands' >&2; exit 1
fi
run_collector "$TMP_DIR/devices-auto.csv" --device AUTO_CAP_AX --commands system --output "$TMP_DIR/auto-filter.txt" >"$TMP_DIR/auto-filter.log"
if grep -q 'AUTO ' "$TMP_DIR/auto-filter.log" || grep -q 'registration-table' "$TMP_DIR/auto-filter.txt"; then
  printf '%s\n' '--commands must override automatic commands' >&2; exit 1
fi
# --dry-run 不連線，輸出不含自動加上的命令
run_collector "$TMP_DIR/devices-auto.csv" --dry-run --device AUTO_CAP_AX >"$TMP_DIR/auto-dry.txt"
if grep -q 'registration-table' "$TMP_DIR/auto-dry.txt"; then
  printf '%s\n' '--dry-run must not list automatic commands' >&2; exit 1
fi

printf 'collector shell tests passed\n'
