#!/usr/bin/env python3
"""Validate companion routing and keep runtime data out of source publication."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "oura"


def load(path):
    return json.loads(path.read_text())


def main():
    portable = load(PLUGIN / "plugin.json")
    for harness in ("claude", "codex", "cursor", "grok"):
        native = load(PLUGIN / f".{harness}-plugin" / "plugin.json")
        for field in ("name", "version", "description"):
            assert native[field] == portable[field], (harness, field)
        assert (PLUGIN / native["skills"]).is_dir()
    for path in (".claude-plugin", ".agents/plugins", ".cursor-plugin", ".grok-plugin"):
        catalog = load(ROOT / path / "marketplace.json")
        assert catalog["name"] == "oura"
        assert len(catalog["plugins"]) == 1
        entry = catalog["plugins"][0]
        assert entry["name"] == portable["name"]
        source = entry["source"]
        source = source["path"] if isinstance(source, dict) else source
        assert (ROOT / source).resolve() == PLUGIN.resolve()
    assert not list(PLUGIN.rglob(".mcp.json")), "Companion must not imply an MCP connection"
    assert not list(PLUGIN.rglob("mcp.json")), "Companion must not imply an MCP connection"
    assert "disable-model-invocation: true" in (PLUGIN / "skills/oura/SKILL.md").read_text()
    assert "allow_implicit_invocation: false" in (PLUGIN / "skills/oura/agents/openai.yaml").read_text()
    assert (ROOT / ".dockerignore").read_text().splitlines() == [
        "**", "!Dockerfile", "!package.json", "!package-lock.json", "!tsconfig.json", "!src/", "!src/**"
    ], "Review any expansion of the image build context"
    for path in ROOT.rglob("*"):
        if any(part in {".git", "node_modules", "dist"} for part in path.relative_to(ROOT).parts):
            continue
        assert path.name not in {".env", "oura-credential.json"}, f"Runtime credential file: {path}"
        assert not path.name.endswith(".tar"), f"Unreviewed image archive: {path}"
    print("Companion catalogs, native metadata, manual invocation and image context are valid.")


if __name__ == "__main__":
    main()
