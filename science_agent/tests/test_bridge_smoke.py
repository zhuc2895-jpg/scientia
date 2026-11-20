from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "science_agent" / "bridge.py"
PATCH = ROOT / "science_agent" / "harness.patch.yml"

from science_agent.research_runtime import verified_claim_records


class BridgeSmokeTests(unittest.TestCase):
    def test_bridge_returns_artifacts_and_quality(self) -> None:
        with tempfile.TemporaryDirectory(prefix="scientia-bridge-") as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            home = root / "dsh-home"
            fake_package = root / "fake-package"
            workspace.mkdir()
            home.mkdir()
            fake_package.mkdir()
            (workspace / "source.md").write_text("A source-backed observation.", encoding="utf-8")
            (fake_package / "deepseek_harness.py").write_text(textwrap.dedent("""
                import json
                import re
                from pathlib import Path

                class Result:
                    session_id = "smoke-session"
                    finish_reason = "completed"
                    final_response = "Observed in [1]. Limitation: synthetic smoke test."

                class DeepSeekHarness:
                    def __init__(self, **kwargs):
                        self.cwd = Path(kwargs["cwd"])

                    def __enter__(self):
                        return self

                    def __exit__(self, exc_type, exc, traceback):
                        return False

                    def run(self, prompt, session_id=None, on_notification=None):
                        if "Application source registration gate" not in prompt:
                            raise RuntimeError("source registration gate missing from prompt")
                        if "Project Source Library contains 1 registered Source Record(s)" not in prompt:
                            raise RuntimeError("registered source count missing from prompt")
                        if "Application-selected Active Source Set" not in prompt:
                            raise RuntimeError("active source set missing from prompt")
                        if ".science/sources/source.md" not in prompt:
                            raise RuntimeError("registered source locator missing from prompt")
                        if "The Active Source Set is the citation boundary" not in prompt:
                            raise RuntimeError("active source citation boundary missing from prompt")
                        if "contentHash=" not in prompt:
                            raise RuntimeError("active source content hash missing from prompt")
                        if "sourceContentHash" not in prompt:
                            raise RuntimeError("evidence content hash contract missing from prompt")
                        if "verifiedClaims=" not in prompt:
                            raise RuntimeError("verified claims missing from prompt")
                        output_dir = next((self.cwd / ".science" / "outputs").iterdir())
                        (output_dir / "report.md").write_text("# Smoke report\\nSupported by [1].\\n", encoding="utf-8")
                        ledger_match = re.search(r"The evidence ledger is `([^`]+)`", prompt)
                        ledger = self.cwd / ledger_match.group(1)
                        ledger.parent.mkdir(parents=True, exist_ok=True)
                        ledger.write_text(json.dumps({
                            "claim": "A source-backed observation.",
                            "source": "source.md",
                            "sourceContentHash": "a" * 64,
                            "locator": "line 1",
                            "quote": "A source-backed observation.",
                            "confidence": "high",
                            "addedAt": "2026-11-16T00:00:00+00:00",
                            "citationNumber": 1
                        }) + "\\n", encoding="utf-8")
                        return Result()
            """), encoding="utf-8")

            request = {
                "runId": "run-smoke",
                "conversationId": "session-smoke",
                "prompt": "生成一份带引用的研究报告。",
                "workspace": str(workspace),
                "dshHome": str(home),
                "patchPath": str(PATCH),
                "maxTokens": 49152,
                "evidenceMode": True,
                "mode": "literature",
                "stageKey": "evidence",
                "activeSources": [{
                    "id": "source-1",
                    "title": "Registered source",
                    "authors": ["Jane Smith"],
                    "year": 2026,
                    "stableIdentifier": "doi:10.1000/smoke",
                    "localLocator": ".science/sources/source.md",
                    "contentHash": "a" * 64,
                    "observedContentHash": "a" * 64,
                    "verificationState": "verified",
                    "freshnessState": "current",
                    "metadata": {
                        "verification": {
                            "locator": "line 1",
                            "quote": "A source-backed observation.",
                            "claim": "A source-backed observation.",
                            "contentHash": "a" * 64,
                        },
                    },
                }],
                "projectSources": [{
                    "id": "source-1",
                    "title": "Registered source",
                    "authors": ["Jane Smith"],
                    "year": 2026,
                    "stableIdentifier": "doi:10.1000/smoke",
                    "localLocator": ".science/sources/source.md",
                    "contentHash": "a" * 64,
                    "observedContentHash": "a" * 64,
                    "verificationState": "verified",
                    "freshnessState": "current",
                    "metadata": {
                        "verification": {
                            "locator": "line 1",
                            "quote": "A source-backed observation.",
                            "claim": "A source-backed observation.",
                            "contentHash": "a" * 64,
                        },
                    },
                }],
                "researchCharter": {
                    "version": 2,
                    "status": "approved",
                    "question": "What does the source support?",
                    "contribution": "Test the run contract.",
                    "scope": "One synthetic source.",
                    "methodConstraints": "Use the supplied source.",
                    "successCriteria": "A traceable report.",
                    "paperType": "Research article",
                    "citationStyle": "Vancouver",
                    "dataPolicy": "standard",
                },
            }
            env = dict(os.environ)
            env["PYTHONPATH"] = str(fake_package) + os.pathsep + env.get("PYTHONPATH", "")
            env["DEEPSEEK_API_KEY"] = "sk-smoke"
            env["DSH_MODEL"] = "smoke-model"
            completed = subprocess.run(
                [sys.executable, str(BRIDGE)],
                input=json.dumps(request, ensure_ascii=False) + "\n",
                text=True,
                encoding="utf-8",
                capture_output=True,
                cwd=str(ROOT),
                env=env,
                timeout=20,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            events = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
            result = next(event for event in events if event.get("type") == "result")
            self.assertEqual(result["runId"], "run-smoke")
            self.assertEqual(result["quality"]["warnings"], 0)
            self.assertEqual(result["run"]["stageKey"], "evidence")
            self.assertEqual(result["run"]["researchCharterVersion"], 2)
            self.assertEqual(result["artifacts"][0]["name"], "report.md")
            self.assertEqual(len(result["artifacts"][0]["sha256"]), 64)
            manifests = list((workspace / ".science" / "runs").rglob("manifest.json"))
            self.assertEqual(len(manifests), 1)
            manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "completed")
            self.assertEqual(manifest["mode"], "literature")
            self.assertEqual(manifest["stageKey"], "evidence")
            self.assertEqual(manifest["researchCharter"]["version"], 2)


    def test_bridge_returns_a_structured_charter_draft(self) -> None:
        with tempfile.TemporaryDirectory(prefix="scientia-bridge-charter-") as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            home = root / "dsh-home"
            fake_package = root / "fake-package"
            workspace.mkdir()
            home.mkdir()
            fake_package.mkdir()
            (fake_package / "deepseek_harness.py").write_text(textwrap.dedent("""
                import json
                from pathlib import Path

                class Result:
                    session_id = "charter-session"
                    finish_reason = "completed"
                    final_response = "Drafted the Research Charter for review."

                class DeepSeekHarness:
                    def __init__(self, **kwargs):
                        self.cwd = Path(kwargs["cwd"])

                    def __enter__(self):
                        return self

                    def __exit__(self, exc_type, exc, traceback):
                        return False

                    def run(self, prompt, session_id=None, on_notification=None):
                        if "Application source registration gate" not in prompt:
                            raise RuntimeError("source registration gate missing for empty active set")
                        if "Active Source Set for this Conversation is empty" not in prompt:
                            raise RuntimeError("empty active source set rule missing")
                        output_dir = next((self.cwd / ".science" / "outputs").iterdir())
                        (output_dir / "research-charter.json").write_text(json.dumps({
                            "question": "How does the intervention affect the outcome?",
                            "contribution": "Clarify the current evidence boundary.",
                            "scope": "Adults in randomized trials.",
                            "methodConstraints": "Prefer primary studies.",
                            "successCriteria": "A traceable synthesis.",
                            "paperType": "Review",
                            "citationStyle": "Vancouver",
                            "dataPolicy": "standard"
                        }), encoding="utf-8")
                        return Result()
            """), encoding="utf-8")

            request = {
                "runId": "run-charter-smoke",
                "conversationId": "session-charter-smoke",
                "prompt": "Design a review of the intervention.",
                "workspace": str(workspace),
                "dshHome": str(home),
                "patchPath": str(PATCH),
                "maxTokens": 49152,
                "evidenceMode": True,
                "mode": "literature",
                "projectId": "project-charter-smoke",
                "stageKey": "scoping",
                "charterDraftMode": True,
            }
            env = dict(os.environ)
            env["PYTHONPATH"] = str(fake_package) + os.pathsep + env.get("PYTHONPATH", "")
            env["DEEPSEEK_API_KEY"] = "sk-smoke"
            env["DSH_MODEL"] = "smoke-model"
            completed = subprocess.run(
                [sys.executable, str(BRIDGE)],
                input=json.dumps(request, ensure_ascii=False) + "\n",
                text=True,
                encoding="utf-8",
                capture_output=True,
                cwd=str(ROOT),
                env=env,
                timeout=20,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            events = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
            result = next(event for event in events if event.get("type") == "result")
            self.assertEqual(result["charterDraft"]["question"], "How does the intervention affect the outcome?")
            self.assertEqual(result["charterDraft"]["citationStyle"], "Vancouver")
            self.assertNotIn("charterDraftError", result)
            manifest = list((workspace / ".science" / "runs").rglob("manifest.json"))[0]
            saved = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(saved["stageKey"], "scoping")
            self.assertEqual(saved["projectId"], "project-charter-smoke")
            self.assertTrue(saved["charterDraftMode"])


class BridgePromptEvidenceTests(unittest.TestCase):
    def test_stale_sources_do_not_forward_old_verified_claims(self) -> None:
        source = {
            "verificationState": "verified",
            "freshnessState": "stale",
            "contentHash": "a" * 64,
            "observedContentHash": "b" * 64,
            "metadata": {
                "verification": {
                    "locator": "line:1",
                    "quote": "Old quote.",
                    "claim": "Old claim.",
                    "contentHash": "a" * 64,
                },
            },
        }
        self.assertEqual(verified_claim_records(source), [])

    def test_only_claims_bound_to_the_current_hash_are_forwarded(self) -> None:
        source = {
            "verificationState": "verified",
            "freshnessState": "current",
            "contentHash": "a" * 64,
            "observedContentHash": "b" * 64,
            "metadata": {
                "verifications": [
                    {"locator": "line:1", "quote": "Old quote.", "claim": "Old claim.", "contentHash": "a" * 64},
                    {"locator": "line:2", "quote": "Current quote.", "claim": "Current claim.", "contentHash": "b" * 64},
                ],
            },
        }
        claims = verified_claim_records(source)
        self.assertEqual([claim["claim"] for claim in claims], ["Current claim."])


if __name__ == "__main__":
    unittest.main()
