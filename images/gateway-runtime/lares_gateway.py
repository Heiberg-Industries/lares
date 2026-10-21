"""Pinned LiteLLM adapter. Run in the original upstream image, never a derived image.

Native CLI prepares its schema before this process starts. Native ASGI lifespan and
authentication stay intact. No production authority or recovery witness is provided here.
"""
import asyncio
import contextvars
import hashlib
import importlib.metadata
import math
import os
import pathlib
import ssl
import sys
import time
from datetime import timedelta
from urllib.parse import urlsplit

import httpx
import litellm
import yaml
from fastapi import HTTPException
from litellm.proxy._types import ProxyException
from litellm.integrations.custom_logger import CustomLogger
from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler
from openai import AsyncOpenAI

from admission_contract import (
    ADMIT_PATH, SETTLE_PATH, ADMISSION_REFUSED_TYPE, ADMISSION_REFUSED_TEXT, CONTROL_ROUTES, HASH, MAX_RPC_BYTES, MODEL_ROUTES,
    RPC_TIMEOUT, TICKET, VERSION, Profile, Refused, RequestState, TerminalEvidence, WireEvidence, canonical,
    https_url, parse_json, protected_key, sign, verify,
    PHYSICAL_HEADER_SECONDS, PHYSICAL_BODY_SECONDS, TERMINAL_TAIL_SECONDS, CLEANUP_SECONDS, NATIVE_POLICY_SECONDS,
)

current_request = contextvars.ContextVar("lares_gateway_request", default=None)
runtime = None


def refusal():
    # Native handlers render the same terminal error shape for both model lanes.
    return ProxyException(message=ADMISSION_REFUSED_TEXT, type=ADMISSION_REFUSED_TYPE, param=None, code=400, openai_code=ADMISSION_REFUSED_TYPE)


class AdmissionHTTPRefusal(HTTPException):
    type = ADMISSION_REFUSED_TYPE
    param = None

    def __init__(self): super().__init__(status_code=400, detail=ADMISSION_REFUSED_TEXT)


def state():
    request = current_request.get()
    if request is None: raise Refused()
    return request


def load_files():
    try:
        if importlib.metadata.version("litellm") != "1.101.6": raise Refused()
        profile = Profile(parse_json(pathlib.Path(os.environ["LARES_GATEWAY_PROFILE_FILE"]).read_bytes()))
        config = yaml.safe_load(pathlib.Path(os.environ["CONFIG_FILE_PATH"]).read_bytes())
        if config != profile.expected_config(): raise Refused()
        endpoint = os.environ["LARES_GATEWAY_ENDPOINT_HASH"]
        if not HASH.fullmatch(endpoint): raise Refused()
        gate_url = https_url(os.environ["LARES_GATEWAY_ADMISSION_URL"])
        # Only an origin is accepted; the versioned RPC paths cannot be overridden.
        if urlsplit(gate_url).path not in ("", "/"): raise Refused()
        key = protected_key(os.environ["LARES_GATEWAY_SERVICE_KEY_FILE"])
        return profile, config, endpoint, gate_url, key
    except (KeyError, OSError, ValueError, TypeError, yaml.YAMLError): raise Refused() from None


