#!/usr/bin/env bash

COLLECT_COMMAND_IDS=(config neighbor bridgehost route arp system vlans interface ipaddr ospf stp stpbridge)
# 選用：只有部分設備才有的選單（Wi-Fi AP、CAPsMAN 控制器），不在預設清單；
# 用 --commands 或設備清單的 extra 欄指定，避免在交換器上執行而得到錯誤回應
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
