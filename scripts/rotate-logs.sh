#!/usr/bin/env bash
#
# Daily rotation for the launchd-managed service logs.
#
# Why copy-and-truncate rather than rename: launchd opens StandardOutPath /
# StandardErrorPath itself and keeps the descriptor for the lifetime of the
# service. Renaming the file leaves launchd writing into the same (now renamed)
# inode, so the fresh file at the original path stays empty until the service
# restarts — the classic rotation trap for launchd/systemd-managed logs.
# Truncating keeps the inode, so the running service keeps writing to the same
# path with no restart and no lost lines.
#
# Every archive is kept (see docs/decision-brief.md, O2). Archives are gzipped;
# the service logs compress ~20x, so retention cost stays low.
#
# Safe to run repeatedly: empty logs are skipped, and a same-day second run gets
# a numeric suffix instead of clobbering the earlier archive.

set -euo pipefail
cd "$(dirname "$0")/.."

ARCHIVE_DIR="data/logs-archive"
mkdir -p "$ARCHIVE_DIR"

# --if-due: rotate only when today has no archive yet.
#
# Needed because the scheduler is an in-process interval, and an interval that
# counts from process start never fires for a service that restarts more often
# than its period -- this service restarted 13 times in one day during
# development, so a 24h timer would have rotated approximately never. Making the
# script itself decide whether rotation is due turns "every 24h of uptime" into
# "once a day", and makes a startup call safe to add.
IF_DUE=0
[ "${1:-}" = "--if-due" ] && IF_DUE=1

TODAY=$(date +%Y-%m-%d)

already_rotated_today() {
  local base="$1"
  ls "$ARCHIVE_DIR/$base-$TODAY"*.log.gz >/dev/null 2>&1
}

# Copy-and-truncate assumes launchd opened the log with O_APPEND, so that after
# truncation the next write lands at offset 0. If that assumption is ever wrong,
# the descriptor keeps its old offset and the kernel fills the gap with a hole:
# apparent size stays huge while allocated blocks stay near zero. Detect that
# divergence and say so loudly rather than silently rotating sparse files.
check_sparse() {
  local logfile="$1" apparent="$2"
  local blocks_kb
  blocks_kb=$(du -k "$logfile" | cut -f1)
  # A hole is only meaningful above ~1 MB; below that, filesystem rounding and
  # compression-friendly small files make the ratio noisy.
  if [ "$apparent" -gt 1048576 ] && [ "$((apparent / 1024))" -gt $((blocks_kb * 4)) ]; then
    echo "[rotate-logs] ⚠️  $logfile looks sparse (apparent $((apparent / 1024))KB vs allocated ${blocks_kb}KB)."
    echo "[rotate-logs] ⚠️  launchd likely did NOT open it with O_APPEND — copy-and-truncate is unsafe here."
    echo "[rotate-logs] ⚠️  Rotate by restarting the service instead (make launchd-restart), or switch to an app-managed log file."
  fi
}

rotate() {
  local logfile="$1"
  [ -f "$logfile" ] || return 0

  local base
  base=$(basename "$logfile" .log)

  if [ "$IF_DUE" -eq 1 ] && already_rotated_today "$base"; then
    echo "[rotate-logs] skip $logfile (already rotated today)"
    return 0
  fi

  local size
  size=$(wc -c < "$logfile" | tr -d ' ')
  if [ "$size" -eq 0 ]; then
    echo "[rotate-logs] skip $logfile (empty)"
    return 0
  fi

  local stamp target n
  stamp="$TODAY"
  target="$ARCHIVE_DIR/$base-$stamp.log.gz"
  n=1
  while [ -e "$target" ]; do
    target="$ARCHIVE_DIR/$base-$stamp.$n.log.gz"
    n=$((n + 1))
  done

  check_sparse "$logfile" "$size"

  # Copy first, truncate only after the archive is durably written — a crash
  # between the two costs a duplicate archive, never a lost log.
  gzip -c "$logfile" > "$target"
  sync
  : > "$logfile"

  echo "[rotate-logs] $logfile ($size bytes) -> $target"
}

rotate data/launchd-stdout.log
rotate data/launchd-stderr.log

echo "[rotate-logs] done: $(ls -1 "$ARCHIVE_DIR" | wc -l | tr -d ' ') archive(s) retained"