class NativePolicy:
    """Fresh native rows locked AFTER the gate has committed, until physical send returns
    response headers/errors (30s header deadline, 35s transaction lifetime).
    Revocation serializes against these row locks.
    No lock crosses an admission/settlement RPC; no native budget atomicity is claimed.
    """
    def __init__(self): self.context = None

    async def acquire(self, request, alias):
        from litellm.proxy import proxy_server
        if not request.allow or request.dispatched or self.context is not None: raise Refused()
        request.fresh()
        db = proxy_server.prisma_client
        if db is None: raise Refused()
        self.context = db.db.tx(max_wait=timedelta(seconds=1), timeout=timedelta(seconds=NATIVE_POLICY_SECONDS))
        try:
            tx = await self.context.__aenter__()
            await tx.execute_raw("SET LOCAL lock_timeout = '1000ms'")
            rows = await tx.query_raw('''
              SELECT row_to_json(k) AS key, row_to_json(u) AS member,
                     row_to_json(t) AS team, row_to_json(m) AS membership,
                     row_to_json(b) AS budget, (k.expires IS NULL OR k.expires > clock_timestamp()) AS fresh
                FROM "LiteLLM_VerificationToken" k
                JOIN "LiteLLM_UserTable" u ON u.user_id=k.user_id
                JOIN "LiteLLM_TeamTable" t ON t.team_id=k.team_id
                JOIN "LiteLLM_TeamMembership" m ON m.user_id=u.user_id AND m.team_id=t.team_id
                JOIN "LiteLLM_BudgetTable" b ON b.budget_id=m.budget_id
               WHERE k.token=$1 FOR SHARE OF k,u,t,m,b
            ''', request.key_fingerprint)
            if len(rows) != 1: raise Refused()
            row = rows[0]
            k, u, t, m, b = (row[name] for name in ("key", "member", "team", "membership", "budget"))
            if not row["fresh"] or k["blocked"] is True or t["blocked"] is True or (u.get("metadata") or {}).get("scim_active") is False: raise Refused()
            if (u.get("user_role") or "") in ("proxy_admin", "proxy_admin_viewer"): raise Refused()
            if k["user_id"] != request.native_user or k["team_id"] != request.native_team: raise Refused()
            for entity in (k, u, t):
                models = entity.get("models") or []
                if models and alias not in models: raise Refused()
            if b.get("allowed_models") and alias not in b["allowed_models"]: raise Refused()
            if k.get("allowed_routes") and request.path not in k["allowed_routes"]: raise Refused()
            # Native caches are not authority. Missing member cap or missing configured
            # key/user/team caps do not become an implicit unlimited budget.
            for entity in (k, u, t, b):
                cap = entity.get("max_budget")
                spend = entity.get("spend", m["spend"] if entity is b else None)
                if isinstance(cap, bool) or not isinstance(cap, (int, float)) or not math.isfinite(cap) or cap <= 0: raise Refused()
                if isinstance(spend, bool) or not isinstance(spend, (int, float)) or not math.isfinite(spend) or spend < 0 or spend >= cap: raise Refused()
            # These native settings could override the fixed route or create subcalls.
            for entity in (k, t):
                for field in ("config", "router_settings", "aliases", "budget_fallbacks"):
                    if entity.get(field) not in (None, {}): raise Refused()
                if entity.get("metadata") not in (None, {}): raise Refused()
            for entity in (k, u, t, b):
                for field in ("model_max_budget", "budget_limits"):
                    if entity.get(field) not in (None, {}): raise Refused()
            if k.get("budget_id") or k.get("project_id") or k.get("organization_id") or t.get("organization_id") or u.get("organization_id"): raise Refused()
            request.fresh()
        except BaseException:
            await self.release()
            raise

    async def release(self):
        context, self.context = self.context, None
        if context is not None:
            # This read-only transaction can roll back even on success. Unknown cleanup
            # never restores the in-memory dispatch right.
            async with asyncio.timeout(CLEANUP_SECONDS):
                await context.__aexit__(Refused, Refused(), None)


class OneShotTransport(httpx.AsyncBaseTransport):
    def __init__(self, request, tls):
        self.request = request
        self.inner = httpx.AsyncHTTPTransport(verify=tls, retries=0)

    async def handle_async_request(self, outgoing):
        request = self.request
        runtime.check_runtime()
        runtime.check_destination(outgoing)
        if request.policy is None or request.policy.context is None: raise Refused()
        # No await between consuming the right and invoking the physical transport.
        request.burn()
        try:
            # SDKs may pass their own per-request timeout. This absolute bound is
            # independent of those extensions and shorter than native lock lifetime.
            async with asyncio.timeout(PHYSICAL_HEADER_SECONDS):
                response = await self.inner.handle_async_request(outgoing)
                evidence = WireEvidence(runtime.profile.document["provider"], response.headers.get("content-type", ""), response.status_code)
                if response.headers.get("content-encoding", "identity").lower() != "identity": evidence.poisoned = True
                response.stream = EvidenceStream(response.stream, evidence, request)
                return response
        finally:
            await asyncio.shield(request.policy.release())

    async def aclose(self): await self.inner.aclose()


