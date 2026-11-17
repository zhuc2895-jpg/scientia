from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from science_agent.research_runtime import assess_result, finalize_research_run, prepare_research_run


class ResearchRuntimeTests(unittest.TestCase):
    def test_prepare_and_finalize_records_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            (workspace / "paper.md").write_text("# Source\nA measured result.", encoding="utf-8")

            context = prepare_research_run(
                workspace,
                conversation_id="conversation-1",
                run_id="run-1",
                prompt="生成一份带引用的研究简报。",
                model="deepseek-v4-flash",
                mode="literature",
            )

            self.assertTrue((workspace / context["briefPath"]).is_file())
            self.assertTrue((workspace / context["outputDir"]).is_dir())
            brief = (workspace / context["briefPath"]).read_text(encoding="utf-8")
            self.assertIn("paper.md", brief)
            self.assertIn("文献研究", brief)

            ledger = workspace / context["evidencePath"]
            ledger.write_text(
                json.dumps({
                    "claim": "A measured result.",
                    "source": "paper.md",
                    "locator": "line 2",
                    "quote": "A measured result.",
                    "confidence": "high",
                    "addedAt": "2026-11-16T00:00:00+00:00",
                }, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            report = workspace / context["outputDir"] / "brief.md"
            report.write_text("# Brief\nSee [1]. Unknowns: none confirmed.\n", encoding="utf-8")

            result = finalize_research_run(
                workspace,
                run_context=context,
                result_text="Observed in [1]. Limitation: one source only.",
                prompt="生成一份带引用的研究简报。",
                session_id="conversation-1",
                finish_reason="completed",
            )

            self.assertEqual(result["quality"]["warnings"], 0)
            self.assertEqual(result["quality"]["evidenceAdded"], 1)
            self.assertEqual(result["quality"]["artifactCount"], 1)
            self.assertEqual(result["artifacts"][0]["name"], "brief.md")
            self.assertEqual(len(result["artifacts"][0]["sha256"]), 64)
            manifest = workspace / ".science" / "runs" / context["sessionKey"] / context["runKey"] / "manifest.json"
            self.assertTrue(manifest.is_file())
            saved = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(saved["status"], "completed")
            self.assertEqual(saved["evidenceAdded"], 1)

    def test_assess_result_flags_missing_delivery_evidence(self) -> None:
        quality = assess_result(
            "A confident answer without provenance.",
            "导出论文图表并生成报告。",
            [],
            0,
        )
        self.assertGreaterEqual(quality["warnings"], 3)
        artifact_check = next(check for check in quality["checks"] if check["id"] == "artifacts")
        self.assertEqual(artifact_check["status"], "warn")


if __name__ == "__main__":
    unittest.main()
