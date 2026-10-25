from conftest import KEY
import pytest

from app.vault import Vault


def test_wrong_key_fails(tmp_path):
    path = str(tmp_path / "v.db")
    Vault(path, "right-key-0123456789abcdef0123456789").x("INSERT INTO never_detect VALUES ('u','PERSON','x')")
    with pytest.raises(Exception):
        Vault(path, "wrong-key-0123456789abcdef0123456789")
    assert Vault(path, "right-key-0123456789abcdef0123456789").never_detect("u") == {("PERSON", "x")}


def test_file_is_encrypted(tmp_path):
    path = tmp_path / "v.db"
    Vault(str(path), KEY).x("INSERT INTO never_detect VALUES ('u','PERSON','Virtanen')")
    assert b"Virtanen" not in path.read_bytes() and not path.read_bytes().startswith(b"SQLite format 3")


def test_key_required(tmp_path):
    with pytest.raises(ValueError):
        Vault(str(tmp_path / "v.db"), "")
