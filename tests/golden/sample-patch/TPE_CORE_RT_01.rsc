# topo-mikrotik ssot-patch/1 apply
# device: TPE_CORE_RT_01 (key TPE_CORE_RT_01)
# baseline: inputHash=71ce67d5814096d4 createdAt=2026-01-01T00:00:00Z version=2.10.0
# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.
# items: 2
# Run: /import file-name=<this file> (add verbose=yes dry-run first to catch syntax errors).
# /import runs line by line and stops at the first error, so every pre-check comes before any change.

# ---- pre-checks
# [1] A12 dns servers /ip dns: compare servers item by item with :len, :pick and :tostr (confirm on a test router first)
:if ([:len [/ip dns get servers]] != 2) do={ :error "topo-mikrotik pre-check failed: [1] A12 dns servers /ip dns servers differ from the baseline" }
:if ([:tostr [:pick [/ip dns get servers] 0]] != "1.1.1.1") do={ :error "topo-mikrotik pre-check failed: [1] A12 dns servers /ip dns servers differ from the baseline" }
:if ([:tostr [:pick [/ip dns get servers] 1]] != "8.8.8.8") do={ :error "topo-mikrotik pre-check failed: [1] A12 dns servers /ip dns servers differ from the baseline" }
:if ([:len [/ip firewall filter find where chain="input" action="accept" dst-port="8291" in-interface="ether47" protocol="tcp"]] != 1) do={ :error "topo-mikrotik pre-check failed: [2] F01 ip filter input rule 6 must match exactly 1 rule(s)" }

# ---- apply
# [1] A12 dns servers /ip dns (sample-bundle.txt line 95): before servers=1.1.1.1,8.8.8.8
/ip dns set servers=8.8.8.8
# [2] F01 ip filter input rule 6 (sample-bundle.txt line 121): before disabled=no
/ip firewall filter set [find where chain="input" action="accept" dst-port="8291" in-interface="ether47" protocol="tcp"] disabled=yes
