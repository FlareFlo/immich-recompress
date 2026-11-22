"""Tests for /tmp storage reporting, low-space auto-pause, and queue pause/resume."""

import os
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

from backend import jobs, media, routes, state
from backend.state import _jobs, _pause_state, _state_lock


ASSET_1 = "50000000-0000-4000-8000-000000000001"
GIB = 1024 ** 3


def fake_usage(total, free):
    return SimpleNamespace(total=total, used=total - free, free=free)


class TempStorageInfoTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.work = self.root / "work"
        self.backup = self.root / "backup"
        self.work.mkdir()
        self.backup.mkdir()

    def test_measures_app_files_and_healthy_disk(self):
        (self.work / "a_src.mp4").write_bytes(b"x" * 1000)
        (self.backup / "a_bak.mp4").write_bytes(b"y" * 2500)
        with patch("backend.media.shutil.disk_usage", return_value=fake_usage(20 * GIB, 12 * GIB)):
            info = media.temp_storage_info(str(self.work), str(self.backup))
        self.assertEqual(info["work_bytes"], 1000)
        self.assertEqual(info["backup_bytes"], 2500)
        self.assertEqual(info["app_bytes"], 3500)
        self.assertEqual(info["used_pct"], 40.0)
        self.assertFalse(info["low_space"])

    def test_triggers_low_space_at_90_percent_even_when_over_1gib_free(self):
        with patch("backend.media.shutil.disk_usage", return_value=fake_usage(100 * GIB, 10 * GIB)):
            info = media.temp_storage_info(str(self.work), str(self.backup))
        self.assertEqual(info["used_pct"], 90.0)
        self.assertTrue(info["low_space"])

    def test_triggers_low_space_at_1gib_free_even_below_90_percent(self):
        with patch("backend.media.shutil.disk_usage", return_value=fake_usage(4 * GIB, 900 * 1024 ** 2)):
            info = media.temp_storage_info(str(self.work), str(self.backup))
        self.assertLess(info["used_pct"], 90.0)
        self.assertTrue(info["low_space"])

    def test_small_filesystem_uses_percentage_threshold_without_false_positive(self):
        half_gib = GIB // 2
        with patch("backend.media.shutil.disk_usage", return_value=fake_usage(half_gib, int(half_gib * 0.7))):
            info = media.temp_storage_info(str(self.work), str(self.backup))
        self.assertFalse(info["low_space"])

        with patch("backend.media.shutil.disk_usage", return_value=fake_usage(half_gib, int(half_gib * 0.05))):
            info = media.temp_storage_info(str(self.work), str(self.backup))
        self.assertTrue(info["low_space"])

    def test_separate_backup_mount_triggers_low_space_when_constrained(self):
        def usage_for(path):
            if os.path.abspath(path) == str(self.backup):
                return fake_usage(20 * GIB, GIB // 2)
            return fake_usage(20 * GIB, 15 * GIB)

        real_stat = os.stat

        def stat_for(path, *args, **kwargs):
            st = real_stat(path, *args, **kwargs)
            dev = 2 if os.path.abspath(path) == str(self.backup) else 1
            return SimpleNamespace(st_mode=st.st_mode, st_dev=dev)

        with patch("backend.media.shutil.disk_usage", side_effect=usage_for), \
             patch("backend.media.os.stat", side_effect=stat_for):
            info = media.temp_storage_info(str(self.work), str(self.backup))
        self.assertTrue(info["low_space"])
        self.assertEqual(info["path"], str(self.backup))


class QueuePauseTest(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(routes.bp)
        self.client = app.test_client()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        _jobs.clear()
        self.addCleanup(_jobs.clear)
        with _state_lock:
            _pause_state.update({"manual": False, "auto": False, "reason": None, "gen": 0})
        self.addCleanup(self._reset_pause)
        self.stack.enter_context(patch.object(jobs, "broadcast_queue_update"))
        self.stack.enter_context(patch.object(routes, "broadcast_queue_update"))

    def _reset_pause(self):
        with _state_lock:
            _pause_state.update({"manual": False, "auto": False, "reason": None, "gen": 0})

    def test_status_and_jobs_expose_temp_storage_and_pause_state(self):
        sample = {
            "path": "/tmp/immich_recompress_ui", "total": 10 * GIB, "used": 2 * GIB,
            "free": 8 * GIB, "used_pct": 20.0, "app_bytes": 1024, "work_bytes": 1024,
            "backup_bytes": 0, "max_used_pct": 90.0, "min_free_bytes": GIB, "low_space": False,
        }
        with patch.object(routes, "temp_storage_info", return_value=sample), \
             patch.object(routes, "get_env", return_value={"url": "", "api_keys": []}), \
             patch.object(routes, "detect_immich_version", return_value=""):
            status_resp = self.client.get("/api/status")
            jobs_resp = self.client.get("/api/jobs")
        self.assertEqual(status_resp.status_code, 200)
        self.assertEqual(status_resp.json["temp_storage"]["used_pct"], 20.0)
        self.assertEqual(jobs_resp.status_code, 200)
        self.assertEqual(jobs_resp.json["temp_storage"]["free"], 8 * GIB)
        self.assertFalse(jobs_resp.json["pause"]["paused"])

    def test_pause_and_resume_routes_keep_auto_pause_when_disk_still_full(self):
        full = {
            "path": "/tmp/immich_recompress_ui", "total": 10 * GIB, "used": 95 * GIB // 10,
            "free": GIB // 2, "used_pct": 95.0, "app_bytes": 2 * GIB, "work_bytes": 0,
            "backup_bytes": 2 * GIB, "max_used_pct": 90.0, "min_free_bytes": GIB, "low_space": True,
        }
        with patch.object(routes, "temp_storage_info", return_value=full):
            p = self.client.post("/api/queue/pause")
            self.assertTrue(p.json["pause"]["paused"])
            self.assertTrue(p.json["pause"]["manual"])

            r = self.client.post("/api/queue/resume")
            self.assertTrue(r.json["pause"]["paused"])
            self.assertFalse(r.json["pause"]["manual"])
            self.assertTrue(r.json["pause"]["auto"])
            self.assertIn("95% full", r.json["pause"]["reason"])

        healthy = {**full, "used": 2 * GIB, "free": 8 * GIB, "used_pct": 20.0, "low_space": False}
        with patch.object(routes, "temp_storage_info", return_value=healthy):
            r2 = self.client.post("/api/queue/resume")
            self.assertFalse(r2.json["pause"]["paused"])
            self.assertIsNone(r2.json["pause"]["reason"])

    def test_wait_if_paused_blocks_until_space_is_freed(self):
        _jobs[ASSET_1] = jobs.new_job(ASSET_1, {"name": "clip.mp4", "size": 500_000_000})
        current = {
            "path": "/tmp/immich_recompress_ui", "total": 10 * GIB, "used": 92 * GIB // 10,
            "free": int(0.8 * GIB), "used_pct": 92.0, "app_bytes": 2 * GIB, "work_bytes": 0,
            "backup_bytes": 2 * GIB, "max_used_pct": 90.0, "min_free_bytes": GIB, "low_space": True,
        }
        result = []

        def waiter():
            result.append(jobs._wait_if_paused(ASSET_1, poll_interval=0.05))

        with patch.object(jobs, "temp_storage_info", side_effect=lambda **_kw: dict(current)):
            t = threading.Thread(target=waiter)
            t.start()
            deadline = time.time() + 1.0
            while not state.pause_status()["auto"] and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue(state.pause_status()["paused"])
            self.assertEqual(result, [])

            # Simulate user replacing/discarding a review item and freeing space
            current.update({"used": 4 * GIB, "free": 6 * GIB, "used_pct": 40.0, "low_space": False})
            state.wake_worker()
            t.join(timeout=1.0)

        self.assertEqual(result, [True])
        self.assertFalse(state.pause_status()["paused"])

    def test_wait_if_paused_returns_false_when_cancelled_while_paused(self):
        _jobs[ASSET_1] = jobs.new_job(ASSET_1, {"name": "clip.mp4", "size": 500_000_000})
        full = {
            "path": "/tmp/immich_recompress_ui", "total": 10 * GIB, "used": 95 * GIB // 10,
            "free": GIB // 2, "used_pct": 95.0, "app_bytes": 2 * GIB, "work_bytes": 0,
            "backup_bytes": 2 * GIB, "max_used_pct": 90.0, "min_free_bytes": GIB, "low_space": True,
        }
        result = []

        def waiter():
            result.append(jobs._wait_if_paused(ASSET_1, poll_interval=0.05))

        with patch.object(jobs, "temp_storage_info", return_value=full):
            t = threading.Thread(target=waiter)
            t.start()
            deadline = time.time() + 1.0
            while not state.pause_status()["auto"] and time.time() < deadline:
                time.sleep(0.01)

            with _state_lock:
                _jobs[ASSET_1]["_cancel"] = True
                _jobs[ASSET_1]["status"] = "cancelled"
            state.wake_worker()
            t.join(timeout=1.0)

        self.assertEqual(result, [False])
        self.assertFalse(state.pause_status()["auto"])


if __name__ == "__main__":
    unittest.main()
