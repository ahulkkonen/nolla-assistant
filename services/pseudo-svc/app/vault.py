"""Encrypted vault (SQLCipher). Holds real values; never log them."""

import datetime
import os
import threading

import sqlcipher3

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS counter (user_id TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL,
  PRIMARY KEY(user_id, name));
CREATE TABLE IF NOT EXISTS entity (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
  canonical TEXT NOT NULL, surrogate TEXT NOT NULL,
  surrogate_mode TEXT CHECK(surrogate_mode IN ('realistic','placeholder')) DEFAULT 'realistic',
  infl_class TEXT, pinned INTEGER DEFAULT 0, allowlisted INTEGER DEFAULT 0, confirmed INTEGER DEFAULT 0,
  gen INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS entity_user ON entity(user_id, kind, canonical);
-- real forms may repeat across entities (two people called Matti); a surrogate form maps to one
-- entity per user. user_id is denormalised here so the unique index needs no join.
CREATE TABLE IF NOT EXISTS entity_form (entity_id INTEGER REFERENCES entity(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, side TEXT CHECK(side IN ('real','surrogate')), form TEXT NOT NULL, analysis TEXT,
  part TEXT, PRIMARY KEY(entity_id, side, form));
CREATE UNIQUE INDEX IF NOT EXISTS surrogate_form_unique ON entity_form(user_id, form) WHERE side = 'surrogate';
CREATE TABLE IF NOT EXISTS span (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT,
  entry_id TEXT, start INTEGER, end INTEGER, entity_id INTEGER REFERENCES entity(id),
  surrogate_form TEXT, detector TEXT, score REAL, created_at TEXT);
CREATE INDEX IF NOT EXISTS span_session ON span(session_id, entity_id);
CREATE TABLE IF NOT EXISTS merge_log (from_id INTEGER, into_id INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT,
  kind TEXT, text TEXT, start INTEGER, end INTEGER, detector TEXT, score REAL,
  status TEXT DEFAULT 'open', created_at TEXT, entity_id INTEGER);
CREATE INDEX IF NOT EXISTS pending_dedupe ON pending(user_id, entity_id, kind, text);
CREATE TABLE IF NOT EXISTS never_detect (user_id TEXT NOT NULL, kind TEXT NOT NULL, canonical TEXT NOT NULL,
  PRIMARY KEY(user_id, kind, canonical));
"""
MIN_KEY = 32


class SurrogateConflict(Exception):
    """A surrogate form is already owned by another entity of the user."""


def now() -> str:
    return datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Vault:
    def __init__(self, path: str, key: str, secret: bytes | None = None):
        if len(key) < MIN_KEY:
            raise ValueError(f"PSEUDO_VAULT_KEY must have at least {MIN_KEY} characters")
        self.db = sqlcipher3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlcipher3.Row
        self.db.execute("PRAGMA key = '%s'" % key.replace("'", "''"))
        self.db.execute("SELECT count(*) FROM sqlite_master").fetchone()  # raises on a wrong key
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)
        self.lock = threading.RLock()
        self.version: dict[str, int] = {}  # user_id -> bump on every form change (matcher caches)
        # surrogate seed key: random per vault, created once, kept inside the encrypted file.
        # `secret` is only for tests that need the same surrogates from two vaults.
        self.db.execute("INSERT OR IGNORE INTO meta VALUES ('surrogate_secret', ?)", (secret or os.urandom(32),))
        self.secret: bytes = self.q("SELECT value FROM meta WHERE key='surrogate_secret'")[0][0]

    # -- helpers
    def q(self, sql: str, args=()) -> list:
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def x(self, sql: str, args=()) -> int:
        with self.lock:
            return self.db.execute(sql, args).lastrowid

    def bump(self, user_id: str) -> None:
        self.version[user_id] = self.version.get(user_id, 0) + 1

    def entity(self, user_id: str, entity_id: int):
        r = self.q("SELECT * FROM entity WHERE id=? AND user_id=?", (entity_id, user_id))
        return r[0] if r else None

    def find(self, user_id: str, kinds: tuple, canonical: str):
        marks = ",".join("?" * len(kinds))
        r = self.q(f"SELECT * FROM entity WHERE user_id=? AND kind IN ({marks}) AND canonical=? ORDER BY id",
                   (user_id, *kinds, canonical))
        return r[0] if r else None

    def create(self, user_id, kind, canonical, surrogate, infl_class, real, surr, mode="realistic", gen=0):
        """real/surr: iterables of (form, analysis, part). Returns the new entity row."""
        with self.lock:
            self.db.execute("BEGIN")
            try:
                t = now()
                eid = self.db.execute(
                    "INSERT INTO entity(user_id,kind,canonical,surrogate,surrogate_mode,infl_class,gen,created_at,updated_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?)", (user_id, kind, canonical, surrogate, mode, infl_class, gen, t, t)).lastrowid
                self._forms(eid, "real", real)
                self._forms(eid, "surrogate", surr)
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
            self.bump(user_id)
            return self.entity(user_id, eid)

    def _forms(self, eid, side, rows) -> None:
        """Insert form rows. A real form already on the entity is skipped; a surrogate form owned by
        another entity of the user raises SurrogateConflict instead of being dropped silently."""
        uid = self.db.execute("SELECT user_id FROM entity WHERE id=?", (eid,)).fetchone()[0]
        try:
            self.db.executemany("INSERT INTO entity_form(entity_id,user_id,side,form,analysis,part) VALUES (?,?,?,?,?,?)"
                                " ON CONFLICT(entity_id, side, form) DO NOTHING",
                                [(eid, uid, side, f, a, p) for f, a, p in rows])
        except sqlcipher3.IntegrityError as e:
            raise SurrogateConflict("surrogate form taken") from e

    def add_forms(self, user_id: str, eid: int, side: str, rows) -> None:
        with self.lock:
            self.db.execute("SAVEPOINT forms")
            try:
                self._forms(eid, side, rows)
            except Exception:
                self.db.execute("ROLLBACK TO forms")
                raise
            finally:
                self.db.execute("RELEASE forms")
        self.bump(user_id)

    def next_counter(self, user_id: str, name: str) -> int:
        """Per-user monotonic counter (placeholder numbers); never reused, also after merges."""
        with self.lock:
            return self.db.execute("INSERT INTO counter VALUES (?,?,1) ON CONFLICT(user_id, name)"
                                   " DO UPDATE SET value=value+1 RETURNING value", (user_id, name)).fetchone()[0]

    def surrogate_taken(self, user_id: str, forms: list[str]) -> bool:
        marks = ",".join("?" * len(forms))
        return bool(self.q(f"SELECT 1 FROM entity_form WHERE user_id=? AND side='surrogate' AND form IN ({marks})"
                           " LIMIT 1", (user_id, *forms)))

    def real_taken(self, user_id: str, form: str) -> bool:
        return bool(self.q("SELECT 1 FROM entity_form WHERE user_id=? AND side='real' AND form=? LIMIT 1",
                           (user_id, form)))

    def forms_for(self, entity_id: int) -> list:
        return self.q("SELECT * FROM entity_form WHERE entity_id=?", (entity_id,))

    def all_forms(self, user_id: str, side: str) -> list:
        """(form, entity_id, part, analysis, kind) for every entity of the user. never_detect hides only
        real forms, so surrogates already in old transcripts still restore."""
        hide = (" AND NOT EXISTS (SELECT 1 FROM never_detect n WHERE n.user_id=e.user_id AND n.kind=e.kind"
                " AND n.canonical=e.canonical)") if side == "real" else ""
        return self.q("SELECT f.form, f.entity_id, f.part, f.analysis, e.kind FROM entity_form f JOIN entity e"
                      " ON e.id=f.entity_id WHERE f.user_id=? AND f.side=?" + hide, (user_id, side))

    def real_form(self, entity_id: int, part: str, analysis: str) -> str | None:
        r = self.q("SELECT form FROM entity_form WHERE entity_id=? AND side='real' AND part=? AND analysis IN (?, 'NOM')"
                   " ORDER BY analysis<>?, rowid LIMIT 1", (entity_id, part, analysis, analysis))
        return r[0][0] if r else None

    @staticmethod
    def _scope(session_id: str) -> tuple[str, str]:
        """A subagent session `<chat>/sub/<id>` gets its task from the chat, so it shares the chat's spans."""
        return session_id, session_id.split("/sub/")[0]

    def last_seen(self, session_id: str, entity_ids: list[int]) -> dict[int, int]:
        marks = ",".join("?" * len(entity_ids))
        return {r[0]: r[1] for r in self.q(
            f"SELECT entity_id, max(id) FROM span WHERE session_id IN (?,?) AND entity_id IN ({marks}) GROUP BY entity_id",
            (*self._scope(session_id), *entity_ids))}

    def session_surrogate_names(self, user_id: str, session_id: str) -> set[str]:
        """Base forms (nominative) of the surrogate names of the people this session has seen."""
        return {r[0] for r in self.q(
            "SELECT f.form FROM entity_form f JOIN entity e ON e.id=f.entity_id WHERE f.user_id=? AND f.side='surrogate'"
            " AND f.analysis='NOM' AND e.kind='PERSON' AND f.entity_id IN (SELECT entity_id FROM span WHERE session_id IN (?,?))",
            (user_id, *self._scope(session_id)))}

    # -- spans
    def record_spans(self, user_id: str, session_id: str, entry_id: str | None, spans: list[dict]) -> list[int]:
        t = now()
        with self.lock:
            return [self.db.execute(
                "INSERT INTO span(user_id,session_id,entry_id,start,end,entity_id,surrogate_form,detector,score,created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)", (user_id, session_id, entry_id, s["start"], s["end"], s["entity_id"],
                                                  s["surrogate"], s["detector"], s["score"], t)).lastrowid for s in spans]

    # -- never detect
    def never_detect(self, user_id: str) -> set[tuple[str, str]]:
        return {(r[0], r[1]) for r in self.q("SELECT kind, canonical FROM never_detect WHERE user_id=?", (user_id,))}

    def add_never_detect(self, user_id: str, kind: str, canonical: str) -> None:
        self.x("INSERT OR IGNORE INTO never_detect VALUES (?,?,?)", (user_id, kind, canonical))
        self.bump(user_id)

    # -- management
    def list_entities(self, user_id: str) -> list:
        return self.q(
            "SELECT e.*, count(s.id) AS seen_count, max(s.created_at) AS last_seen FROM entity e"
            " LEFT JOIN span s ON s.entity_id=e.id WHERE e.user_id=? AND NOT EXISTS (SELECT 1 FROM never_detect n"
            " WHERE n.user_id=e.user_id AND n.kind=e.kind AND n.canonical=e.canonical) GROUP BY e.id ORDER BY e.id", (user_id,))

    def merge(self, user_id: str, from_ids: list[int], into_id: int) -> None:
        """KeyError: an entity is missing. ValueError: SELF involved or kinds differ."""
        with self.lock:
            into = self.entity(user_id, into_id)
            froms = [self.entity(user_id, i) for i in from_ids if i != into_id]
            if not into or not all(froms):
                raise KeyError("entity")
            if any(e["kind"] == "SELF" or e["kind"] != into["kind"] for e in [into, *froms]):
                raise ValueError("merge needs entities of one kind, not the self entity")
            self.db.execute("BEGIN")
            try:
                for e in froms:
                    fid = e["id"]
                    self.db.execute("UPDATE span SET entity_id=? WHERE entity_id=?", (into_id, fid))
                    self.db.execute("UPDATE OR IGNORE entity_form SET entity_id=? WHERE entity_id=?", (into_id, fid))
                    self.db.execute("UPDATE pending SET entity_id=? WHERE entity_id=?", (into_id, fid))
                    self.db.execute("DELETE FROM entity WHERE id=?", (fid,))
                    self.db.execute("INSERT INTO merge_log VALUES (?,?,?)", (fid, into_id, now()))
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
        self.bump(user_id)

    def reassign_spans(self, user_id: str, from_id: int, span_ids: list[int], new_id: int) -> None:
        marks = ",".join("?" * len(span_ids))
        self.x(f"UPDATE span SET entity_id=? WHERE user_id=? AND entity_id=? AND id IN ({marks})",
               (new_id, user_id, from_id, *span_ids))

    def set_fields(self, user_id: str, entity_id: int, **fields) -> None:
        if fields:
            cols = ",".join(f"{k}=?" for k in fields)
            self.x(f"UPDATE entity SET {cols}, updated_at=? WHERE id=? AND user_id=?",
                   (*fields.values(), now(), entity_id, user_id))
            self.bump(user_id)

    # -- pending lane
    def pending_add(self, user_id: str, session_id: str, c, entity_id: int) -> int | None:
        """Queue a low-confidence detection once per (entity, kind, text), whatever its later status."""
        with self.lock:
            if self.q("SELECT 1 FROM pending WHERE user_id=? AND entity_id=? AND kind=? AND text=? LIMIT 1",
                      (user_id, entity_id, c.kind, c.surface)):
                return None
            return self.x("INSERT INTO pending(user_id,session_id,kind,text,start,end,detector,score,created_at,"
                          "entity_id) VALUES (?,?,?,?,?,?,?,?,?,?)", (user_id, session_id, c.kind, c.surface, c.start,
                                                                     c.end, c.detector, c.score, now(), entity_id))

    def pending_list(self, user_id: str) -> list:
        return self.q("SELECT id, kind, text, detector, score, coalesce(session_id, '') AS session_id FROM pending"
                      " WHERE user_id=? AND status='open' ORDER BY id", (user_id,))

    def pending_get(self, user_id: str, pid: int):
        r = self.q("SELECT * FROM pending WHERE id=? AND user_id=?", (pid, user_id))
        return r[0] if r else None

    def pending_set(self, user_id: str, pid: int, status: str) -> None:
        self.x("UPDATE pending SET status=? WHERE id=? AND user_id=?", (status, pid, user_id))
