import os

import pytest

os.environ.setdefault("PSEUDO_NER", "0")


@pytest.fixture
def vault(tmp_path):
    from app.vault import Vault

    return Vault(str(tmp_path / "vault.db"), "test-key")
