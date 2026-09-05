"""Skills tab backend: frontmatter, store CRUD, zip safety, install op."""
import asyncio
import base64
import io
import zipfile

import pytest

from app import skills_store as store
from app.agents.skills import build_skill_install_messages
from app.contract import REGISTRY
from app.operations.skills_ops import SkillInstallParams, skills_install


@pytest.fixture()
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv("MTAPI_SKILLS_ROOT", str(tmp_path / "skills-home"))
    yield tmp_path


def _run(params: SkillInstallParams):
    return asyncio.run(skills_install(params))


# ── frontmatter / names ──────────────────────────────────────────────────────

def test_parse_frontmatter_valid():
    text = "---\nname: my-skill\ndescription: Does things.\n---\n\n# Body\n"
    name, desc, body = store.parse_frontmatter(text)
    assert name == "my-skill"
    assert desc == "Does things."
    assert body.startswith("\n# Body")


def test_parse_frontmatter_missing():
    name, desc, body = store.parse_frontmatter("# Just a body\n")
    assert name is None and desc is None
    assert body.startswith("# Just")


def test_parse_frontmatter_quoted_and_case():
    text = "---\nName: 'Cool Skill'\nDescription: \"x\"\n---\nbody\n"
    name, desc, _ = store.parse_frontmatter(text)
    assert name == "Cool Skill" and desc == "x"


def test_slugify():
    assert store.slugify_name("My Cool Skill!") == "my-cool-skill"
    assert store.slugify_name("  a__b  ") == "a-b"
    assert store.slugify_name("!!!") == ""


def test_install_prompt_modes():
    s, u = build_skill_install_messages("normalize", text="hello")
    assert "frontmatter" in s.lower() and u == "hello"
    s2, u2 = build_skill_install_messages("custom", text="hello", custom_prompt="shorten")
    assert "shorten" in u2
    with pytest.raises(ValueError):
        build_skill_install_messages("custom", text="hello")
    with pytest.raises(ValueError):
        build_skill_install_messages("normalize", text="   ")


# ── store CRUD ───────────────────────────────────────────────────────────────

def test_store_roundtrip(isolated_store):
    entry = store.new_entry("demo", "demo desc", "pasted", {"SKILL.md": "SKILL.md"})
    assert store.list_skills() == []
    store.write_skill_files(entry["id"], {"SKILL.md": "# Demo\n"})
    saved = store.upsert_skill(entry)
    assert len(store.list_skills()) == 1
    assert store.find_by_name("DEMO")["id"] == saved["id"]  # case-insensitive
    files = store.read_skill_files(saved["id"])
    assert files["SKILL.md"] == "# Demo\n"
    assert store.delete_skill(saved["id"]) is True
    assert store.delete_skill(saved["id"]) is False
    assert store.list_skills() == []


def test_store_corrupt_index_recovers(isolated_store):
    root = isolated_store / "skills-home"
    root.mkdir(parents=True, exist_ok=True)
    (root / "skills.json").write_text("{not json", encoding="utf-8")
    assert store.list_skills() == []  # no raise, no wipe crash


# ── zip safety ───────────────────────────────────────────────────────────────

def _zip_bytes(members: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in members.items():
            zf.writestr(name, text)
    return buf.getvalue()


def test_zip_root_entry():
    entry, extras = store.extract_skill_zip(_zip_bytes({
        "SKILL.md": "# S\n", "scripts/run.py": "print(1)\n",
    }))
    assert entry == "# S\n"
    assert extras == {"scripts/run.py": "print(1)\n"}


def test_zip_nested_one_level_rerooted():
    entry, extras = store.extract_skill_zip(_zip_bytes({
        "bundle/SKILL.md": "# N\n", "bundle/refs/a.md": "a\n",
    }))
    assert entry == "# N\n"
    assert extras == {"refs/a.md": "a\n"}


def test_zip_no_entry_rejected():
    with pytest.raises(ValueError, match="No SKILL.md"):
        store.extract_skill_zip(_zip_bytes({"readme.md": "hi\n"}))


def test_zip_traversal_rejected():
    with pytest.raises(ValueError, match="[Uu]nsafe"):
        store.extract_skill_zip(_zip_bytes({
            "SKILL.md": "# S\n", "../evil.sh": "x\n",
        }))


def test_zip_absolute_rejected():
    with pytest.raises(ValueError, match="[Uu]nsafe"):
        store.extract_skill_zip(_zip_bytes({
            "SKILL.md": "# S\n", "/tmp/evil.sh": "x\n",
        }))


# ── install op ───────────────────────────────────────────────────────────────

FRONTMATTERED = "---\nname: stub-skill\ndescription: Stub test skill.\n---\n\n# Body\n"


def test_registered():
    assert "skills_install" in REGISTRY
    assert REGISTRY["skills_install"].params_model is SkillInstallParams


def test_dry_run(isolated_store):
    res = _run(SkillInstallParams(content_text="# hi", dry_run=True))
    assert res.ok and res.dry_run


def test_empty_rejected(isolated_store):
    res = _run(SkillInstallParams(content_text="   "))
    assert not res.ok


def test_both_text_and_zip_rejected(isolated_store):
    res = _run(SkillInstallParams(
        content_text="x",
        content_b64=base64.b64encode(_zip_bytes({"SKILL.md": "x"})).decode(),
    ))
    assert not res.ok


def test_stub_backend_falls_back_to_structured_input(isolated_store):
    """Offline stub returns non-frontmatter text → input used as-is + warning."""
    res = _run(SkillInstallParams(backend="stub", content_text=FRONTMATTERED))
    assert res.ok, res.error
    assert res.items[0]["name"] == "stub-skill"
    assert "warning" in (res.meta or {})
    assert store.find_by_name("stub-skill") is not None


def test_stub_backend_garbage_fails_with_output(isolated_store):
    res = _run(SkillInstallParams(backend="stub", content_text="just some words"))
    assert not res.ok
    assert (res.meta or {}).get("model_output")


def test_conflict_protocol(isolated_store):
    first = _run(SkillInstallParams(backend="stub", content_text=FRONTMATTERED))
    assert first.ok
    second = _run(SkillInstallParams(backend="stub", content_text=FRONTMATTERED))
    assert not second.ok
    assert (second.meta or {}).get("conflict") is True
    third = _run(SkillInstallParams(
        backend="stub", content_text=FRONTMATTERED, overwrite=True,
    ))
    assert third.ok, third.error
    assert third.items[0]["id"] == first.items[0]["id"]
    assert third.items[0]["overwrote"] is True
    assert len(store.list_skills()) == 1


def test_zip_install_path(isolated_store):
    zb = _zip_bytes({"SKILL.md": FRONTMATTERED, "refs/note.md": "n\n"})
    res = _run(SkillInstallParams(
        backend="stub", content_b64=base64.b64encode(zb).decode(),
        source="upload-zip",
    ))
    assert res.ok, res.error
    assert sorted(res.items[0]["files"]) == ["SKILL.md", "refs/note.md"]
    files = store.read_skill_files(res.items[0]["id"])
    assert files["refs/note.md"] == "n\n"


def test_bad_zip_rejected(isolated_store):
    res = _run(SkillInstallParams(
        backend="stub",
        content_b64=base64.b64encode(b"not a zip").decode(),
        source="upload-zip",
    ))
    assert not res.ok
