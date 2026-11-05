"""Offline regressions for settlement at the normal SDK stream boundary."""
import asyncio
import json
import pathlib
import sys
import types
import os
import unittest
from types import SimpleNamespace
from unittest import mock

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
from admission_contract import Profile, RequestState, WireEvidence


class GatewaySettlementTests(unittest.IsolatedAsyncioTestCase):
    def make_request(self, wire_state="complete"):
        request = RequestState("POST", "/v1/chat/completions", b"{}", "a" * 64, "sk-test")
        request.dispatched = True
        request.alias = "chat"
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
            "providerKey": "installation",
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

    def set_runtime(self, profile=None):
        receipts = []
        runtime = object.__new__(gateway.Runtime)
        runtime.profile = profile or SimpleNamespace(document={"provider": "openai"}, route=lambda alias: SimpleNamespace(format="openai"))

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

    def embedding_profile(self):
        return Profile({"version": 1, "provider": "anthropic", "model": "brain-model", "providerBaseUrl": "https://provider.example.invalid",
            "aliases": ["lares-brain", "lares-writer", "lares-utility", "lares-gate", "lares-embed"], "maxBodyBytes": 4096, "maxOutputTokens": 123,
            "embedding": {"alias": "lares-embed", "provider": "openai", "model": "embed-model", "providerBaseUrl": "https://embed.example.invalid/v1",
                          "maxInputs": 32, "maxInputTokens": 8192}})

    def make_embedding_request(self, reply=None):
        request = self.make_request("none")
        request.path, request.alias = "/v1/embeddings", "lares-embed"
        request.allow["purposeAlias"] = "lares-embed"
        if reply is not None:
            evidence = WireEvidence("embedding", "application/json", 200)
            evidence.feed(json.dumps(reply).encode())
            request.wire_usage = evidence.finish()
        return request

    async def test_an_embeddings_reply_settles_from_the_providers_bytes_in_the_embedding_format(self):
        receipts = self.set_runtime(self.embedding_profile())
        reply = {"object": "list", "data": [{"object": "embedding", "index": 0, "embedding": [0.5]}], "usage": {"prompt_tokens": 7, "total_tokens": 7}}
        request = self.make_embedding_request(reply)
        self.assertEqual(request.wire_usage, {"inputTokens": 7, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0})
        # The SDK's rebuilt object is shaped however LiteLLM likes; only the raw bytes are evidence.
        rebuilt = SimpleNamespace(model_dump=lambda: {"object": "list", "data": [], "usage": {"prompt_tokens": 999}})
        token = gateway.current_request.set(request)
        try:
            self.assertIs(await gateway.gateway_hook.async_post_call_success_hook({}, None, rebuilt), rebuilt)
        finally:
            gateway.current_request.reset(token)
        self.assertEqual(len(receipts), 1)
        self.assertEqual((receipts[0]["format"], receipts[0]["usage"], receipts[0]["purposeAlias"]), ("embedding", request.wire_usage, "lares-embed"))

    async def test_an_embeddings_reply_without_exact_wire_usage_never_settles(self):
        receipts = self.set_runtime(self.embedding_profile())
        for reply in (None, {"object": "list", "data": [{"object": "embedding", "index": 0}], "usage": {"prompt_tokens": 7, "total_tokens": 8}},
                      {"object": "list", "data": [{"object": "embedding", "index": 0}], "usage": {"prompt_tokens": 7, "total_tokens": 7, "completion_tokens": 3}}):
            request = self.make_embedding_request(reply)
            self.assertIsNone(request.wire_usage)
            token = gateway.current_request.set(request)
            try:
                await gateway.gateway_hook.async_post_call_success_hook({}, None, SimpleNamespace(model_dump=lambda: {}))
            finally:
                gateway.current_request.reset(token)
        self.assertEqual(receipts, [])

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



