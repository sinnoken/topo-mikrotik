#!/usr/bin/env bash

# 防火牆命中次數（fwfilter…fw6raw）緊接在 config 之後：export 與計數器的收集時間越近，
# 中間有人增刪規則而對不上的機會越小
COLLECT_COMMAND_IDS=(config fwfilter fwnat fwraw fw6filter fw6raw neighbor bridgehost route arp system vlans interface ipaddr ospf stp stpbridge)
# 選用：只有部分設備才有的選單（Wi-Fi AP、CAPsMAN 控制器），不在預設清單；
# 用 --commands 或設備清單的 extra 欄指定，避免在交換器上執行而得到錯誤回應；
# 確定支援的設備會依 auto_optional_commands 自動加上
OPTIONAL_COMMAND_IDS=(wifi wireless capsman)

# 防火牆規則的命中次數（bytes、packets）：只用 print stats，不用 reset-counters 等會改計數器的指令。
# 每個表一個指令、一個區塊（ID 與指令一對一，--retry-failed 才能由 ### 標記找回 ID）；
# 只收 export 會解析的表（/ip firewall filter|nat|raw、/ipv6 firewall filter|raw）。
# 依據：https://manual.mikrotik.com/docs/firewall-and-quality-of-service/firewall/common-firewall-matchers-and-actions.md
#   （print stats 的 bytes、packets；print 預設等於 print static，只列靜態規則）
# 加 detail without-paging 的理由同其他指令：key=value 不受欄寬影響
# （https://manual.mikrotik.com/docs/developer-guides/scripting.md 的 print parameters）。
# stats 與 detail 並用的輸出格式手冊沒有範例，尚未以真實設備確認。
command_for_id() {
  case "$1" in
    config) printf '%s\n' '/export terse' ;;
    fwfilter) printf '%s\n' '/ip firewall filter print stats detail without-paging' ;;
    fwnat) printf '%s\n' '/ip firewall nat print stats detail without-paging' ;;
    fwraw) printf '%s\n' '/ip firewall raw print stats detail without-paging' ;;
    fw6filter) printf '%s\n' '/ipv6 firewall filter print stats detail without-paging' ;;
    fw6raw) printf '%s\n' '/ipv6 firewall raw print stats detail without-paging' ;;
    neighbor) printf '%s\n' '/ip neighbor print detail without-paging' ;;
    bridgehost) printf '%s\n' '/interface bridge host print detail without-paging' ;;
    route) printf '%s\n' '/ip route print detail without-paging' ;;
    arp) printf '%s\n' '/ip arp print detail without-paging' ;;
    system) printf '%s\n' '/system resource print' ;;
    vlans) printf '%s\n' '/interface bridge vlan print detail without-paging' ;;
    interface) printf '%s\n' '/interface print detail without-paging' ;;
    ipaddr) printf '%s\n' '/ip address print detail without-paging' ;;
    ospf) printf '%s\n' '/routing ospf neighbor print detail without-paging' ;;
    stp) printf '%s\n' '/interface bridge port monitor [find] once' ;;
    stpbridge) printf '%s\n' '/interface bridge monitor [find] once' ;;
    wifi) printf '%s\n' '/interface wifi registration-table print detail without-paging' ;;
    wireless) printf '%s\n' '/interface wireless registration-table print detail without-paging' ;;
    capsman) printf '%s\n' '/caps-man registration-table print detail without-paging' ;;
    *) return 1 ;;
  esac
}

# 由指令文字找回 ID（--retry-failed 讀上次收集檔的 ### 標記用）；不是收集器的指令時回傳非零
id_for_command() {
  local id
  for id in "${COLLECT_COMMAND_IDS[@]}" "${OPTIONAL_COMMAND_IDS[@]}"; do
    [[ "$(command_for_id "$id")" == "$1" ]] && { printf '%s\n' "$id"; return 0; }
  done
  return 1
}

# 自動加上選用指令的判斷，依據：
# - 介面 type：/interface print 中 wifi 套件的介面 type=wifi
#   （https://manual.mikrotik.com/docs/developer-guides/rest-api.md 的 /interface/print 範例），
#   wireless 套件的介面 type=wlan
#   （https://manual.mikrotik.com/docs/wireless/abgn/capsman/ap-controller-capsman.md 的 /interface print 範例）。
# - 型號：https://manual.mikrotik.com/docs/wireless.md、https://manual.mikrotik.com/docs/wireless/wifi.md、
#   https://manual.mikrotik.com/docs/getting-started/installation-and-upgrade/packages.md
#   802.11ax／be 的內建無線只能用 /interface wifi；802.11ac 可裝 wifi-qcom-ac 或 wireless，型號判斷不出來；
#   802.11n 以下用 wireless 套件，7.13 起另外安裝，型號判斷不出有沒有裝。
# - /interface wifi 選單 7.13 起才有（之前是 wifiwave2 套件），所以加 wifi 一律要 7.13 以上。
# CAPsMAN 控制器可以是任何型號、也沒有對應的介面 type，不自動判斷。
WIFI_INTERFACE_TYPE=wifi
WIRELESS_INTERFACE_TYPE=wlan

