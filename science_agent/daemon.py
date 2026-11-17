"""Persistent local daemon for SCIENTIA.

The desktop shell owns this daemon. The daemon owns turn lifecycle, cancellation,
status, and recovery boundaries. Each research turn is executed by the one-shot
bridge process, which delegates the actual model/tool loop to DeepSeek Harness.

This mirrors ClawsGO's shell -> daemon -> turn-process separation while keeping
exactly one Science Agent and DeepSeek Harness as the execution kernel.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
BRIDGE = ROOT / "bridge.py"
LOCK = threading.Lock()
ACTIVE: dict[str, Any] | None = None
STOPPING = threading.Event()


def emit(payload: dict[str, Any]) -> None:
    with LOCK:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    else:
        process.terminate()
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            process.kill()


def monitor_worker(run_id: str, process: subprocess.Popen[str]) -> None:
    global ACTIVE

    def read_stdout() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError("worker event is not an object")
                message.setdefault("runId", run_id)
                emit(message)
            except Exception:
                emit({"type": "log", "runId": run_id, "message": line[:800]})

    def read_stderr() -> None:
        assert process.stderr is not None
        for line in process.stderr:
            line = line.strip()
            if line:
                emit({"type": "stderr", "runId": run_id, "message": line[:1200]})

    stdout_thread = threading.Thread(target=read_stdout, daemon=True)
    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    exit_code = process.wait()
    stdout_thread.join(timeout=3)
    stderr_thread.join(timeout=1)

    with LOCK:
        still_active = ACTIVE is not None and ACTIVE.get("runId") == run_id
        if still_active:
            ACTIVE = None

    if still_active and exit_code not in (0, 130):
        emit({
            "type": "error",
            "runId": run_id,
            "message": f"Harness turn process exited unexpectedly (code {exit_code}).",
        })
    emit({"type": "status", "state": "idle", "activeRunId": None, "exitCode": exit_code})


def start_turn(request: dict[str, Any]) -> None:
    global ACTIVE

    run_id = str(request.get("runId", ""))
    if not run_id:
        emit({"type": "error", "message": "runId is required."})
        return

    with LOCK:
        if ACTIVE is not None:
            emit({
                "type": "error",
                "runId": run_id,
                "message": "Science Agent is already running another research turn.",
            })
            return
        ACTIVE = {"runId": run_id, "startedAt": time.time(), "process": None}

    emit({
        "type": "status",
        "state": "starting",
        "activeRunId": run_id,
        "message": "Preparing the Harness turn process.",
    })

    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

    try:
        process = subprocess.Popen(
            [sys.executable, str(BRIDGE)],
            cwd=str(ROOT.parent),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
        with LOCK:
            if ACTIVE and ACTIVE.get("runId") == run_id:
                ACTIVE["process"] = process
    except Exception as exc:
        with LOCK:
            ACTIVE = None
        emit({"type": "error", "runId": run_id, "message": f"Failed to start Harness turn: {exc}"})
        emit({"type": "status", "state": "idle", "activeRunId": None})
        return

    assert process.stdin is not None
    process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
    process.stdin.flush()
    process.stdin.close()

    emit({
        "type": "status",
        "state": "running",
        "activeRunId": run_id,
        "message": "DeepSeek Harness is executing the research task.",
    })
    threading.Thread(target=monitor_worker, args=(run_id, process), daemon=True).start()


def cancel_turn(run_id: str | None = None) -> None:
    global ACTIVE
    with LOCK:
        active = ACTIVE
        if active is None:
            emit({"type": "status", "state": "idle", "activeRunId": None})
            return
        if run_id and active.get("runId") != run_id:
            return
        ACTIVE = None
        process = active.get("process")

    emit({
        "type": "cancelled",
        "runId": run_id or active.get("runId"),
        "message": "Research turn cancelled by the user.",
    })
    if isinstance(process, subprocess.Popen):
        terminate_process_tree(process)
    emit({"type": "status", "state": "idle", "activeRunId": None})


def handle(command: dict[str, Any]) -> bool:
    command_type = command.get("type")
    if command_type == "run":
        request = command.get("request")
        if isinstance(request, dict):
            start_turn(request)
        else:
            emit({"type": "error", "message": "run.request must be an object."})
    elif command_type == "cancel":
        cancel_turn(command.get("runId"))
    elif command_type == "status":
        with LOCK:
            active = ACTIVE
        emit({
            "type": "status",
            "state": "running" if active else "idle",
            "activeRunId": active.get("runId") if active else None,
        })
    elif command_type == "ping":
        emit({"type": "pong", "time": time.time()})
    elif command_type == "shutdown":
        cancel_turn(None)
        STOPPING.set()
        return False
    else:
        emit({"type": "error", "message": f"Unknown daemon command: {command_type}"})
    return True


def main() -> int:
    emit({
        "type": "ready",
        "daemon": "science-agent",
        "mode": "claws-style-single-agent",
        "pid": os.getpid(),
    })
    emit({"type": "status", "state": "idle", "activeRunId": None})
    for line in sys.stdin:
        if STOPPING.is_set():
            break
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError("command must be an object")
        except Exception as exc:
            emit({"type": "error", "message": f"Invalid daemon command: {exc}"})
            continue
        if not handle(command):
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
