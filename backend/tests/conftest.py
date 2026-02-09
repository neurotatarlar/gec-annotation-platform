"""
Pytest test-client compatibility shim.

`starlette.testclient.TestClient` hangs in this environment (AnyIO portal deadlock), so tests
replace it with a small sync wrapper built on `httpx.ASGITransport`.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import anyio.to_thread as anyio_to_thread
import fastapi.concurrency as fastapi_concurrency
import fastapi.testclient as fastapi_testclient
import starlette.concurrency as starlette_concurrency
import starlette.testclient as starlette_testclient


class CompatTestClient:
    __test__ = False

    def __init__(self, app, base_url: str = "http://testserver", **_: Any) -> None:
        self.app = app
        self.base_url = base_url

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        async def run() -> httpx.Response:
            transport = httpx.ASGITransport(app=self.app)
            async with httpx.AsyncClient(
                transport=transport,
                base_url=self.base_url,
                follow_redirects=True,
            ) as client:
                return await client.request(method, url, **kwargs)

        return asyncio.run(run())

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        return self._request(method, url, **kwargs)

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("PUT", url, **kwargs)

    def delete(self, url: str, **kwargs: Any) -> httpx.Response:
        return self._request("DELETE", url, **kwargs)

    def __enter__(self) -> "CompatTestClient":
        return self

    def __exit__(self, *_: Any) -> bool:
        return False


# Patch both aliases used by tests.
fastapi_testclient.TestClient = CompatTestClient
starlette_testclient.TestClient = CompatTestClient


async def _run_in_process(func, *args, **kwargs):
    # AnyIO threadpool dispatch hangs in this environment on Python 3.13.
    return func(*args, **kwargs)


fastapi_concurrency.run_in_threadpool = _run_in_process
starlette_concurrency.run_in_threadpool = _run_in_process


async def _run_sync_inline(func, *args, **kwargs):
    kwargs.pop("abandon_on_cancel", None)
    kwargs.pop("cancellable", None)
    kwargs.pop("limiter", None)
    return func(*args, **kwargs)


anyio_to_thread.run_sync = _run_sync_inline
