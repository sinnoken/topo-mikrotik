# topo-mikrotik ssot-patch/1 verify
# device: TPE_CORE_RT_01 (key TPE_CORE_RT_01)
# baseline: inputHash=eb41070625cffb63 createdAt=2026-01-01T00:00:00Z version=2.9.0
# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.
# items: 2
# Run after the apply file. Each print must list exactly the number of rules stated.

# [1] A12 dns servers /ip dns (sample-bundle.txt line 95): expect servers 8.8.8.8 (in this order)
:put [/ip dns get servers]
# [2] F01 ip filter input rule 6 (sample-bundle.txt line 121): expect 1 rule, flagged X (disabled)
/ip firewall filter print where chain="input" action="accept" dst-port="8291" in-interface="ether47" protocol="tcp"
