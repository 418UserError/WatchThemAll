#!/usr/bin/env python3
"""
WatchThemAll — Build Script
Produces installable desktop packages via electron-builder.

Usage:
  python3 scripts/build.py linux     → dist-packages/WatchThemAll-*.AppImage + .deb
  python3 scripts/build.py win       → dist-packages/WatchThemAll Setup *.exe
  python3 scripts/build.py mac       → dist-packages/WatchThemAll-*.dmg
  python3 scripts/build.py all       → linux + win + mac (if supported)

Requires: npm (electron-builder is a dev dependency)
"""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def build(target):
    """Run electron-builder for the given target."""
    print(f"Building for {target} ...")

    cmd = ["npx", "electron-builder", f"--{target}"]
    result = subprocess.run(cmd, cwd=str(ROOT))

    if result.returncode != 0:
        print(f"Build failed for {target}", file=sys.stderr)
        sys.exit(result.returncode)

    print(f"  → packages in {ROOT / 'dist-packages'}/")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    target = sys.argv[1]

    if target == "all":
        # Build for current platform only (cross-platform builds need platform-specific CI)
        plat = sys.platform
        if plat == "linux":
            build("linux")
        elif plat == "darwin":
            build("mac")
        elif plat == "win32":
            build("win")
        else:
            print(f"Unknown platform: {plat}", file=sys.stderr)
            sys.exit(1)
    elif target in ("linux", "win", "mac"):
        build(target)
    else:
        print(f"Unknown target: {target}", file=sys.stderr)
        print("Valid targets: linux, win, mac, all")
        sys.exit(1)

    print("Done.")


if __name__ == "__main__":
    main()
