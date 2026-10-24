# topo-mikrotik ssot-patch/1 rollback
# device: TPE_CORE_RT_02 (key TPE_CORE_RT_02)
# baseline: inputHash=eb41070625cffb63 createdAt=2026-01-01T00:00:00Z version=2.9.0
# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.
# items: 1
# Restores the values recorded in the baseline (before), in reverse order of the apply file.

# ---- pre-checks
:if ([:len [/ip firewall filter find where chain="input" action="accept" protocol="udp" src-port="53"]] != 1) do={ :error "topo-mikrotik pre-check failed: [1] F06 ip filter input rule 4 must match exactly 1 rule(s)" }

# ---- rollback
# [1] F06 ip filter input rule 4 (sample-bundle.txt line 927): restore disabled=no
/ip firewall filter set [find where chain="input" action="accept" protocol="udp" src-port="53"] disabled=no
