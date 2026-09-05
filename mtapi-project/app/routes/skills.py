"""Skill library read routes: list / detail / delete. Writes go through
POST /ops/skills_install (job machinery, progress, single-flight)."""
from fastapi import FastAPI

from .. import skills_store as store


def register(app: FastAPI) -> None:
    @app.get("/api/skills", tags=["skills"])
    async def skills_list():
        return {"ok": True, "skills": store.list_skills()}

    @app.get("/api/skills/{skill_id}", tags=["skills"])
    async def skills_detail(skill_id: str):
        entry = store.find_by_id(skill_id)
        if not entry:
            return {"ok": False, "error": "Skill not found"}
        try:
            files = store.read_skill_files(skill_id)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "skill": entry, "files": files}

    @app.delete("/api/skills/{skill_id}", tags=["skills"])
    async def skills_delete(skill_id: str):
        if not store.delete_skill(skill_id):
            return {"ok": False, "error": "Skill not found"}
        return {"ok": True, "deleted": skill_id}
