# topo-mikrotik ssot-patch/1 apply
# device: TPE_CORE_RT_02 (key TPE_CORE_RT_02)
# baseline: inputHash=71ce67d5814096d4 createdAt=2026-01-01T00:00:00Z version=2.10.0
# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.
# items: 1
# Run: /import file-name=<this file> (add verbose=yes dry-run first to catch syntax errors).
# /import runs line by line and stops at the first error, so every pre-check comes before any change.

# ---- pre-checks
:if ([:len [/ip firewall filter find where chain="input" action="accept" protocol="udp" src-port="53"]] != 1) do={ :error "topo-mikrotik pre-check failed: [1] F06 ip filter input rule 4 must match exactly 1 rule(s)" }

# ---- apply
# [1] F06 ip filter input rule 4 (sample-bundle.txt line 927): before disabled=no
/ip firewall filter set [find where chain="input" action="accept" protocol="udp" src-port="53"] disabled=yes
