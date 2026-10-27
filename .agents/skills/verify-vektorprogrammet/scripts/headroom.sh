#!/usr/bin/env bash
# Admission control for a heavy job (the stack = PostgreSQL work + the CMS + vp dev, plus a headless Chromium).
# Samples live machine state and exits 0 only when every resource keeps at least 20% headroom after the job's
# expected demand. Usage: scripts/headroom.sh [path-the-job-writes-to ...]   (default: the evidence root)
#
# Demand figures. MEMORY is measured: the idle stack (serve.ts and its 8 descendants: vp dev, workerd, the CMS, Vite)
# had 5545 MiB summed RSS on 2026-10-27 at 9ee265f (RSS double-counts shared pages, so this errs high); a Chromium
# for the specs is assumed at 1.5 GiB more. CPUS and DISK are assumptions, not measurements (a run wrote ~3 MiB of
# evidence; 2 GiB is a ceiling for traces of long journeys). Override per call, or fix them here when measured.
DEMAND_CPUS="${DEMAND_CPUS:-4}"           # cores the stack plus a browser use at their peak
DEMAND_MEM_MIB="${DEMAND_MEM_MIB:-7168}"  # MiB the stack plus a browser hold at their peak
DEMAND_DISK_MIB="${DEMAND_DISK_MIB:-2048}"
SAMPLE_SECONDS=3

# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mkdir -p "$EVIDENCE_ROOT"
paths=("${@:-$EVIDENCE_ROOT}" "$TREE")

cpu_line() { awk '/^cpu /{idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print idle, total}' /proc/stat; }
# io_ticks (ms the device was busy) for one block device name, field 13 of /proc/diskstats.
io_ticks() { awk -v d="$1" '$3==d{print $13}' /proc/diskstats; }
# The block device name behind the filesystem that holds a path.
device_of() { basename "$(readlink -f "$(df --output=source "$1" | tail -1)")"; }

declare -A devices=()
for path in "${paths[@]}"; do devices["$(device_of "$path")"]=1; done

swapin() { awk '/^pswpin /{print $2}' /proc/vmstat; }

read -r idle0 total0 < <(cpu_line)
swapin0="$(swapin)"
declare -A ticks0=()
for device in "${!devices[@]}"; do ticks0[$device]="$(io_ticks "$device")"; done
sleep "$SAMPLE_SECONDS"
read -r idle1 total1 < <(cpu_line)
swapin1="$(swapin)"

fail=0
check() { # name, ok(0/1), detail
  if [[ "$2" == 0 ]]; then echo "ok    $1: $3"; else echo "SHORT $1: $3"; fail=1; fi
}

nproc="$(nproc)"
idle_pct=$(awk -v i0="$idle0" -v i1="$idle1" -v t0="$total0" -v t1="$total1" 'BEGIN{printf "%.1f", 100*(i1-i0)/(t1-t0)}')
# Unused cores after the job, as a percentage of all cores.
cpu_after=$(awk -v idle="$idle_pct" -v n="$nproc" -v d="$DEMAND_CPUS" 'BEGIN{printf "%.1f", idle - 100*d/n}')
check "cpu" "$(awk -v a="$cpu_after" 'BEGIN{print (a>=20)?0:1}')" "idle ${idle_pct}% now, ${cpu_after}% after ${DEMAND_CPUS} cores (need >= 20%)"

mem_total_kib=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
mem_avail_kib=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
mem_after=$(awk -v a="$mem_avail_kib" -v t="$mem_total_kib" -v d="$DEMAND_MEM_MIB" 'BEGIN{printf "%.1f", 100*(a-d*1024)/t}')
check "memory" "$(awk -v a="$mem_after" 'BEGIN{print (a>=20)?0:1}')" "MemAvailable $((mem_avail_kib / 1024)) MiB of $((mem_total_kib / 1024)) MiB, ${mem_after}% free after ${DEMAND_MEM_MIB} MiB (need >= 20%)"

swap_total_kib=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
swap_free_kib=$(awk '/^SwapFree:/{print $2}' /proc/meminfo)
if [[ "$swap_total_kib" -gt 0 ]]; then
  swap_free_pct=$(awk -v f="$swap_free_kib" -v t="$swap_total_kib" 'BEGIN{printf "%.1f", 100*f/t}')
  check "swap" "$(awk -v a="$swap_free_pct" 'BEGIN{print (a>=20)?0:1}')" "${swap_free_pct}% free (need >= 20%)"
fi

# Swap-in rate over the sample window (pswpin is cumulative pages): a machine that keeps swapping in is short of memory
# whatever MemAvailable says. The threshold is a judgement, not a measurement: 1000 pages/s is about 4 MiB/s, which
# idle desktops with a large swap file stay under between bursts (a sample of 221 pages/s was seen on a quiet host).
swapin_rate=$(( (swapin1 - swapin0) / SAMPLE_SECONDS ))
check "swap-in" "$([[ "$swapin_rate" -le 1000 ]] && echo 0 || echo 1)" "${swapin_rate} pages/s over ${SAMPLE_SECONDS}s (need <= 1000)"

for device in "${!devices[@]}"; do
  ticks1="$(io_ticks "$device")"
  if [[ -z "${ticks0[$device]}" || -z "$ticks1" ]]; then
    check "device $device" 1 "no /proc/diskstats entry: utilisation unknown"
    continue
  fi
  busy_pct=$(awk -v a="${ticks0[$device]}" -v b="$ticks1" -v s="$SAMPLE_SECONDS" 'BEGIN{printf "%.1f", 100*(b-a)/(s*1000)}')
  check "device $device" "$(awk -v b="$busy_pct" 'BEGIN{print (b<=80)?0:1}')" "busy ${busy_pct}% over ${SAMPLE_SECONDS}s (need idle >= 20%)"
done

for path in "${paths[@]}"; do
  free_mib=$(df --output=avail -BM "$path" | tail -1 | tr -dc '0-9')
  check "disk $path" "$([[ "$free_mib" -ge $((DEMAND_DISK_MIB * 2)) ]] && echo 0 || echo 1)" "${free_mib} MiB free (need >= $((DEMAND_DISK_MIB * 2)) MiB: twice the expected ${DEMAND_DISK_MIB} MiB of writes)"
done

# Reported, not gated: I/O PSI counts stalled tasks, not device load.
for resource in cpu memory io; do
  echo "info  psi $resource: $(grep '^some' "/proc/pressure/$resource" | cut -d' ' -f2)"
done
echo "info  load average: $(cut -d' ' -f1-3 /proc/loadavg) on ${nproc} cores"

if [[ "$fail" != 0 ]]; then
  echo "headroom is short: wait for a running job to exit, or run a smaller scope (VERIFY_FORCE=1 overrides, and the run must say so)" >&2
  exit 1
fi
