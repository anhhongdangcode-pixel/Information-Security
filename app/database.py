"""
database.py — Quản lý kết nối MySQL + in-memory session store
"""

import asyncio
import logging
import aiomysql
from app.config import DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
from pymysql.constants import CLIENT

logger = logging.getLogger(__name__)

# ── In-memory session store (giữ nguyên logic cũ) ────────────────────────────
active_sessions: dict = {}
metadata_locks: dict = {}


def get_metadata_lock(folder_path_str: str) -> asyncio.Lock:
    if folder_path_str not in metadata_locks:
        metadata_locks[folder_path_str] = asyncio.Lock()
    return metadata_locks[folder_path_str]


# ── MySQL connection pool ─────────────────────────────────────────────────────
_pool: aiomysql.Pool | None = None


async def get_pool() -> aiomysql.Pool:
    """Trả về pool, tạo mới nếu chưa có."""
    global _pool
    if _pool is None:
        _pool = await aiomysql.create_pool(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            db=DB_NAME,
            charset="utf8mb4",
            autocommit=True,
            minsize=1,
            maxsize=5,
            client_flag = CLIENT.MULTI_STATEMENTS,
        )
        logger.info("✅ MySQL pool created")
    return _pool


async def close_pool():
    """Đóng pool khi shutdown app."""
    global _pool
    if _pool:
        _pool.close()
        await _pool.wait_closed()
        _pool = None
        logger.info("MySQL pool closed")


async def get_conn():
    """Context manager lấy connection từ pool."""
    pool = await get_pool()
    return pool.acquire()