class EvidenceStream(httpx.AsyncByteStream):
    def __init__(self, stream, evidence, request):
        self.stream, self.evidence, self.request = stream, evidence, request

    async def __aiter__(self):
        async with asyncio.timeout(PHYSICAL_BODY_SECONDS):
            async for raw in self.observe(): yield raw

    async def observe(self):
        iterator = self.stream.__aiter__()
        async for raw in iterator:
            self.evidence.feed(raw)
            terminal = self.evidence.sse and (self.evidence.done or self.evidence.events.stopped)
            if terminal:
                # SDKs can stop reading at [DONE]/message_stop, without asking for
                # EOF. Drain the bounded terminal tail BEFORE yielding that marker:
                # this detects late bytes/usage, and never trusts SDK synthesis.
                tail = []
                try:
                    async with asyncio.timeout(TERMINAL_TAIL_SECONDS):
                        async for more in iterator:
                            self.evidence.feed(more)
                            if self.evidence.poisoned: break
                            tail.append(more)
                except Exception: self.evidence.poisoned = True
                self.request.wire_usage = self.evidence.finish()
                yield raw
                for more in tail: yield more
                return
            yield raw
        self.request.wire_usage = self.evidence.finish()

    async def aclose(self): await self.stream.aclose()


class GuardedClientAuth(httpx.Auth):
    """A private object capability, never a header or body field. A native reconnect
    client has the event hook but cannot manufacture this request extension."""
    def __init__(self, request): self.request = request

    def auth_flow(self, outgoing):
        outgoing.extensions["lares.gateway.request"] = self.request
        outgoing.headers["accept-encoding"] = "identity"
        yield outgoing


