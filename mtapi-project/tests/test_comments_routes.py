import json
import pytest
from pathlib import Path
from starlette.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_comments_files_route(client):
    res = client.get("/api/comments/files")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert isinstance(data["files"], list)


def test_comments_data_not_found(client):
    res = client.get("/api/comments/data?path=/nonexistent/path.json")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert "not found" in data["error"].lower()


def test_comments_data_invalid_extension(client, tmp_path):
    f = tmp_path / "test.txt"
    f.write_text("hello")
    res = client.get(f"/api/comments/data?path={f}")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert "not a json file" in data["error"].lower()


def test_comments_data_hierarchical_grouping(client, tmp_path):
    info_json = tmp_path / "Cool Video [xyz123].info.json"
    comments_payload = {
        "title": "Cool Video",
        "id": "xyz123",
        "uploader": "Cool Channel",
        "comments": [
            {
                "id": "t1",
                "author": "@alice",
                "text": "First top comment",
                "like_count": 100,
                "parent": "root",
                "is_pinned": True,
                "author_is_uploader": True,
                "time_text": "1 hour ago",
                "timestamp": 1000,
            },
            {
                "id": "r1",
                "author": "@bob",
                "text": "Reply to alice",
                "like_count": 10,
                "parent": "t1",
                "is_pinned": False,
                "author_is_uploader": False,
                "time_text": "30 mins ago",
                "timestamp": 1050,
            },
            {
                "id": "t2",
                "author": "@charlie",
                "text": "Second top comment",
                "like_count": 5,
                "parent": "root",
                "is_pinned": False,
                "author_is_uploader": False,
                "time_text": "10 mins ago",
                "timestamp": 1100,
            },
        ],
    }
    info_json.write_text(json.dumps(comments_payload))

    res = client.get(f"/api/comments/data?path={info_json}")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["title"] == "Cool Video"
    assert data["video_id"] == "xyz123"
    assert data["channel"] == "Cool Channel"
    assert data["total_count"] == 3
    assert data["threads_count"] == 2

    threads = data["threads"]
    t1 = next(t for t in threads if t["id"] == "t1")
    assert t1["author"] == "@alice"
    assert t1["is_pinned"] is True
    assert t1["is_creator"] is True
    assert len(t1["replies"]) == 1
    assert t1["replies"][0]["id"] == "r1"
    assert t1["replies"][0]["author"] == "@bob"

    t2 = next(t for t in threads if t["id"] == "t2")
    assert t2["author"] == "@charlie"
    assert len(t2["replies"]) == 0


def test_comments_ryd_route(client):
    from app.routes import ytdlp
    ytdlp._RYD_CACHE["mock_vid"] = (
        9999999999.0,
        {
            "ok": True,
            "video_id": "mock_vid",
            "likes": 5000,
            "dislikes": 200,
            "rating": 4.8,
            "like_ratio": 96.2,
            "view_count": 100000,
        },
    )
    res = client.get("/api/comments/ryd?video_id=mock_vid")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["likes"] == 5000
    assert data["dislikes"] == 200
    assert data["like_ratio"] == 96.2

    res_yt = client.get("/api/ytdlp/ryd?video_id=mock_vid")
    assert res_yt.status_code == 200
    data_yt = res_yt.json()
    assert data_yt["ok"] is True
    assert data_yt["likes"] == 5000

