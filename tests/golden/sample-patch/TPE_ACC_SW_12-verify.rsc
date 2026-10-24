# topo-mikrotik ssot-patch/1 verify
# device: TPE_ACC_SW_12 (key TPE_ACC_SW_12)
# baseline: inputHash=cb6374d0bf9a2de6 createdAt=2026-01-01T00:00:00Z version=2.11.0
# Text only: topo-mikrotik never connects to or changes a device. Review every line before use.
# items: 1
# Run after the apply file. Each print must list exactly the number of rules stated.

# [1] A12 ntp servers /system ntp client servers (sample-bundle.txt line 3770): expect 1 entry
/system ntp client servers print where address="time.cloudflare.com"