class Runtime:
    def __init__(self):
        self.profile, self.config, self.endpoint, self.gate_url, self.key = load_files()
        self.callback_ids = None

    async def rpc(self, path, document):
        raw = canonical(document)
        if len(raw) > MAX_RPC_BYTES: raise Refused()
        # SSL_CERT_FILE is standard TLS trust configuration; HTTPS is mandatory even
        # in the image proof, which supplies a disposable CA. No insecure switch.
        context = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE"))
        try:
            async with asyncio.timeout(RPC_TIMEOUT), httpx.AsyncClient(verify=context, trust_env=False, follow_redirects=False,
                    timeout=RPC_TIMEOUT, transport=httpx.AsyncHTTPTransport(verify=context, retries=0)) as client:
                async with client.stream("POST", self.gate_url + path, content=raw, headers={"content-type": "application/json", "x-lares-signature": sign(self.key, "request", "POST", path, raw)}) as response:
                    result = bytearray()
                    async for chunk in response.aiter_bytes():
                        result.extend(chunk)
                        if len(result) > MAX_RPC_BYTES: raise Refused()
                    body = bytes(result)
                    if response.status_code != 200 or not verify(self.key, response.headers.get("x-lares-signature"), "response", "POST", path, body): raise Refused()
                    return parse_json(body)
        except Exception: raise Refused() from None

    def check_runtime(self, startup=False):
        from litellm.proxy import proxy_server
        from litellm.proxy.hooks import PROXY_HOOKS, get_proxy_hook
        from litellm._service_logger import ServiceLogging
        from litellm.rust_bridge.configuration import rust_enabled
        # Reject unreviewed background/config/provider paths. The fixed generated config
        # does not turn any of them on; check the loaded runtime too, not YAML alone.
        if rust_enabled() or litellm.cache is not None or not litellm.disable_aiohttp_transport or not litellm.use_chat_completions_url_for_anthropic_messages: raise Refused()
        allowed_types = {get_proxy_hook(name) for name in PROXY_HOOKS} | {ServiceLogging, type(gateway_hook)}
        callbacks = litellm.callbacks
        if not isinstance(callbacks, list) or sum(c is gateway_hook for c in callbacks) != 1 or any(type(c) not in allowed_types for c in callbacks): raise Refused()
        ids = tuple(id(c) for c in callbacks)
        if startup: self.callback_ids = ids
        elif ids != self.callback_ids: raise Refused()
        router = proxy_server.llm_router
        if router is None or set(router.model_names) != set(self.profile.document["aliases"]) or router.default_deployment is not None: raise Refused()
        for alias in self.profile.document["aliases"]:
            deployments = router.get_model_list(model_name=alias) or []
            if len(deployments) != 1: raise Refused()
            params = deployments[0]["litellm_params"]
            p = self.profile.document
            if params.get("model") != p["provider"] + "/" + p["model"] or params.get("api_base") != p["providerBaseUrl"]: raise Refused()
            if params.get("num_retries") != 0 or params.get("max_retries") != 0: raise Refused()
        if proxy_server.store_model_in_db or proxy_server.user_custom_auth is not None: raise Refused()

    def check_destination(self, outgoing):
        p = self.profile.document
        base = p["providerBaseUrl"]
        path = "/chat/completions" if p["provider"] == "openai" else "/v1/messages"
        if outgoing.method != "POST" or str(outgoing.url) != base + path: raise Refused()

    async def before_http(self, outgoing):
        request = state()
        if outgoing.extensions.get("lares.gateway.request") is not request: raise Refused()
        self.check_destination(outgoing)
        self.check_runtime()
        request.fresh()
        # Recreated Anthropic clients inherit this event hook, even though their
        # transport is native. A first attempt already burned the shared right;
        # a reconnect/reformat/SDK retry fails here before that transport is used.
        if request.dispatched or request.phase != "armed" or request.policy is not None: raise Refused()
        request.policy = NativePolicy()
        async with asyncio.timeout_at(request.deadline):
            await request.policy.acquire(request, request.alias)

    async def client(self, request, provider):
        context = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE"))
        client = httpx.AsyncClient(transport=OneShotTransport(request, context), verify=context,
            trust_env=False, follow_redirects=False, timeout=httpx.Timeout(PHYSICAL_HEADER_SECONDS),
            auth=GuardedClientAuth(request),
            event_hooks={"request": [self.before_http]})
        request.clients.append(client)
        if provider == "openai":
            return AsyncOpenAI(api_key=os.environ["LARES_MODEL_PROVIDER_KEY"], base_url=self.profile.document["providerBaseUrl"], max_retries=0, http_client=client)
        handler = AsyncHTTPHandler(timeout=PHYSICAL_HEADER_SECONDS, event_hooks={"request": [self.before_http]})
        original = handler.client
        handler.client = client
        await original.aclose()
        return handler

    async def settle(self, request, usage):
        if request.terminal or request.closed or request.cancelled or request.allow is None or not request.dispatched: return
        receipt = {name: request.allow[name] for name in ("version", "nonce", "requestHash", "profileHash", "endpointHash", "keyFingerprint", "purposeAlias", "attemptId", "bindingId")}
        if request.wire_usage is None: return
        receipt.update({"kind": "terminal-usage", "format": self.profile.document["provider"], "usage": request.wire_usage})
        receipt["receiptHash"] = hashlib.sha256(canonical(receipt)).hexdigest()
        request.terminal = True  # A lost reply is not permission to retry or release liability.
        try: await self.rpc(SETTLE_PATH, receipt)
        except Refused: pass  # Ledger reservation remains; no inferred zero charge.


