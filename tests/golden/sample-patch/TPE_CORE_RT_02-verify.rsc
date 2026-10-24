# topo-mikrotik ssot-patch/1 verify
# device: TPE_CORE_RT_02 (key TPE_CORE_RT_02)
# baseline: inputHash=bd17113eef3dfbec createdAt=2026-01-01T00:00:00Z version=2.7.0
# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.
# items: 1
# Run after the apply file. Each print must list exactly the number of rules stated.

# [1] F06 ip filter input rule 4 (sample-bundle.txt line 927): expect 1 rule, flagged X (disabled)
/ip firewall filter print where chain="input" action="accept" protocol="udp" src-port="53"
