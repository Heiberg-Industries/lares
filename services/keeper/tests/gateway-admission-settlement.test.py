"""Offline regressions for settlement at the normal SDK stream boundary."""
import asyncio
import json
import pathlib
import sys
import types
import unittest
from types import SimpleNamespace

ROOT = pathlib.Path(__file__).resolve().parents[3]
RUNTIME = ROOT / "images/gateway-runtime"
sys.path.insert(0, str(RUNTIME))


def install_import_stubs():
    """The adapter's hook and settle path need no provider SDK at test time."""
    httpx = types.ModuleType("httpx")
    for name in ("AsyncBaseTransport", "AsyncByteStream", "Auth"):
        setattr(httpx, name, type(name, (), {}))
    sys.modules["httpx"] = httpx

    fastapi = types.ModuleType("fastapi")
    fastapi.HTTPException = type("HTTPException", (Exception,), {})
    sys.modules["fastapi"] = fastapi

    # The tested hook and settlement methods do not use YAML; keep this offline
    # test independent of the gateway image's PyYAML dependency.
    sys.modules["yaml"] = types.ModuleType("yaml")

    litellm = types.ModuleType("litellm")
    sys.modules["litellm"] = litellm
    packages = (
        "litellm.proxy",
        "litellm.integrations",
        "litellm.llms",
        "litellm.llms.custom_httpx",
    )
    for name in packages:
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module

    proxy_types = types.ModuleType("litellm.proxy._types")
    proxy_types.ProxyException = type("ProxyException", (Exception,), {})
    sys.modules[proxy_types.__name__] = proxy_types

    custom_logger = types.ModuleType("litellm.integrations.custom_logger")
    custom_logger.CustomLogger = type(
        "CustomLogger",
        (),
        {"__init__": lambda self, *args, **kwargs: None},
    )
    sys.modules[custom_logger.__name__] = custom_logger

    handler = types.ModuleType("litellm.llms.custom_httpx.http_handler")
    handler.AsyncHTTPHandler = type("AsyncHTTPHandler", (), {})
    sys.modules[handler.__name__] = handler

    openai = types.ModuleType("openai")
    openai.AsyncOpenAI = type("AsyncOpenAI", (), {})
    sys.modules["openai"] = openai


install_import_stubs()
import lares_gateway as gateway
from admission_contract import RequestState, WireEvidence


class GatewaySettlementTests(unittest.IsolatedAsyncioTestCase):
    def make_request(self, wire_state="complete"):
        request = RequestState("POST", "/v1/chat/completions", b"{}", "a" * 64, "sk-test")
        request.dispatched = True
        request.allow = {
            "version": 1,
            "nonce": request.nonce,
            "requestHash": request.request_hash,
            "profileHash": "b" * 64,
            "endpointHash": request.endpoint_hash,
            "keyFingerprint": request.key_fingerprint,
            "purposeAlias": "chat",
            "attemptId": "11111111-1111-4111-8111-111111111111",
            "bindingId": "22222222-2222-4222-8222-222222222222",
        }

        if wire_state == "complete":
            evidence = WireEvidence("openai", "text/event-stream", 200)
            for event in (
                {"id": "provider-response", "choices": [{"index": 0, "finish_reason": "stop"}]},
                {"id": "provider-response", "choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}},
            ):
                evidence.feed(b"data: " + json.dumps(event).encode() + b"\n\n")
            evidence.feed(b"data: [DONE]\n\n")
            request.wire_usage = evidence.finish()
        elif wire_state == "malformed":
            evidence = WireEvidence("openai", "text/event-stream", 200)
            for event in (
                {"id": "provider-response", "choices": [{"index": 0, "finish_reason": "stop"}]},
                {"id": "provider-response", "choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 99}},
            ):
                evidence.feed(b"data: " + json.dumps(event).encode() + b"\n\n")
            evidence.feed(b"data: [DONE]\n\n")
            request.wire_usage = evidence.finish()
        return request

    def set_runtime(self):
        receipts = []
        runtime = object.__new__(gateway.Runtime)
        runtime.profile = SimpleNamespace(document={"provider": "openai"})

        async def rpc(path, body):
            self.assertEqual(path, gateway.SETTLE_PATH)
            receipts.append(body)
            return {"state": "recorded"}

        runtime.rpc = rpc
        gateway.runtime = runtime
        return receipts

    async def run_hook(self, request, source):
        token = gateway.current_request.set(request)
        try:
            output = []
            async for chunk in gateway.gateway_hook.async_post_call_streaming_iterator_hook(None, source, {}):
                output.append(chunk)
            return output
        finally:
            gateway.current_request.reset(token)

    async def test_native_chunks_without_usage_settle_from_strict_wire_usage(self):
        receipts = self.set_runtime()
        request = self.make_request()
        self.assertEqual(request.wire_usage, {"inputTokens": 12, "outputTokens": 4, "cacheReadTokens": 0, "cacheWriteTokens": 0})

        async def sdk_chunks():
            yield {"id": "provider-response", "choices": [{"index": 0, "delta": {"content": "answer"}, "finish_reason": None}]}
            yield {"id": "provider-response", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}

        await self.run_hook(request, sdk_chunks())
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0]["usage"], request.wire_usage)
        self.assertEqual(receipts[0]["kind"], "terminal-usage")

    async def test_early_close_and_stream_exception_do_not_settle(self):
        for failure in ("close", "cancel", "exception"):
            with self.subTest(failure=failure):
                receipts = self.set_runtime()
                request = self.make_request()

                async def sdk_chunks():
                    yield {"id": "provider-response", "choices": [{"index": 0, "delta": {}, "finish_reason": None}]}
                    if failure == "exception":
                        raise RuntimeError("stream interrupted")
                    if failure == "cancel":
                        raise asyncio.CancelledError()

                token = gateway.current_request.set(request)
                try:
                    stream = gateway.gateway_hook.async_post_call_streaming_iterator_hook(None, sdk_chunks(), {})
                    await anext(stream)
                    if failure == "close":
                        await stream.aclose()
                    elif failure == "cancel":
                        with self.assertRaises(asyncio.CancelledError):
                            await anext(stream)
                    else:
                        with self.assertRaises(RuntimeError):
                            await anext(stream)
                finally:
                    gateway.current_request.reset(token)
                self.assertEqual(receipts, [])

    async def test_closed_cancelled_missing_or_malformed_wire_never_settles(self):
        for state in ("closed", "cancelled", "missing", "malformed"):
            with self.subTest(state=state):
                receipts = self.set_runtime()
                request = self.make_request("malformed" if state == "malformed" else "complete")
                if state == "closed": request.closed = True
                if state == "cancelled": request.cancelled = True
                if state == "missing": request.wire_usage = None

                async def sdk_chunks():
                    yield {"id": "provider-response", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}

                await self.run_hook(request, sdk_chunks())
                self.assertEqual(receipts, [])


if __name__ == "__main__":
    unittest.main()
