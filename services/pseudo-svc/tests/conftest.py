import os

import pytest

os.environ.setdefault("PSEUDO_NER", "0")
KEY = "test-key-0123456789abcdef0123456789"  # >= 32 characters


@pytest.fixture
def vault(tmp_path):
    from app.vault import Vault

    return Vault(str(tmp_path / "vault.db"), KEY)
