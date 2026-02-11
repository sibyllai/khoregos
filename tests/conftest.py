"""Pytest fixtures for Khoregos tests."""

import asyncio
import tempfile
from pathlib import Path
from typing import AsyncGenerator

import pytest
import pytest_asyncio

from k6s.models.config import K6sConfig, generate_default_config
from k6s.store.db import Database


@pytest.fixture
def temp_dir() -> Path:
    """Create a temporary directory for testing."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def project_root(temp_dir: Path) -> Path:
    """Create a mock project root with .khoregos directory."""
    khoregos_dir = temp_dir / ".khoregos"
    khoregos_dir.mkdir()
    return temp_dir


@pytest.fixture
def config() -> K6sConfig:
    """Create a default configuration for testing."""
    return generate_default_config("test-project")


@pytest_asyncio.fixture
async def db(project_root: Path) -> AsyncGenerator[Database, None]:
    """Create a test database."""
    db_path = project_root / ".khoregos" / "k6s.db"
    database = Database(db_path)
    await database.connect()
    yield database
    await database.close()


@pytest.fixture
def session_id() -> str:
    """Generate a test session ID."""
    from ulid import ULID
    return str(ULID())