def response_document(response):
    if hasattr(response, "model_dump"): response = response.model_dump()
    if isinstance(response, (str, bytes)):
        try:
            text = response.decode() if isinstance(response, bytes) else response
            lines = [line[6:] for line in text.splitlines() if line.startswith("data: ")]
            response = parse_json(lines[0]) if len(lines) == 1 else None
        except (Refused, UnicodeError): return None
    return response


class AdmissionHook(CustomLogger):
    async def async_post_call_failure_hook(self, request_data, original_exception, user_api_key_dict, traceback_str=None):
        request = current_request.get()
        # A native SDK can wrap our final policy refusal as a connection error.
        # Use the native supported failure-hook HTTPException transformation,
        # preserving the authored terminal type without rewriting paid failures.
        if request is not None and request.pre_seen and not request.dispatched:
            return AdmissionHTTPRefusal()

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            request = state()
            if request.pre_seen: raise Refused()
            request.pre_seen = True
            runtime.check_runtime()
            expected = "anthropic_messages" if request.path == "/v1/messages" else "acompletion"
            if call_type != expected: raise Refused()
            if not user_api_key_dict.user_id or not user_api_key_dict.team_id: raise Refused()
            if user_api_key_dict.api_key != request.key_fingerprint and getattr(user_api_key_dict, "token", None) != request.key_fingerprint: raise Refused()
            request.native_user, request.native_team = user_api_key_dict.user_id, user_api_key_dict.team_id
            request.alias = runtime.profile.check_body(request.path, request.raw)["model"]
            observation = request.observation(runtime.profile, request.ticket, request.alias)
            started = time.monotonic()
            reply = await runtime.rpc(ADMIT_PATH, observation)
            request.accept(observation, reply, started)
            return data
        except Exception: raise refusal() from None

    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        try:
            request = state()
            request.fresh()
            if not request.pre_seen or request.allow is None or request.dispatched: raise Refused()
            kind = getattr(call_type, "value", call_type)
            p = runtime.profile.document
            target = kwargs.get("model")
            if target not in (p["model"], p["provider"] + "/" + p["model"]): raise Refused()
            if kwargs.get("api_base") != p["providerBaseUrl"]: raise Refused()
            phases = request.deployment_phases
            expected = ["anthropic_messages"] if request.path == "/v1/messages" else ["acompletion"]
            if request.path == "/v1/messages" and p["provider"] == "openai": expected.append("acompletion")
            if phases != expected[:len(phases)] or len(phases) >= len(expected) or kind != expected[len(phases)]: raise Refused()
            phases.append(kind)
            # An approved translation envelope does not dispatch. Its one leaf gets
            # the target-specific client and shares exactly the same request state.
            if len(phases) == len(expected): kwargs["client"] = await runtime.client(request, p["provider"])
            kwargs.update({"num_retries": 0, "max_retries": 0, "rust": False})
            return kwargs
        except Exception: raise refusal() from None

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        request = state()
        usage = TerminalEvidence(request.path).nonstream(response_document(response))
        if request.dispatched and usage is not None:
            await runtime.settle(request, usage)
        return response

    async def async_post_call_streaming_iterator_hook(self, user_api_key_dict, response, request_data):
        request = state()
        evidence = TerminalEvidence(request.path)
        async for chunk in response:
            evidence.feed(response_document(chunk))
            yield chunk
        # Reached only on normal exhaustion, never cancellation or a partial stream.
        usage = evidence.result()
        if request.dispatched and usage is not None:
            await runtime.settle(request, usage)


gateway_hook = AdmissionHook(turn_off_message_logging=True)


