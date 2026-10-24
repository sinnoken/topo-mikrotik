#!/usr/bin/env bash

COLLECT_COMMAND_IDS=(config neighbor bridgehost route arp system vlans interface ipaddr ospf stp stpbridge)
# 選用：只有部分設備才有的選單（Wi-Fi AP、CAPsMAN 控制器），不在預設清單；
# 用 --commands 或設備清單的 extra 欄指定，避免在交換器上執行而得到錯誤回應；
# 確定支援的型號會依 auto_optional_commands 自動加上
OPTIONAL_COMMAND_IDS=(wifi wireless capsman)

command_for_id() {
  case "$1" in
    config) printf '%s\n' '/export terse' ;;
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

# 依 /system resource print 的 board-name 與 version 自動加上的選用指令。
# 結果放在 AUTO_COMMAND_IDS（要加的 ID）與 AUTO_SKIP_REASON（認得無線型號但不自動加的原因）。
# 只在確定的情況加上（依據：https://manual.mikrotik.com/docs/wireless.md、
# https://manual.mikrotik.com/docs/wireless/wifi.md、
# https://manual.mikrotik.com/docs/getting-started/installation-and-upgrade/packages.md）：
# - 802.11ax／be 的內建無線只能用 /interface wifi（wifi-qcom、wifi-qcom-be、wifi-mediatek），
#   而這個選單 7.13 起才叫 wifi（之前是 wifiwave2 套件），所以要 7.13 以上。
# - 802.11ac 可裝 wifi-qcom-ac（/interface wifi）或 wireless（/interface wireless），型號判斷不出來。
# - 802.11n 以下用 wireless 套件，7.13 起是另外安裝的套件，型號判斷不出有沒有裝。
# - CAPsMAN 控制器可以是任何型號，也判斷不出來。
auto_optional_commands() {
  local board=$1 version=$2 standard= word segment words=()
  AUTO_COMMAND_IDS=(); AUTO_SKIP_REASON=
  # 型號名稱中的無線標準：獨立的字（cAP ax、hAP ac^2、hAP be lite）或產品代碼的無線段（C52iG-5HaxD2HaxD-TC）
  read -ra words <<< "${board//-/ }"
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
  case "$standard" in
    ax)
      if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+) ]]; then
        AUTO_SKIP_REASON='版本不明，無法確認是否為 7.13 以上'
      elif (( 10#${BASH_REMATCH[1]} > 7 || (10#${BASH_REMATCH[1]} == 7 && 10#${BASH_REMATCH[2]} >= 13) )); then
        AUTO_COMMAND_IDS=(wifi)
      else
        AUTO_SKIP_REASON="RouterOS $version 早於 7.13，Wi-Fi 選單是 wifiwave2"
      fi ;;
    ac) AUTO_SKIP_REASON='802.11ac 可用 wifi 或 wireless，請在 extra 欄指定' ;;
    n) AUTO_SKIP_REASON='802.11n 用 wireless 套件，請在 extra 欄指定 wireless' ;;
  esac
}
