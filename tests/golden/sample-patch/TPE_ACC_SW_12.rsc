# topo-mikrotik ssot-patch/1 apply
# device: TPE_ACC_SW_12 (key TPE_ACC_SW_12)
# baseline: inputHash=eb41070625cffb63 createdAt=2026-01-01T00:00:00Z version=2.9.0
# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.
# items: 1
# Run: /import file-name=<this file> (add verbose=yes dry-run first to catch syntax errors).
# /import runs line by line and stops at the first error, so every pre-check comes before any change.

# ---- pre-checks
:if ([:len [/system ntp client servers find where address="10.1.10.2"]] != 1) do={ :error "topo-mikrotik pre-check failed: [1] A12 ntp servers /system ntp client servers must match exactly 1 entry(s)" }

# ---- apply
# [1] A12 ntp servers /system ntp client servers (sample-bundle.txt line 3666): before address=10.1.10.2
/system ntp client servers set [find where address="10.1.10.2"] address=time.cloudflare.com
