"""Build-time: generate the Omorfi case forms of the top N DVV first names and surnames.

Writes data/forms/{first,last}.json.gz (name -> {case key: form}). Names Omorfi does not know are
skipped, so the tables double as the surrogate pool. Needs OMORFI_MODELS; run from the service root:
    python scripts/precompute_forms.py [N]
"""

import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import forms  # noqa: E402
from app.detect.gazetteer import names  # noqa: E402


def main(n: int = 3000) -> None:
    om = forms.omorfi()
    if om is None:
        sys.exit("OMORFI_MODELS not set or models missing")
    db = names()
    ranked = {"first": sorted(db["first"], key=lambda x: -db["first"][x][0]),
              "last": sorted(db["last"], key=lambda x: -db["last"][x])}
    forms.FORMS_DIR.mkdir(parents=True, exist_ok=True)
    for kind, lst in ranked.items():
        out = {name: forms.generate_forms(name, kind) for name in lst[:n] if name.isalpha() and om.prefix(name, kind)}
        with gzip.open(forms.FORMS_DIR / f"{kind}.json.gz", "wt", encoding="utf-8", compresslevel=9) as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        print(kind, len(out))


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 3000)