class GatewayApp:
    def __init__(self, native): self.native = native

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            async def lifespan_send(message):
                if message["type"] == "lifespan.startup.complete":
                    try: runtime.check_runtime(startup=True)
                    except Exception:
                        await send({"type": "lifespan.startup.failed", "message": "Gateway admission runtime validation failed"})
                        return
                await send(message)
            await self.native(scope, receive, lifespan_send)
            return
        request, token = None, None
        try:
            if scope["type"] != "http" or scope.get("query_string") or scope.get("raw_path", scope["path"].encode()) != scope["path"].encode(): raise Refused()
            route = (scope["method"], scope["path"])
            if route in CONTROL_ROUTES:
                await self.native(scope, receive, send)
                return
            if route[0] != "POST" or route[1] not in MODEL_ROUTES: raise Refused()
            runtime.check_runtime()
            headers = {}
            allowed_headers = {b"host", b"connection", b"content-type", b"content-length", b"authorization", b"x-api-key", b"x-lares-budget-intent", b"anthropic-version", b"accept", b"accept-encoding", b"accept-language", b"sec-fetch-mode", b"user-agent"}
            for name, value in scope["headers"]:
                name = name.lower()
                if name in headers or name not in allowed_headers: raise Refused()
                headers[name] = value.decode("ascii")
            if headers.get(b"content-type", "").split(";")[0] != "application/json" or b"content-encoding" in headers: raise Refused()
            auth = headers.get(b"authorization", "")
            credential = auth[7:] if auth.startswith("Bearer ") else headers.get(b"x-api-key", "")
            if not credential or (headers.get(b"x-api-key") and headers[b"x-api-key"] != credential): raise Refused()
            ticket = headers.get(b"x-lares-budget-intent", "")
            if not TICKET.fullmatch(ticket): raise Refused()
            raw = bytearray()
            ingress_started = time.monotonic()
            async with asyncio.timeout(2):
                while True:
                    message = await receive()
                    if message["type"] != "http.request": raise Refused()
                    raw.extend(message.get("body", b""))
                    if len(raw) > runtime.profile.document["maxBodyBytes"]: raise Refused()
                    if not message.get("more_body", False): break
            runtime.profile.check_body(route[1], bytes(raw))
            request = RequestState(*route, bytes(raw), runtime.endpoint, credential, now=ingress_started)
            request.ticket = ticket
            token = current_request.set(request)
            consumed = False
            async def replay():
                nonlocal consumed
                if not consumed:
                    consumed = True
                    return {"type": "http.request", "body": request.raw, "more_body": False}
                message = await receive()
                if message["type"] == "http.disconnect": request.cancelled = True
                return message
            native_scope = dict(scope)
            # The ticket is adapter-only bearer material. Native audit/spend snapshots
            # must never receive it through their copy of request.headers.
            native_scope["headers"] = [(k, v) for k, v in scope["headers"] if k.lower() not in (b"x-lares-budget-intent", b"user-agent")]
            await self.native(native_scope, replay, send)
        except (Refused, TimeoutError, UnicodeError):
            await send({"type": "http.response.start", "status": 400, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": canonical({"error": {"type": ADMISSION_REFUSED_TYPE, "code": ADMISSION_REFUSED_TYPE, "message": ADMISSION_REFUSED_TEXT}})})
        finally:
            if request is not None:
                request.close()  # Child task contexts share this irreversible stop.
                try:
                    if request.policy is not None: await asyncio.shield(request.policy.release())
                    for client in request.clients:
                        async with asyncio.timeout(CLEANUP_SECONDS): await asyncio.shield(client.aclose())
                finally:
                    if token is not None: current_request.reset(token)


def main():
    global runtime
    try:
        runtime = Runtime()
        if "--check" in sys.argv: return
        from litellm.proxy.proxy_server import app
        import uvicorn
        uvicorn.run(GatewayApp(app), host="0.0.0.0", port=4000, workers=1, access_log=False)
    except Exception:
        print("lares: gateway admission configuration is missing or invalid", file=sys.stderr)
        raise SystemExit(78) from None


if __name__ == "__main__":
    # The native config imports this exact module instance, sharing the ContextVar.
    sys.modules["lares_gateway"] = sys.modules[__name__]
    main()
