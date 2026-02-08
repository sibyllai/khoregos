"""SQLite database connection and management."""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator

import aiosqlite

from k6s.store.migrations import SCHEMA_VERSION, get_migrations


class Database:
    """Async SQLite database manager with connection pooling."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._connection: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        """Initialize database connection and run migrations."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(self.db_path.parent, 0o700)
        self._connection = await aiosqlite.connect(self.db_path)
        os.chmod(self.db_path, 0o600)
        self._connection.row_factory = aiosqlite.Row

        # Configure SQLite for performance
        await self._connection.execute("PRAGMA journal_mode=WAL")
        await self._connection.execute("PRAGMA busy_timeout=5000")
        await self._connection.execute("PRAGMA synchronous=NORMAL")
        await self._connection.execute("PRAGMA foreign_keys=ON")

        # Run migrations
        await self._run_migrations()

    async def close(self) -> None:
        """Close database connection."""
        if self._connection:
            await self._connection.close()
            self._connection = None

    async def _run_migrations(self) -> None:
        """Run pending database migrations."""
        assert self._connection is not None

        # Create migrations table if it doesn't exist
        await self._connection.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        await self._connection.commit()

        # Get current version
        cursor = await self._connection.execute(
            "SELECT MAX(version) FROM schema_migrations"
        )
        row = await cursor.fetchone()
        current_version = row[0] if row[0] is not None else 0

        # Apply pending migrations
        migrations = get_migrations()
        for version, migration_sql in migrations:
            if version > current_version:
                await self._connection.executescript(migration_sql)
                await self._connection.execute(
                    "INSERT INTO schema_migrations (version) VALUES (?)",
                    (version,)
                )
                await self._connection.commit()

    @asynccontextmanager
    async def transaction(self) -> AsyncGenerator[aiosqlite.Connection, None]:
        """Context manager for database transactions."""
        async with self._lock:
            assert self._connection is not None
            try:
                yield self._connection
                await self._connection.commit()
            except Exception:
                await self._connection.rollback()
                raise

    async def execute(
        self, sql: str, params: tuple[Any, ...] | dict[str, Any] = ()
    ) -> aiosqlite.Cursor:
        """Execute a single SQL statement."""
        async with self._lock:
            assert self._connection is not None
            cursor = await self._connection.execute(sql, params)
            await self._connection.commit()
            return cursor

    async def execute_many(
        self, sql: str, params_list: list[tuple[Any, ...]]
    ) -> None:
        """Execute a SQL statement with multiple parameter sets."""
        async with self._lock:
            assert self._connection is not None
            await self._connection.executemany(sql, params_list)
            await self._connection.commit()

    async def fetch_one(
        self, sql: str, params: tuple[Any, ...] | dict[str, Any] = ()
    ) -> dict[str, Any] | None:
        """Fetch a single row as a dictionary."""
        async with self._lock:
            assert self._connection is not None
            cursor = await self._connection.execute(sql, params)
            row = await cursor.fetchone()
            if row is None:
                return None
            return dict(row)

    async def fetch_all(
        self, sql: str, params: tuple[Any, ...] | dict[str, Any] = ()
    ) -> list[dict[str, Any]]:
        """Fetch all rows as a list of dictionaries."""
        async with self._lock:
            assert self._connection is not None
            cursor = await self._connection.execute(sql, params)
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    async def insert(self, table: str, data: dict[str, Any]) -> str:
        """Insert a row and return the row ID."""
        columns = ", ".join(data.keys())
        placeholders = ", ".join("?" for _ in data)
        sql = f"INSERT INTO {table} ({columns}) VALUES ({placeholders})"

        async with self._lock:
            assert self._connection is not None
            cursor = await self._connection.execute(sql, tuple(data.values()))
            await self._connection.commit()
            return str(cursor.lastrowid)

    async def insert_or_replace(self, table: str, data: dict[str, Any]) -> None:
        """Insert or replace a row."""
        columns = ", ".join(data.keys())
        placeholders = ", ".join("?" for _ in data)
        sql = f"INSERT OR REPLACE INTO {table} ({columns}) VALUES ({placeholders})"

        await self.execute(sql, tuple(data.values()))

    async def update(
        self, table: str, data: dict[str, Any], where: str, where_params: tuple[Any, ...]
    ) -> int:
        """Update rows and return the number of affected rows."""
        set_clause = ", ".join(f"{k} = ?" for k in data.keys())
        sql = f"UPDATE {table} SET {set_clause} WHERE {where}"

        async with self._lock:
            assert self._connection is not None
            cursor = await self._connection.execute(
                sql, tuple(data.values()) + where_params
            )
            await self._connection.commit()
            return cursor.rowcount

    async def delete(self, table: str, where: str, where_params: tuple[Any, ...]) -> int:
        """Delete rows and return the number of affected rows."""
        sql = f"DELETE FROM {table} WHERE {where}"

        async with self._lock:
            assert self._connection is not None
            cursor = await self._connection.execute(sql, where_params)
            await self._connection.commit()
            return cursor.rowcount

    @property
    def schema_version(self) -> int:
        """Return the expected schema version."""
        return SCHEMA_VERSION


# Global database instance
_db: Database | None = None


def get_db_path(project_root: Path | None = None) -> Path:
    """Get the database path for the current project."""
    if project_root is None:
        project_root = Path.cwd()
    return project_root / ".khoregos" / "k6s.db"


async def get_database(project_root: Path | None = None) -> Database:
    """Get or create the global database instance."""
    global _db
    if _db is None:
        db_path = get_db_path(project_root)
        _db = Database(db_path)
        await _db.connect()
    return _db


async def close_database() -> None:
    """Close the global database instance."""
    global _db
    if _db is not None:
        await _db.close()
        _db = None
