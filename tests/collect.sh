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
for argument in "$@"; do command_name=$argument; done
if [[ "${FAKE_SSH_MODE:-ok}" == "timeout" ]]; then sleep 2; fi
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

run_collector "$TMP_DIR/devices.csv" --dry-run --commands config,neighbor >"$TMP_DIR/dry-run.txt"
grep -q 'TEST_ROUTER: /export terse' "$TMP_DIR/dry-run.txt"
grep -q 'TEST_ROUTER: /ip neighbor print detail without-paging' "$TMP_DIR/dry-run.txt"

if FAKE_SSH_MODE=fail-route run_collector "$TMP_DIR/devices.csv" --commands config,route \
  --output "$TMP_DIR/partial.txt" >"$TMP_DIR/partial.log" 2>"$TMP_DIR/partial.err"; then
  printf 'expected partial collection to fail\n' >&2
  exit 1
fi
grep -q '^# collection failed: exit code 7$' "$TMP_DIR/partial.txt"
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

printf 'collector shell tests passed\n'
