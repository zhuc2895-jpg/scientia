"""Smoke-test the SCIENTIA Harness profile without making a model request."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[1]
PATCH = ROOT / "science_agent" / "harness.patch.yml"


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="scientia-profile-") as temporary:
        root = Path(temporary)
        workspace = root / "workspace"
        home = root / "dsh-home"
        workspace.mkdir()
        home.mkdir()
        os.environ.setdefault("DEEPSEEK_API_KEY", "sk-scientia-profile-check")
        harness = DeepSeekHarness(
            provider="deepseek-official",
            model=os.environ.get("DSH_MODEL", "deepseek-v4-flash"),
            cwd=str(workspace),
            dsh_home=str(home),
            profile="sdk-minimal",
            patches=(str(PATCH),),
        )
        try:
            harness.start()
            print("OK   Research profile: sdk-minimal + file tools + web search/fetch")
            return 0
        finally:
            harness.close()


if __name__ == "__main__":
    raise SystemExit(main())
