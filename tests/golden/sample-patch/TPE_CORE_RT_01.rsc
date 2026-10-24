# topo-mikrotik ssot-patch/1 apply
# device: TPE_CORE_RT_01 (key TPE_CORE_RT_01)
# baseline: inputHash=28211e6ceb748690 createdAt=2026-01-01T00:00:00Z version=2.8.0
# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.
# items: 1
# Run: /import file-name=<this file> (add verbose=yes dry-run first to catch syntax errors).
# /import runs line by line and stops at the first error, so every pre-check comes before any change.

# ---- pre-checks
:if ([:len [/ip firewall filter find where chain="input" action="accept" dst-port="8291" in-interface="ether47" protocol="tcp"]] != 1) do={ :error "topo-mikrotik pre-check failed: [1] F01 ip filter input rule 6 must match exactly 1 rule(s)" }

# ---- apply
# [1] F01 ip filter input rule 6 (sample-bundle.txt line 121): before disabled=no
/ip firewall filter set [find where chain="input" action="accept" dst-port="8291" in-interface="ether47" protocol="tcp"] disabled=yes
