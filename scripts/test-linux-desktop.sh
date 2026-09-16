#!/usr/bin/env bash
set -euo pipefail
# Xvfb supplies a display, but maximize/minimize require a real window manager.
openbox > /tmp/workspace-openbox.log 2>&1 &
window_manager_pid=$!
trap 'kill "$window_manager_pid" 2>/dev/null || true' EXIT
for attempt in {1..50}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'; then
    npm run test:desktop
    exit $?
  fi
  sleep 0.1
done
echo 'Window manager did not become ready' >&2
exit 1
