# topo-mikrotik ssot-patch/1 rollback
# device: TPE_ACC_SW_12 (key TPE_ACC_SW_12)
# baseline: inputHash=83a376c2f1dcdd12 createdAt=2026-01-01T00:00:00Z version=3.0.0
# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.
# items: 1
# Restores the values recorded in the baseline (before), in reverse order of the apply file.

# ---- pre-checks
:if ([:len [/system ntp client servers find where address="time.cloudflare.com"]] != 1) do={ :error "topo-mikrotik pre-check failed: [1] A12 ntp servers /system ntp client servers must match exactly 1 entry(s)" }

# ---- rollback
# [1] A12 ntp servers /system ntp client servers (sample-bundle.txt line 3770): restore address=10.1.10.2
/system ntp client servers set [find where address="time.cloudflare.com"] address=10.1.10.2
