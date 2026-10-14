#!/usr/bin/env bash

COLLECT_COMMAND_IDS=(config neighbor bridgehost route arp system vlans interface ipaddr ospf)

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
    *) return 1 ;;
  esac
}
