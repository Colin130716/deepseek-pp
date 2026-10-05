"""Unit tests for the local workspace server (stdlib unittest, no extra deps)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app import create_app
import permissions as perm
import sandbox


class PermissionMatrixTest(unittest.TestCase):
    def test_parse_fails_closed(self) -> None:
        self.assertIs(perm.parse_permission(None), perm.PermissionLevel.READ_ONLY)
        self.assertIs(perm.parse_permission("bogus"), perm.PermissionLevel.READ_ONLY)
        self.assertIs(perm.parse_permission("full_access"), perm.PermissionLevel.FULL_ACCESS)

    def test_matrix(self) -> None:
        ro = perm.PermissionLevel.READ_ONLY
        ww = perm.PermissionLevel.WORKSPACE_WRITE
        fa = perm.PermissionLevel.FULL_ACCESS
        self.assertTrue(perm.allows("workspace_read", ro))
        self.assertFalse(perm.allows("workspace_write", ro))
        self.assertFalse(perm.allows("workspace_bash", ro))
        self.assertTrue(perm.allows("workspace_edit", ww))
        self.assertFalse(perm.allows("workspace_bash", ww))
        self.assertTrue(perm.allows("workspace_bash", fa))
        self.assertFalse(perm.allows("unknown_tool", fa))


class SandboxPathTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_rejects_absolute_and_escape(self) -> None:
        with self.assertRaises(sandbox.SandboxError):
            sandbox.resolve_in_workspace(self.root, "/etc/passwd")
        with self.assertRaises(sandbox.SandboxError):
            sandbox.resolve_in_workspace(self.root, "../../outside")

    def test_rejects_symlink_escape(self) -> None:
        outside = Path(self.tmp.name).parent / "outside-target.txt"
        link = self.root / "link.txt"
        link.symlink_to(outside)
        with self.assertRaises(sandbox.SandboxError):
            sandbox.read_file(self.root, "link.txt")

    def test_read_write_edit_roundtrip(self) -> None:
        (self.root / "a.txt").write_text("hello world", encoding="utf-8")
        data = sandbox.read_file(self.root, "a.txt")
        self.assertEqual(data["content"], "hello world")
        sandbox.write_file(self.root, "b.txt", "line1\nline2\n")
        result = sandbox.edit_file(self.root, "b.txt", "line1", "LINE_ONE")
        self.assertEqual(result["replacements"], 1)
        self.assertEqual((self.root / "b.txt").read_text(), "LINE_ONE\nline2\n")
        listing = sandbox.list_dir(self.root)
        names = {e["name"] for e in listing["entries"]}
        self.assertIn("a.txt", names)
        self.assertIn("b.txt", names)

    def test_edit_ambiguous_requires_replace_all(self) -> None:
        (self.root / "c.txt").write_text("x x x", encoding="utf-8")
        with self.assertRaises(sandbox.SandboxError) as ctx:
            sandbox.edit_file(self.root, "c.txt", "x", "y")
        self.assertEqual(ctx.exception.code, "ambiguous_match")
        sandbox.edit_file(self.root, "c.txt", "x", "y", replace_all=True)
        self.assertEqual((self.root / "c.txt").read_text(), "y y y")


class HttpApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.client = TestClient(create_app())

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _post(self, tool: str, permission: str, arguments: dict):
        return self.client.post(
            f"/tools/{tool}",
            json={"workspace_root": self.root, "permission": permission, "arguments": arguments},
        ).json()

    def test_health(self) -> None:
        body = self.client.get("/health").json()
        self.assertTrue(body["ok"])

    def test_read_only_denies_write(self) -> None:
        body = self._post("workspace_write", "read_only", {"path": "x.txt", "content": "hi"})
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["code"], "permission_denied")

    def test_workspace_write_denies_bash(self) -> None:
        body = self._post("workspace_bash", "workspace_write", {"command": "echo hi"})
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["code"], "permission_denied")

    def test_path_escape_denied(self) -> None:
        body = self._post("workspace_read", "read_only", {"path": "../escape.txt"})
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["code"], "path_escape")

    def test_full_access_bash(self) -> None:
        body = self._post("workspace_bash", "full_access", {"command": "echo hello-from-bash"})
        self.assertTrue(body["ok"], msg=str(body))
        self.assertIn("hello-from-bash", body["data"]["stdout"])

    def test_unknown_tool(self) -> None:
        body = self._post("nope", "full_access", {})
        self.assertEqual(body["error"]["code"], "unknown_tool")

    def test_extra_argument_keys_rejected(self) -> None:
        body = self._post("workspace_read", "read_only", {"path": "a", "evil": 1})
        self.assertEqual(body["error"]["code"], "invalid_arguments")


if __name__ == "__main__":
    unittest.main()
