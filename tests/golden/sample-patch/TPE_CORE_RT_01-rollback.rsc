# topo-mikrotik ssot-patch/1 rollback
# device: TPE_CORE_RT_01 (key TPE_CORE_RT_01)
# baseline: inputHash=bd17113eef3dfbec createdAt=2026-01-01T00:00:00Z version=2.7.0
# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.
# items: 1
# Restores the values recorded in the baseline (before), in reverse order of the apply file.

# ---- pre-checks
:if ([:len [/ip firewall filter find where chain="input" action="accept" dst-port="8291" in-interface="ether47" protocol="tcp"]] != 1) do={ :error "topo-mikrotik pre-check failed: [1] F01 ip filter input rule 6 must match exactly 1 rule(s)" }

# ---- rollback
# [1] F01 ip filter input rule 6 (sample-bundle.txt line 121): restore disabled=no
/ip firewall filter set [find where chain="input" action="accept" dst-port="8291" in-interface="ether47" protocol="tcp"] disabled=no