class AgentProviderKeyDispatchTests(unittest.IsolatedAsyncioTestCase):
    """With an agent key selected, the receipt echoes the selector and the wire must carry exactly that key."""
    AGENT = "33333333-3333-4333-8333-333333333333"
    SECRET = "sk-agent-fixture-key"
    INSTALLATION = "sk-installation-fixture-key"

    def request(self, selector, path="/v1/chat/completions"):
        request = RequestState("POST", path, b"{}", "a" * 64, "sk-test")
        request.alias = "chat"
        request.phase = "armed"
        request.selector = selector
        request.provider_key = self.SECRET if selector != "installation" else None
        request.policy = SimpleNamespace(context=object(), release=self.release)
        return request

    async def release(self):
        self.released = getattr(self, "released", 0) + 1

    def transport(self, wire, upstream):
        runtime = SimpleNamespace(check_runtime=lambda: None, check_destination=lambda outgoing, request: None,
                                  profile=SimpleNamespace(route=lambda alias: SimpleNamespace(format=wire, key_env="LARES_MODEL_PROVIDER_KEY")))
        gateway.runtime = runtime
        transport = object.__new__(gateway.OneShotTransport)
        calls = []

        async def physical(outgoing):
            calls.append(outgoing)
            return SimpleNamespace(headers={"content-type": "application/json"}, status_code=200, stream=None)

        transport.inner = SimpleNamespace(handle_async_request=physical)
        return transport, calls

    def outgoing(self, *headers):
        return SimpleNamespace(headers=SimpleNamespace(multi_items=lambda: list(headers)))

    async def send(self, request, wire, *headers):
        transport, calls = self.transport(wire, None)
        transport.request = request
        token = gateway.current_request.set(request)
        try:
            with mock.patch.dict(os.environ, {"LARES_MODEL_PROVIDER_KEY": self.INSTALLATION}):
                await transport.handle_async_request(self.outgoing(*headers))
        finally:
            gateway.current_request.reset(token)
        return calls

    async def test_the_receipt_echoes_which_key_paid(self):
        for selector in ("installation", self.AGENT):
            request = RequestState("POST", "/v1/chat/completions", b"{}", "a" * 64, "sk-test")
            request.dispatched = True
            request.alias = "chat"
            request.allow = {"version": 1, "nonce": request.nonce, "requestHash": request.request_hash, "profileHash": "b" * 64, "endpointHash": request.endpoint_hash,
                             "keyFingerprint": request.key_fingerprint, "purposeAlias": "chat", "attemptId": "11111111-1111-4111-8111-111111111111",
                             "bindingId": "22222222-2222-4222-8222-222222222222", "providerKey": selector}
            request.wire_usage = {"inputTokens": 1, "outputTokens": 1, "cacheReadTokens": 0, "cacheWriteTokens": 0}
            sent = []
            runtime = object.__new__(gateway.Runtime)
            runtime.profile = SimpleNamespace(route=lambda alias: SimpleNamespace(format="openai"))

            async def rpc(path, body, sent=sent): sent.append(body)
            runtime.rpc = rpc
            gateway.runtime = runtime
            with self.subTest(selector=selector):
                await runtime.settle(request, None)
                self.assertEqual(sent[0]["providerKey"], selector)
                self.assertNotIn(self.SECRET, json.dumps(sent))

    async def test_the_agent_key_goes_on_the_wire_for_both_providers(self):
        for wire, header in (("openai", ("authorization", "Bearer " + self.SECRET)), ("anthropic", ("x-api-key", self.SECRET))):
            request = self.request(self.AGENT)
            with self.subTest(wire=wire):
                calls = await self.send(request, wire, ("content-type", "application/json"), header)
                self.assertEqual(len(calls), 1)
                self.assertTrue(request.dispatched)

    async def test_the_installation_key_never_reaches_the_provider_for_an_agent_that_has_its_own(self):
        for wire, header in (("openai", ("authorization", "Bearer " + self.INSTALLATION)), ("anthropic", ("x-api-key", self.INSTALLATION))):
            request = self.request(self.AGENT)
            with self.subTest(wire=wire), self.assertRaises(gateway.Refused):
                await self.send(request, wire, header)
            # Refused before the right to dispatch is spent: nothing was sent, and it can not be tried again with another key.
            self.assertFalse(request.dispatched)
            self.assertEqual(request.phase, "armed")
            self.assertTrue(request._authored_refusal, "the caller must get the fixed refusal, not a transport error")

    async def test_an_agent_key_that_was_never_loaded_is_a_refusal_not_a_fallback(self):
        request = self.request(self.AGENT)
        request.provider_key = None
        with self.assertRaises(gateway.Refused):
            await self.send(request, "openai", ("authorization", "Bearer " + self.INSTALLATION))
        self.assertFalse(request.dispatched)

    async def test_without_a_selected_key_the_wire_is_left_as_it_always_was(self):
        request = self.request("installation")
        calls = await self.send(request, "openai", ("authorization", "Bearer " + self.INSTALLATION))
        self.assertEqual(len(calls), 1)
        self.assertTrue(request.dispatched)

    async def test_the_deployment_hook_hands_the_anthropic_leaf_the_agent_key(self):
        request = self.request(self.AGENT, "/v1/messages")
        request.pre_seen = True
        request.allow = {}
        route = SimpleNamespace(model="m", litellm_model="anthropic/m", base="https://provider.invalid", format="anthropic")
        built = []

        async def client(selected, provider): built.append(provider); return "client"
        gateway.runtime = SimpleNamespace(profile=SimpleNamespace(document={"provider": "anthropic"}, route=lambda alias: route), client=client)
        token = gateway.current_request.set(request)
        try:
            call = {"model": "anthropic/m", "api_base": "https://provider.invalid", "api_key": self.INSTALLATION}
            kwargs = await gateway.gateway_hook.async_pre_call_deployment_hook(call, "anthropic_messages")
            self.assertEqual(kwargs["api_key"], self.SECRET)
            self.assertEqual(kwargs["client"], "client")
        finally:
            gateway.current_request.reset(token)


if __name__ == "__main__":
    unittest.main()
