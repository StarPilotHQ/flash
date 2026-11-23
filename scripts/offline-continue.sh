#!/bin/bash
set -euo pipefail

cd /data
if [ -d .starpilot-offline ]; then
  sudo chown -R --no-dereference comma:comma -- .starpilot-offline
  python3 .starpilot-offline/settings.py || echo "Could not apply pre-loaded recovery settings." >&2
  if [ ! -e .starpilot-offline/revision ] && [ ! -e .starpilot-offline/fork.pack ]; then
    rm -f -- /data/continue.sh
    rm -rf -- .starpilot-offline
    exec /bin/bash /usr/comma/comma.sh
  fi
  if [ ! -e openpilot ]; then
    rm -rf -- .starpilot-install
    mkdir .starpilot-install
    if [ -e .starpilot-offline/fork.pack ]; then
      python3 .starpilot-offline/fork.py
    else
      cp -R -- .starpilot-offline/git .starpilot-install/.git
      git -C .starpilot-install config core.ignoreCase false
      git -C .starpilot-install -c core.hooksPath=/dev/null reset --hard HEAD
    fi
    test "$(git -C .starpilot-install rev-parse HEAD)" = "$(cat .starpilot-offline/revision)"
    test -x .starpilot-install/launch_openpilot.sh
    mv -T -- .starpilot-install openpilot
  fi
  test "$(git -C openpilot rev-parse HEAD)" = "$(cat .starpilot-offline/revision)"
  sync -f openpilot
  rm -rf -- .starpilot-offline
fi

cd /data/openpilot
exec ./launch_openpilot.sh