# 型號名稱中的無線標準：ax（含 be）、ac、n 或空。
# 認得獨立的字（cAP ax、hAP ac^2、hAP be lite）與產品代碼的無線段（C52iG-5HaxD2HaxD-TC）
board_wireless_standard() {
  local standard= word segment words=()
  read -ra words <<< "${1//-/ }"
  for word in ${words[@]+"${words[@]}"}; do
    if [[ "$word" =~ ^(ax|be|ac)([^A-Za-z]|$) ]]; then
      segment=${BASH_REMATCH[1]}
    elif [[ "$word" =~ ^((52|[256])(SHP|HP|H)?(n|ac|ax|be)[DTQPHSONE]?)+$ ]]; then
      segment=$word
    else
      continue
    fi
    case "$segment" in
      *be*|*ax*) standard=ax ;;
      *ac*) [[ "$standard" == ax ]] || standard=ac ;;
      *n*) [[ -n "$standard" ]] || standard=n ;;
    esac
  done
  printf '%s' "$standard"
}

# 版本是否 7.13 以上（/interface wifi 選單存在）；不符時把原因寫進 WIFI_VERSION_REASON
wifi_menu_available() {
  local version=$1
  WIFI_VERSION_REASON=
  if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+) ]]; then
    WIFI_VERSION_REASON='版本不明，無法確認是否為 7.13 以上'; return 1
  fi
  (( 10#${BASH_REMATCH[1]} > 7 || (10#${BASH_REMATCH[1]} == 7 && 10#${BASH_REMATCH[2]} >= 13) )) && return 0
  WIFI_VERSION_REASON="RouterOS $version 早於 7.13，Wi-Fi 選單是 wifiwave2"
  return 1
}

# auto_optional_commands BOARD VERSION INTERFACES_OK WIFI_NAMES WLAN_NAMES
# 結果：AUTO_COMMAND_IDS 與同索引的 AUTO_COMMAND_REASONS（要加的 ID 與依據）、
# AUTO_SKIP_REASONS（看得出有無線但不自動加的原因）。
# 介面 type 是實際裝了哪個套件、有哪些介面，比型號準：interface 收集成功時只依介面 type，
# 型號只在 interface 失敗時當輔助，所以兩者不會重複加，也不會因型號在沒有該介面的設備上誤加。
auto_optional_commands() {
  local board=$1 version=$2 interfaces_ok=$3 wifi_names=$4 wlan_names=$5 standard
  AUTO_COMMAND_IDS=(); AUTO_COMMAND_REASONS=(); AUTO_SKIP_REASONS=()
  standard=$(board_wireless_standard "$board")
  if (( interfaces_ok )); then
    if [[ -n "$wifi_names" ]]; then
      if wifi_menu_available "$version"; then
        AUTO_COMMAND_IDS+=(wifi); AUTO_COMMAND_REASONS+=("interface type=$WIFI_INTERFACE_TYPE：$wifi_names")
      else
        AUTO_SKIP_REASONS+=("interface type=$WIFI_INTERFACE_TYPE：$wifi_names；$WIFI_VERSION_REASON")
      fi
    fi
    if [[ -n "$wlan_names" ]]; then
      AUTO_COMMAND_IDS+=(wireless); AUTO_COMMAND_REASONS+=("interface type=$WIRELESS_INTERFACE_TYPE：$wlan_names")
    fi
    if [[ -z "$wifi_names$wlan_names" && -n "$standard" ]]; then
      AUTO_SKIP_REASONS+=("board-name=$board：沒有 type=$WIFI_INTERFACE_TYPE 或 $WIRELESS_INTERFACE_TYPE 的介面")
    fi
    return 0
  fi
  case "$standard" in
    ax)
      if wifi_menu_available "$version"; then
        AUTO_COMMAND_IDS+=(wifi); AUTO_COMMAND_REASONS+=("board-name=$board")
      else
        AUTO_SKIP_REASONS+=("board-name=$board：$WIFI_VERSION_REASON")
      fi ;;
    ac) AUTO_SKIP_REASONS+=("board-name=$board：802.11ac 可用 wifi 或 wireless，interface 未收集成功無法判斷，請在 extra 欄指定") ;;
    n) AUTO_SKIP_REASONS+=("board-name=$board：802.11n 用 wireless 套件，interface 未收集成功無法判斷，請在 extra 欄指定 wireless") ;;
  esac
  return 0
}
