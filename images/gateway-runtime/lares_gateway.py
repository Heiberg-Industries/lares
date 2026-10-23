"""Pinned LiteLLM adapter. Run in the original upstream image, never a derived image.

Native CLI prepares its schema before this process starts. Native ASGI lifespan and
authentication stay intact. No production authority or recovery witness is provided here.
"""
import asyncio
import contextvars
import hashlib
import hmac
import importlib.metadata
import math
import os
import pathlib
import re
import ssl
import sys
import tempfile
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
    NATIVE_MASTER_ROUTES, MAX_NATIVE_LOOKUP_BODY, native_lookup_query, native_lookup_key_hash, native_unblock_key_hash,
    RPC_TIMEOUT, TICKET, VERSION, Profile, Refused, RequestState, TerminalEvidence, WireEvidence, canonical,
    https_url, native_route_allowed, parse_json, protected_key, sign, valid_anthropic_safety_metadata, verify,
    PHYSICAL_HEADER_SECONDS, PHYSICAL_BODY_SECONDS, TERMINAL_TAIL_SECONDS, CLEANUP_SECONDS, NATIVE_POLICY_SECONDS,
)

current_request = contextvars.ContextVar("lares_gateway_request", default=None)
runtime = None
STARTUP_STATE_FILE = "/tmp/lares-gateway-startup-state.json"
STARTUP_FAILURE_FILE = "/tmp/lares-gateway-startup-first-failure.json"
MODEL_REQUEST_DIAGNOSTIC_FILE = "/tmp/lares-gateway-model-request.json"
STARTUP_PHASES = frozenset(("process-starting", "preflight-passed", "preflight-failed", "native-app-import", "native-app-import-failed", "asgi-server", "asgi-server-failed", "native-lifespan-starting", "native-lifespan-complete", "native-lifespan-failed", "native-lifespan-error", "runtime-validation-failed", "ready"))
STARTUP_STAGES = frozenset(("not-started", "runtime-imports", "runtime-flags", "callback-registry", "callback-types", "callback-native-identity", "callback-native-types", "callback-proxy-hook-types", "callback-native-membership", "callback-native-coverage", "callback-native-cost", "callback-secondary", "callback-identity", "router-aliases", "router-deployment-count", "router-target", "router-retries", "native-auth", "complete"))
MODEL_REQUEST_STAGES = frozenset(("runtime-check", "headers", "body", "profile", "native-dispatch", "native-response"))
MODEL_REQUEST_PRE_CALL_STAGES = frozenset(("idle", "entered", "runtime-check", "call-type", "identity", "credential",
    "profile-recheck", "observation", "bridge-rpc", "bridge-reply", "bridge-accepted", "deployment-hook",
    "http-guard", "policy-lock", "authored-refusal", "failure-hook"))
MODEL_REQUEST_RPC_STAGES = frozenset(("not-started", "serialization", "tls-context", "client-setup", "request-signature",
    "http-send", "http-status", "response-body", "response-signature", "response-json", "parsed"))
MODEL_REQUEST_RPC_STATUS_CLASSES = frozenset(("not-received", "success", "client-error", "server-error", "other"))
MODEL_REQUEST_COUNTER = 0


def _write_model_request_diagnostic(marker):
    """CI-only first-model-request shape metadata; never store request values or content."""
    if os.environ.get("CI") != "true" or os.environ.get("LARES_GATEWAY_PROBE_DIAGNOSTICS") != "1": return
    if type(marker) is not dict or marker.get("stage") not in MODEL_REQUEST_STAGES: return
    try:
        normalized = {
            "schema": 3,
            "requestCount": min(max(marker.get("requestCount", 0), 0), 1),
            "stage": marker["stage"],
            "preCallStage": marker.get("preCallStage", "idle") if marker.get("preCallStage", "idle") in MODEL_REQUEST_PRE_CALL_STAGES else "idle",
            "nativeRuntimeStage": marker.get("nativeRuntimeStage", "not-started") if marker.get("nativeRuntimeStage", "not-started") in STARTUP_STAGES else "not-started",
            "nativeRpcStage": marker.get("nativeRpcStage", "not-started") if marker.get("nativeRpcStage", "not-started") in MODEL_REQUEST_RPC_STAGES else "not-started",
            "nativeRpcStatusClass": marker.get("nativeRpcStatusClass", "not-received") if marker.get("nativeRpcStatusClass", "not-received") in MODEL_REQUEST_RPC_STATUS_CLASSES else "not-received",
            "statusCode": marker.get("statusCode", 0) if type(marker.get("statusCode", 0)) is int and 0 <= marker.get("statusCode", 0) <= 599 else 0,
            "checks": {},
            "unknownHeaderCount": min(max(marker.get("unknownHeaderCount", 0), 0), 31),
            "duplicateHeaderCount": min(max(marker.get("duplicateHeaderCount", 0), 0), 31),
            "unknownBodyFieldCount": min(max(marker.get("unknownBodyFieldCount", 0), 0), 31),
        }
        checks = marker.get("checks", {})
        for name in ("anthropicBetaPresent", "authorizationPresent", "apiKeyPresent", "ticketPresent", "contentTypeJson",
                     "modelAliasAllowed", "messagesIsList", "maxTokensAllowed", "physicalDispatchObserved", "anthropicSafetyMetadataValid",
                     "nativePreCallEntered", "nativeRuntimeCheckPassed", "nativeCallTypeMatched", "nativeIdentityPresent",
                     "nativeCredentialMatched", "nativeProfileRecheckPassed", "nativeObservationCreated", "nativeBridgeRpcAttempted",
                     "nativeBridgeReplyReceived", "nativeBridgeReplyAccepted", "nativeAuthoredRefusal", "nativeFailureHookEntered",
                     "nativeDeploymentHookEntered", "nativeHttpGuardPassed", "nativePolicyLockAcquired",
                     "nativeRpcSerialized", "nativeRpcTlsContextCreated", "nativeRpcClientReady", "nativeRpcSignatureCreated",
                     "nativeRpcSendStarted", "nativeRpcResponseReceived", "nativeRpcStatusAccepted", "nativeRpcResponseBodyComplete",
                     "nativeRpcResponseSignatureValid", "nativeRpcDocumentParsed"):
            normalized["checks"][name] = checks.get(name) is True if type(checks) is dict else False
        raw = canonical(normalized)
        if len(raw) > 2048: return
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(prefix=".lares-model-request-", dir="/tmp", delete=False) as destination:
                temporary = destination.name
                os.fchmod(destination.fileno(), 0o600)
                destination.write(raw)
            os.replace(temporary, MODEL_REQUEST_DIAGNOSTIC_FILE)
            temporary = None
        finally:
            if temporary is not None:
                try: os.unlink(temporary)
                except OSError: pass
    except Exception: pass  # Diagnostics cannot change gateway enforcement or responses.


def reset_model_request_diagnostic():
    global MODEL_REQUEST_COUNTER
    if os.environ.get("CI") != "true" or os.environ.get("LARES_GATEWAY_PROBE_DIAGNOSTICS") != "1": return
    MODEL_REQUEST_COUNTER = 0
    try: os.unlink(MODEL_REQUEST_DIAGNOSTIC_FILE)
    except OSError: pass
    _write_model_request_diagnostic({"requestCount": 0, "stage": "runtime-check"})


def begin_model_request_diagnostic():
    global MODEL_REQUEST_COUNTER
    if os.environ.get("CI") != "true" or os.environ.get("LARES_GATEWAY_PROBE_DIAGNOSTICS") != "1" or MODEL_REQUEST_COUNTER >= 1: return None
    MODEL_REQUEST_COUNTER = 1
    marker = {"requestCount": 1, "stage": "runtime-check"}
    _write_model_request_diagnostic(marker)
    return marker


def update_model_request_diagnostic(marker, stage, *, status_code=None, checks=None, unknown_header_count=None,
                                    duplicate_header_count=None, unknown_body_field_count=None, pre_call_stage=None, native_runtime_stage=None,
                                    native_rpc_stage=None, native_rpc_status_class=None):
    if marker is None: return
    try:
        marker["stage"] = stage
        if status_code is not None: marker["statusCode"] = status_code
        if checks is not None:
            current = marker.get("checks") if type(marker.get("checks")) is dict else {}
            current.update(checks)
            marker["checks"] = current
        if pre_call_stage is not None:
            marker["preCallStage"] = pre_call_stage if pre_call_stage in MODEL_REQUEST_PRE_CALL_STAGES else "idle"
        if native_runtime_stage is not None:
            marker["nativeRuntimeStage"] = native_runtime_stage if native_runtime_stage in STARTUP_STAGES else "not-started"
        if native_rpc_stage is not None:
            marker["nativeRpcStage"] = native_rpc_stage if native_rpc_stage in MODEL_REQUEST_RPC_STAGES else "not-started"
        if native_rpc_status_class is not None:
            marker["nativeRpcStatusClass"] = native_rpc_status_class if native_rpc_status_class in MODEL_REQUEST_RPC_STATUS_CLASSES else "not-received"
        if unknown_header_count is not None: marker["unknownHeaderCount"] = unknown_header_count
        if duplicate_header_count is not None: marker["duplicateHeaderCount"] = duplicate_header_count
        if unknown_body_field_count is not None: marker["unknownBodyFieldCount"] = unknown_body_field_count
        _write_model_request_diagnostic(marker)
    except Exception: pass  # Diagnostics cannot change gateway enforcement or responses.


def update_native_request_progress(request, stage, *, runtime_stage=None, **checks):
    """Record only fixed first-use stages and booleans; diagnostics never authorize work."""
    if request is None: return
    update_model_request_diagnostic(getattr(request, "diagnostic", None), "native-dispatch",
        checks=checks, pre_call_stage=stage, native_runtime_stage=runtime_stage)


def update_native_rpc_progress(request, path, stage, *, status_class=None, **checks):
    """Record fixed admission-RPC progress only; never records wire values."""
    if request is None or path != ADMIT_PATH: return
    update_model_request_diagnostic(getattr(request, "diagnostic", None), "native-dispatch",
        checks=checks, native_rpc_stage=stage, native_rpc_status_class=status_class)


def model_request_shape_checks(raw, profile, headers, path):
    """Return fixed request-shape metadata; malformed input never affects enforcement."""
    try:
        parsed = parse_json(raw)
        allowed = {"model", "messages", "max_tokens", "max_completion_tokens", "stream", "stream_options", "temperature", "top_p", "stop", "stop_sequences", "system", "tools", "tool_choice", "parallel_tool_calls", "thinking", "metadata"}
        unknown_fields = min(31, sum(name not in allowed for name in parsed) if type(parsed) is dict else 0)
        maximum = parsed.get("max_tokens", parsed.get("max_completion_tokens")) if type(parsed) is dict else None
        checks = {"anthropicBetaPresent": b"anthropic-beta" in headers,
            "authorizationPresent": b"authorization" in headers, "apiKeyPresent": b"x-api-key" in headers,
            "ticketPresent": b"x-lares-budget-intent" in headers,
            "contentTypeJson": headers.get(b"content-type", "").split(";")[0] == "application/json",
            "modelAliasAllowed": type(parsed) is dict and parsed.get("model") in profile.document["aliases"],
            "messagesIsList": type(parsed) is dict and type(parsed.get("messages")) is list,
            "maxTokensAllowed": type(maximum) is int and 1 <= maximum <= profile.document["maxOutputTokens"],
            "anthropicSafetyMetadataValid": "metadata" in parsed and valid_anthropic_safety_metadata(parsed["metadata"], path, profile.document["provider"])}
        return checks, unknown_fields
    except Exception:
        return {}, 0


def record_startup_diagnostic(phase, stage="not-started", checks=None):
    """CI-only, fixed vocabulary. Never store exception, config or provider values."""
    if os.environ.get("CI") != "true" or os.environ.get("LARES_GATEWAY_PROBE_DIAGNOSTICS") != "1": return
    if phase not in STARTUP_PHASES or stage not in STARTUP_STAGES: return
    temporary = None
    try:
        if phase == "process-starting":
            for name in (STARTUP_STATE_FILE, STARTUP_FAILURE_FILE, MODEL_REQUEST_DIAGNOSTIC_FILE):
                try: os.unlink(name)
                except OSError: pass
        marker = {"phase": phase, "stage": stage}
        if checks is not None: marker["checks"] = checks
        raw = canonical(marker)
        with tempfile.NamedTemporaryFile(prefix=".lares-gateway-startup-", dir=pathlib.Path(STARTUP_STATE_FILE).parent, delete=False) as destination:
            temporary = destination.name
            destination.write(raw)
        os.replace(temporary, STARTUP_STATE_FILE)
        temporary = None
        if phase.endswith(("-failed", "-error")):
            # An exclusive first-failure file survives subsequent shutdown labels.
            try: fd = os.open(STARTUP_FAILURE_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError: return
            with os.fdopen(fd, "wb") as destination: destination.write(raw)
    except OSError: pass # Diagnostics cannot change enforcement or startup outcomes.
    finally:
        if temporary is not None:
            try: os.unlink(temporary)
            except OSError: pass


def callback_startup_checks(proxy_server):
    """Fixed roles, capped counts and booleans only; no object/config strings."""
    from litellm.proxy.hooks import PROXY_HOOKS
    from litellm.proxy.hooks.model_max_budget_limiter import _PROXY_VirtualKeyModelMaxBudgetLimiter
    from litellm.proxy.hooks.proxy_track_cost_callback import _ProxyDBLogger
    from litellm.integrations.shadow_eval_logger import ShadowEvalLogger
    from litellm._service_logger import ServiceLogging
    from litellm import Router
    from types import MethodType
    roles = ("max_budget_limiter", "parallel_request_limiter", "cache_control_check", "responses_id_security",
             "litellm_skills", "max_iterations_limiter", "max_budget_per_session_limiter", "sensitive_data_routing")
    cap = lambda values: min(sum(values), 31)
    callbacks = litellm.callbacks if type(litellm.callbacks) is list else []
    logging = proxy_server.proxy_logging_obj
    mapping = logging.proxy_hook_mapping
    native = [proxy_server.model_max_budget_limiter, logging.service_logging_obj, *mapping.values()]
    allowed = set(PROXY_HOOKS.values()) | {ServiceLogging, type(gateway_hook), _ProxyDBLogger, _PROXY_VirtualKeyModelMaxBudgetLimiter}
    checks = {"primary": {
        "list": type(litellm.callbacks) is list,
        "gateway_count": cap(c is gateway_hook for c in callbacks),
        "db_count": cap(type(c) is _ProxyDBLogger for c in callbacks),
        "unique_types": len({type(c) for c in callbacks}) == len(callbacks),
        "unknown_count": cap(type(c) not in allowed for c in callbacks),
        "unowned_count": cap(c is not gateway_hook and type(c) is not _ProxyDBLogger and not any(c is owner for owner in native) for c in callbacks),
        "unknown_mapping_count": cap(name not in PROXY_HOOKS for name in mapping),
    }, "native": {}, "proxy_hooks": {}, "events": {}}
    for role, owner, expected in (("model_budget", native[0], _PROXY_VirtualKeyModelMaxBudgetLimiter), ("service", native[1], ServiceLogging)):
        checks["native"][role] = {"owner_type": type(owner) is expected, "owner_present": any(c is owner for c in callbacks),
                                  "count": cap(type(c) is expected for c in callbacks)}
    for role in roles:
        expected = PROXY_HOOKS.get(role)
        owner = mapping.get(role)
        checks["proxy_hooks"][role] = {"mapped": role in mapping, "mapped_type": expected is not None and type(owner) is expected,
            "mapped_present": owner is not None and any(c is owner for c in callbacks), "count": cap(type(c) is expected for c in callbacks)}
    router = proxy_server.llm_router
    methods = {"success_callback": "sync_deployment_callback_on_success", "_async_success_callback": "deployment_callback_on_success",
               "failure_callback": "deployment_callback_on_failure", "_async_failure_callback": "async_deployment_callback_on_failure"}
    for name in ("input_callback", "_async_input_callback", "success_callback", "failure_callback", "_async_success_callback", "_async_failure_callback", "service_callback", "audit_log_callbacks"):
        registry = getattr(litellm, name)
        items = registry if type(registry) is list else []
        method = methods.get(name)
        router_callback = lambda c: (type(router) is Router and type(c) is MethodType and c.__self__ is router
                                     and method is not None and c.__func__ is getattr(Router, method))
        primary_callback = lambda c: any(c is primary for primary in callbacks)
        checks["events"][name] = {"list": type(registry) is list, "unique_objects": len({id(c) for c in items}) == len(items),
            "primary_count": cap(primary_callback(c) for c in items), "db_count": cap(type(c) is _ProxyDBLogger for c in items),
            "shadow_count": cap(type(c) is ShadowEvalLogger for c in items), "router_count": cap(router_callback(c) for c in items),
            "unknown_count": cap(not primary_callback(c) and not router_callback(c) and not (name == "_async_success_callback" and type(c) is _ProxyDBLogger) for c in items)}
    return checks


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
            if not native_route_allowed(k.get("allowed_routes"), request.path): raise Refused()
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
        self.master_key = os.environ.get("LARES_GATEWAY_MASTER_KEY")
        self.callback_ids = None
        self.secondary_callback_ids = None
        self.callback_references = None
        self.validation_stage = "not-started"
        self.startup_checks = None

    async def rpc(self, path, document):
        request = current_request.get() if path == ADMIT_PATH else None
        update_native_rpc_progress(request, path, "serialization")
        raw = canonical(document)
        if len(raw) > MAX_RPC_BYTES: raise Refused()
        update_native_rpc_progress(request, path, "tls-context", nativeRpcSerialized=True)
        # SSL_CERT_FILE is standard TLS trust configuration; HTTPS is mandatory even
        # in the image proof, which supplies a disposable CA. No insecure switch.
        context = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE"))
        update_native_rpc_progress(request, path, "client-setup", nativeRpcTlsContextCreated=True)
        try:
            async with asyncio.timeout(RPC_TIMEOUT), httpx.AsyncClient(verify=context, trust_env=False, follow_redirects=False,
                    timeout=RPC_TIMEOUT, transport=httpx.AsyncHTTPTransport(verify=context, retries=0)) as client:
                update_native_rpc_progress(request, path, "request-signature", nativeRpcClientReady=True)
                signature = sign(self.key, "request", "POST", path, raw)
                update_native_rpc_progress(request, path, "http-send", nativeRpcSignatureCreated=True, nativeRpcSendStarted=True)
                async with client.stream("POST", self.gate_url + path, content=raw, headers={"content-type": "application/json", "x-lares-signature": signature}) as response:
                    status_class = "success" if response.status_code == 200 else (
                        "client-error" if type(response.status_code) is int and 400 <= response.status_code <= 499 else
                        "server-error" if type(response.status_code) is int and 500 <= response.status_code <= 599 else "other")
                    update_native_rpc_progress(request, path, "http-status", status_class=status_class,
                        nativeRpcResponseReceived=True, nativeRpcStatusAccepted=response.status_code == 200)
                    result = bytearray()
                    update_native_rpc_progress(request, path, "response-body")
                    async for chunk in response.aiter_bytes():
                        result.extend(chunk)
                        if len(result) > MAX_RPC_BYTES: raise Refused()
                    body = bytes(result)
                    update_native_rpc_progress(request, path, "response-signature", nativeRpcResponseBodyComplete=True)
                    if response.status_code != 200: raise Refused()
                    signature_valid = verify(self.key, response.headers.get("x-lares-signature"), "response", "POST", path, body)
                    update_native_rpc_progress(request, path, "response-json", nativeRpcResponseSignatureValid=signature_valid)
                    if not signature_valid: raise Refused()
                    document = parse_json(body)
                    update_native_rpc_progress(request, path, "parsed", nativeRpcDocumentParsed=True)
                    return document
        except Exception: raise Refused() from None

    def check_callbacks(self, proxy_server, startup=False):
        from litellm.proxy.hooks import PROXY_HOOKS, get_proxy_hook
        from litellm.proxy.hooks.model_max_budget_limiter import _PROXY_VirtualKeyModelMaxBudgetLimiter
        from litellm.proxy.hooks.proxy_track_cost_callback import _ProxyDBLogger
        from litellm.integrations.shadow_eval_logger import ShadowEvalLogger
        from litellm._service_logger import ServiceLogging
        from litellm import Router
        from types import MethodType

        # Native startup fans callbacks into event lists. The manager's removal
        # helper omits input, async-input, service and audit, so enumerate all of
        # the pinned registries explicitly. Never invoke a shadow hook to disable it.
        self.validation_stage = "callback-registry"
        names = ("callbacks", "input_callback", "_async_input_callback", "success_callback", "failure_callback",
                 "_async_success_callback", "_async_failure_callback", "service_callback", "audit_log_callbacks")
        registries = {name: getattr(litellm, name) for name in names}
        if any(type(items) is not list for items in registries.values()): raise Refused()
        if startup:
            if self.callback_ids is not None: raise Refused()
            for items in registries.values():
                items[:] = [c for c in items if type(c) is not ShadowEvalLogger]

            # LiteLLM 1.101.6 registers this module-global singleton when the
            # skills hook module is imported. ProxyLogging._add_proxy_hooks then
            # constructs a second default instance: the callback manager keeps
            # the singleton but proxy_hook_mapping stores the new instance.
            # Rebind only that mapping entry, and only when both instances have
            # the exact pinned default state and the sole primary callback is
            # LiteLLM's module-global owner. This does not bless replacements.
            skills_type = PROXY_HOOKS.get("litellm_skills")
            logging_owner = proxy_server.proxy_logging_obj
            mapping = logging_owner.proxy_hook_mapping
            mapped_skills = mapping.get("litellm_skills")
            if skills_type is not None and type(mapped_skills) is skills_type:
                from litellm.proxy.hooks.litellm_skills.main import skills_injection_hook
                from litellm.llms.litellm_proxy.skills.constants import DEFAULT_MAX_ITERATIONS, DEFAULT_SANDBOX_TIMEOUT

                skills_matches = [callback for callback in registries["callbacks"] if type(callback) is skills_type]
                default_state = lambda hook: (
                    set(vars(hook)) == {"optional_params", "prompt_handler", "max_iterations", "sandbox_timeout",
                                        "message_logging", "turn_off_message_logging"}
                    and type(hook.optional_params) is dict and hook.optional_params == {}
                    and type(hook.max_iterations) is int and hook.max_iterations == DEFAULT_MAX_ITERATIONS
                    and type(hook.sandbox_timeout) is int and hook.sandbox_timeout == DEFAULT_SANDBOX_TIMEOUT
                    and type(hook.prompt_handler) is type(skills_injection_hook.prompt_handler)
                    and vars(hook.prompt_handler) == {}
                    and type(hook.message_logging) is bool and hook.message_logging is True
                    and type(hook.turn_off_message_logging) is bool and hook.turn_off_message_logging is False
                )
                if (len(skills_matches) == 1 and skills_matches[0] is skills_injection_hook
                        and type(skills_injection_hook) is skills_type and mapped_skills is not skills_injection_hook
                        and default_state(skills_injection_hook) and default_state(mapped_skills)):
                    mapping["litellm_skills"] = skills_injection_hook

        if startup and os.environ.get("CI") == "true" and os.environ.get("LARES_GATEWAY_PROBE_DIAGNOSTICS") == "1":
            try: self.startup_checks = callback_startup_checks(proxy_server)
            except Exception: self.startup_checks = None  # Diagnostics never alter enforcement.
        self.validation_stage = "callback-types"
        allowed_types = {get_proxy_hook(name) for name in PROXY_HOOKS} | {ServiceLogging, type(gateway_hook), _ProxyDBLogger, _PROXY_VirtualKeyModelMaxBudgetLimiter}
        callbacks = registries["callbacks"]
        if sum(c is gateway_hook for c in callbacks) != 1 or any(type(c) not in allowed_types for c in callbacks): raise Refused()
        if len({type(c) for c in callbacks}) != len(callbacks): raise Refused()
        # The native budget and service hooks have owner-held instances. A second
        # object of their class is not an approved replacement.
        self.validation_stage = "callback-native-identity"
        logging = proxy_server.proxy_logging_obj
        native = [proxy_server.model_max_budget_limiter, logging.service_logging_obj]
        self.validation_stage = "callback-native-types"
        if type(native[0]) is not _PROXY_VirtualKeyModelMaxBudgetLimiter or type(native[1]) is not ServiceLogging: raise Refused()
        self.validation_stage = "callback-proxy-hook-types"
        for name, hook in logging.proxy_hook_mapping.items():
            if name not in PROXY_HOOKS or type(hook) is not get_proxy_hook(name): raise Refused()
            native.append(hook)
        self.validation_stage = "callback-native-membership"
        if any(not any(c is hook for c in callbacks) for hook in native): raise Refused()
        self.validation_stage = "callback-native-coverage"
        if any(c is not gateway_hook and type(c) is not _ProxyDBLogger and not any(c is hook for hook in native) for c in callbacks): raise Refused()
        self.validation_stage = "callback-native-cost"
        if sum(type(c) is _ProxyDBLogger for c in callbacks) != 1: raise Refused()

        self.validation_stage = "callback-secondary"
        primary_ids = {id(c) for c in callbacks}
        router = proxy_server.llm_router
        router_methods = {"success_callback": "sync_deployment_callback_on_success", "_async_success_callback": "deployment_callback_on_success",
                          "failure_callback": "deployment_callback_on_failure", "_async_failure_callback": "async_deployment_callback_on_failure"}
        secondary = {}
        for name in names[1:]:
            items = registries[name]
            if len({id(c) for c in items}) != len(items): raise Refused()
            extras = []
            method = router_methods.get(name)
            method_count = 0
            for c in items:
                if id(c) in primary_ids: continue  # Native lazy event-list promotion.
                if startup and name == "_async_success_callback" and type(c) is _ProxyDBLogger:
                    extras.append(id(c))  # cost_tracking creates a separate instance.
                    continue
                if (type(router) is Router and type(c) is MethodType and c.__self__ is router
                        and method is not None and c.__func__ is getattr(Router, method)):
                    method_count += 1
                    extras.append(id(c))
                    continue
                if not startup and self.secondary_callback_ids is not None and id(c) in self.secondary_callback_ids[name]:
                    extras.append(id(c))
                    continue
                raise Refused()
            db_count = sum(type(c) is _ProxyDBLogger for c in items)
            if db_count > 1 or (name == "_async_success_callback" and db_count != 1): raise Refused()
            if method is not None and method_count != 1: raise Refused()
            secondary[name] = tuple(extras)
        self.validation_stage = "callback-identity"
        ids = tuple(id(c) for c in callbacks)
        if startup:
            if self.callback_ids is not None or self.secondary_callback_ids is not None: raise Refused()
            self.callback_ids, self.secondary_callback_ids = ids, secondary
            # Hold references so a removed object cannot recycle an approved id.
            self.callback_references = tuple(c for items in registries.values() for c in items)
        elif ids != self.callback_ids or secondary != self.secondary_callback_ids: raise Refused()

    def check_runtime(self, startup=False):
        self.validation_stage = "runtime-imports"
        from litellm.proxy import proxy_server
        from litellm.rust_bridge.configuration import rust_enabled
        # Reject unreviewed background/config/provider paths. The fixed generated config
        # does not turn any of them on; check the loaded runtime too, not YAML alone.
        self.validation_stage = "runtime-flags"
        if rust_enabled() or litellm.cache is not None or not litellm.disable_aiohttp_transport or not litellm.use_chat_completions_url_for_anthropic_messages: raise Refused()
        self.check_callbacks(proxy_server, startup)
        router = proxy_server.llm_router
        self.validation_stage = "router-aliases"
        if router is None or set(router.model_names) != set(self.profile.document["aliases"]) or router.default_deployment is not None: raise Refused()
        for alias in self.profile.document["aliases"]:
            self.validation_stage = "router-deployment-count"
            deployments = router.get_model_list(model_name=alias) or []
            if len(deployments) != 1: raise Refused()
            params = deployments[0]["litellm_params"]
            p = self.profile.document
            self.validation_stage = "router-target"
            if params.get("model") != p["provider"] + "/" + p["model"] or params.get("api_base") != p["providerBaseUrl"]: raise Refused()
            self.validation_stage = "router-retries"
            if params.get("num_retries") != 0 or params.get("max_retries") != 0: raise Refused()
        self.validation_stage = "native-auth"
        if proxy_server.store_model_in_db or proxy_server.user_custom_auth is not None: raise Refused()
        self.validation_stage = "complete"

    def check_destination(self, outgoing):
        p = self.profile.document
        base = p["providerBaseUrl"]
        path = "/chat/completions" if p["provider"] == "openai" else "/v1/messages"
        if outgoing.method != "POST" or str(outgoing.url) != base + path: raise Refused()

    async def before_http(self, outgoing):
        request = current_request.get()
        deadline = None
        try:
            request = state()
            update_native_request_progress(request, "http-guard")
            if outgoing.extensions.get("lares.gateway.request") is not request: raise Refused()
            self.check_destination(outgoing)
            try: self.check_runtime()
            finally: update_native_request_progress(request, "http-guard", runtime_stage=runtime.validation_stage)
            request.fresh()
            # Recreated Anthropic clients inherit this event hook, even though their
            # transport is native. A first attempt already burned the shared right;
            # a reconnect/reformat/SDK retry fails here before that transport is used.
            if request.dispatched or request.phase != "armed" or request.policy is not None: raise Refused()
            update_native_request_progress(request, "http-guard", nativeHttpGuardPassed=True)
            request.policy = NativePolicy()
            update_native_request_progress(request, "policy-lock")
            deadline = asyncio.timeout_at(request.deadline)
            async with deadline:
                await request.policy.acquire(request, request.alias)
            update_native_request_progress(request, "policy-lock", nativePolicyLockAcquired=True)
        except Refused:
            if request is not None and not request.dispatched:
                request._authored_refusal = True
                update_native_request_progress(request, "authored-refusal", nativeAuthoredRefusal=True)
            raise
        except TimeoutError:
            # Only the explicit request deadline is an authored guard refusal. A
            # timeout raised by another component must retain its native meaning.
            if request is not None and not request.dispatched and deadline is not None and deadline.expired():
                request._authored_refusal = True
                update_native_request_progress(request, "authored-refusal", nativeAuthoredRefusal=True)
            raise

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
        update_native_request_progress(request, "failure-hook", nativeFailureHookEntered=True,
            nativeAuthoredRefusal=request is not None and request._authored_refusal and not request.dispatched)
        # A native SDK can wrap our final policy refusal as a connection error.
        # Use the native supported failure-hook HTTPException transformation,
        # preserving the authored terminal type without rewriting paid failures.
        if request is not None and request._authored_refusal and not request.dispatched:
            return AdmissionHTTPRefusal()

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        request = current_request.get()
        try:
            request = state()
            update_native_request_progress(request, "entered", nativePreCallEntered=True)
            if request.pre_seen: raise Refused()
            request.pre_seen = True
            update_native_request_progress(request, "runtime-check")
            try: runtime.check_runtime()
            finally: update_native_request_progress(request, "runtime-check", runtime_stage=runtime.validation_stage)
            update_native_request_progress(request, "runtime-check", nativeRuntimeCheckPassed=True)
            update_native_request_progress(request, "call-type")
            expected = "anthropic_messages" if request.path == "/v1/messages" else "acompletion"
            if call_type != expected: raise Refused()
            update_native_request_progress(request, "call-type", nativeCallTypeMatched=True)
            update_native_request_progress(request, "identity")
            if not user_api_key_dict.user_id or not user_api_key_dict.team_id: raise Refused()
            update_native_request_progress(request, "identity", nativeIdentityPresent=True)
            update_native_request_progress(request, "credential")
            if user_api_key_dict.api_key != request.key_fingerprint and getattr(user_api_key_dict, "token", None) != request.key_fingerprint: raise Refused()
            update_native_request_progress(request, "credential", nativeCredentialMatched=True)
            request.native_user, request.native_team = user_api_key_dict.user_id, user_api_key_dict.team_id
            update_native_request_progress(request, "profile-recheck")
            request.alias = runtime.profile.check_body(request.path, request.raw)["model"]
            update_native_request_progress(request, "profile-recheck", nativeProfileRecheckPassed=True)
            update_native_request_progress(request, "observation")
            observation = request.observation(runtime.profile, request.ticket, request.alias)
            update_native_request_progress(request, "observation", nativeObservationCreated=True)
            started = time.monotonic()
            update_native_request_progress(request, "bridge-rpc", nativeBridgeRpcAttempted=True)
            reply = await runtime.rpc(ADMIT_PATH, observation)
            update_native_request_progress(request, "bridge-reply", nativeBridgeReplyReceived=True)
            request.accept(observation, reply, started)
            update_native_request_progress(request, "bridge-accepted", nativeBridgeReplyAccepted=True)
            return data
        except Refused:
            request = current_request.get()
            if request is not None and not request.dispatched:
                request._authored_refusal = True
                update_native_request_progress(request, "authored-refusal", nativeAuthoredRefusal=True)
            raise refusal() from None

    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        request = current_request.get()
        try:
            request = state()
            update_native_request_progress(request, "deployment-hook", nativeDeploymentHookEntered=True)
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
        except Refused:
            request = current_request.get()
            if request is not None and not request.dispatched:
                request._authored_refusal = True
                update_native_request_progress(request, "authored-refusal", nativeAuthoredRefusal=True)
            raise refusal() from None

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        request = state()
        usage = TerminalEvidence(request.path).nonstream(response_document(response))
        if request.dispatched and usage is not None:
            await runtime.settle(request, usage)
        return response

    async def async_post_call_streaming_iterator_hook(self, user_api_key_dict, response, request_data):
        request = state()
        async for chunk in response:
            yield chunk
        # Normal exhaustion is required; settlement itself accepts only strict raw
        # provider usage recorded by EvidenceStream, never SDK-reconstructed usage.
        if request.dispatched:
            await runtime.settle(request, None)


gateway_hook = AdmissionHook(turn_off_message_logging=True)


class GatewayApp:
    def __init__(self, native): self.native = native

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            record_startup_diagnostic("native-lifespan-starting")
            async def lifespan_send(message):
                if message["type"] == "lifespan.startup.complete":
                    record_startup_diagnostic("native-lifespan-complete")
                    try: runtime.check_runtime(startup=True)
                    except Exception:
                        record_startup_diagnostic("runtime-validation-failed", runtime.validation_stage, runtime.startup_checks)
                        await send({"type": "lifespan.startup.failed", "message": "Gateway admission runtime validation failed: " + runtime.validation_stage})
                        return
                    record_startup_diagnostic("ready", runtime.validation_stage)
                elif message["type"] == "lifespan.startup.failed": record_startup_diagnostic("native-lifespan-failed")
                await send(message)
            try: await self.native(scope, receive, lifespan_send)
            except BaseException:
                record_startup_diagnostic("native-lifespan-error", runtime.validation_stage)
                raise
            return
        request, token, native_invoked, diagnostic = None, None, False, None
        outward_response_started = False
        async def outward_send(message):
            nonlocal outward_response_started
            if message["type"] == "http.response.start": outward_response_started = True
            await send(message)
        try:
            if scope["type"] != "http" or scope.get("raw_path", scope["path"].encode()) != scope["path"].encode(): raise Refused()
            route = (scope["method"], scope["path"])
            if route in NATIVE_MASTER_ROUTES:
                query = scope.get("query_string", b"")
                if route[0] == "GET": native_lookup_query(route[1], query)
                elif query: raise Refused()

                # These native operations expose or change key state. Only
                # the configured gateway master Bearer may reach LiteLLM's own auth.
                # A role-bearing virtual key is still a virtual key and is refused here.
                headers = {}
                admin_headers = {b"host", b"connection", b"content-type", b"content-length", b"authorization", b"accept", b"accept-encoding", b"accept-language", b"sec-fetch-mode", b"user-agent"}
                for name, value in scope["headers"]:
                    name = name.lower()
                    if name in headers or name not in admin_headers: raise Refused()
                    headers[name] = value
                authorization = headers.get(b"authorization", b"")
                configured_master = runtime.master_key
                if (not authorization.startswith(b"Bearer ") or not configured_master or
                    not hmac.compare_digest(authorization[7:], configured_master.encode("utf-8"))): raise Refused()

                maximum = MAX_NATIVE_LOOKUP_BODY if route[0] == "POST" else 0
                if route[0] == "POST":
                    if headers.get(b"content-type") != b"application/json": raise Refused()
                elif b"content-type" in headers:
                    raise Refused()
                length = headers.get(b"content-length")
                if length is not None:
                    if re.fullmatch(rb"(?:0|[1-9][0-9]{0,5})", length) is None or int(length) > maximum: raise Refused()
                raw = bytearray()
                async with asyncio.timeout(2):
                    while True:
                        message = await receive()
                        if message["type"] != "http.request": raise Refused()
                        raw.extend(message.get("body", b""))
                        if len(raw) > maximum: raise Refused()
                        if not message.get("more_body", False): break
                if length is not None and int(length) != len(raw): raise Refused()
                if route == ("POST", "/key/unblock"): native_unblock_key_hash(bytes(raw))
                elif route[0] == "POST": native_lookup_key_hash(bytes(raw))
                consumed = False
                async def replay_lookup():
                    nonlocal consumed
                    if not consumed:
                        consumed = True
                        return {"type": "http.request", "body": bytes(raw), "more_body": False}
                    return await receive()
                native_invoked = True
                await self.native(scope, replay_lookup, outward_send)
                return
            if scope.get("query_string"): raise Refused()
            if route in CONTROL_ROUTES:
                native_invoked = True
                await self.native(scope, receive, outward_send)
                return
            if route[0] != "POST" or route[1] not in MODEL_ROUTES: raise Refused()
            diagnostic = begin_model_request_diagnostic()
            runtime.check_runtime()
            update_model_request_diagnostic(diagnostic, "headers")
            headers = {}
            allowed_headers = {b"host", b"connection", b"content-type", b"content-length", b"authorization", b"x-api-key", b"x-lares-budget-intent", b"anthropic-version", b"accept", b"accept-encoding", b"accept-language", b"sec-fetch-mode", b"user-agent"}
            unknown_header_count = duplicate_header_count = 0
            for name, value in scope["headers"]:
                name = name.lower()
                if name in headers:
                    duplicate_header_count = min(31, duplicate_header_count + 1)
                    update_model_request_diagnostic(diagnostic, "headers", duplicate_header_count=duplicate_header_count)
                    raise Refused()
                if name not in allowed_headers:
                    unknown_header_count = min(31, unknown_header_count + 1)
                    update_model_request_diagnostic(diagnostic, "headers", unknown_header_count=unknown_header_count,
                        checks={"anthropicBetaPresent": name == b"anthropic-beta"})
                    raise Refused()
                headers[name] = value.decode("ascii")
            if diagnostic is not None:
                update_model_request_diagnostic(diagnostic, "headers", checks={"anthropicBetaPresent": b"anthropic-beta" in headers,
                    "authorizationPresent": b"authorization" in headers, "apiKeyPresent": b"x-api-key" in headers,
                    "ticketPresent": b"x-lares-budget-intent" in headers,
                    "contentTypeJson": headers.get(b"content-type", "").split(";")[0] == "application/json"})
            if headers.get(b"content-type", "").split(";")[0] != "application/json" or b"content-encoding" in headers: raise Refused()
            auth = headers.get(b"authorization", "")
            credential = auth[7:] if auth.startswith("Bearer ") else headers.get(b"x-api-key", "")
            if not credential or (headers.get(b"x-api-key") and headers[b"x-api-key"] != credential): raise Refused()
            ticket = headers.get(b"x-lares-budget-intent", "")
            if not TICKET.fullmatch(ticket): raise Refused()
            raw = bytearray()
            ingress_started = time.monotonic()
            update_model_request_diagnostic(diagnostic, "body")
            async with asyncio.timeout(2):
                while True:
                    message = await receive()
                    if message["type"] != "http.request": raise Refused()
                    raw.extend(message.get("body", b""))
                    if len(raw) > runtime.profile.document["maxBodyBytes"]: raise Refused()
                    if not message.get("more_body", False): break
            diagnostic_checks = {}
            unknown_body_field_count = 0
            if diagnostic is not None:
                diagnostic_checks, unknown_body_field_count = model_request_shape_checks(bytes(raw), runtime.profile, headers, route[1])
                update_model_request_diagnostic(diagnostic, "profile", checks=diagnostic_checks, unknown_body_field_count=unknown_body_field_count)
            runtime.profile.check_body(route[1], bytes(raw))
            update_model_request_diagnostic(diagnostic, "native-dispatch", checks=diagnostic_checks,
                unknown_body_field_count=unknown_body_field_count)
            request = RequestState(*route, bytes(raw), runtime.endpoint, credential, now=ingress_started)
            request.ticket = ticket
            request.diagnostic = diagnostic
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
            native_response_started = False
            replaced_refusal = False
            async def native_send(message):
                nonlocal native_response_started, replaced_refusal
                if message["type"] == "http.response.start":
                    update_model_request_diagnostic(diagnostic, "native-response", status_code=message.get("status", 0),
                        checks={**diagnostic_checks, "physicalDispatchObserved": request.dispatched,
                            "nativeAuthoredRefusal": request._authored_refusal})
                    if (request._authored_refusal and not request.dispatched and not native_response_started):
                        replaced_refusal = True
                        native_response_started = True
                        await outward_send({"type": "http.response.start", "status": 400, "headers": [(b"content-type", b"application/json")]})
                        await outward_send({"type": "http.response.body", "body": canonical({"error": {"type": ADMISSION_REFUSED_TYPE, "code": ADMISSION_REFUSED_TYPE, "message": ADMISSION_REFUSED_TEXT}})})
                        return
                    native_response_started = True
                if replaced_refusal: return
                await outward_send(message)
            native_invoked = True
            await self.native(native_scope, replay, native_send)
        except (Refused, TimeoutError, UnicodeError):
            if outward_response_started: raise
            if request is None and native_invoked: raise
            if request is not None and (request.dispatched or not request._authored_refusal): raise
            update_model_request_diagnostic(diagnostic, diagnostic.get("stage", "runtime-check") if diagnostic else "runtime-check",
                status_code=400)
            await outward_send({"type": "http.response.start", "status": 400, "headers": [(b"content-type", b"application/json")]})
            await outward_send({"type": "http.response.body", "body": canonical({"error": {"type": ADMISSION_REFUSED_TYPE, "code": ADMISSION_REFUSED_TYPE, "message": ADMISSION_REFUSED_TEXT}})})
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
    record_startup_diagnostic("process-starting")
    reset_model_request_diagnostic()
    phase = "preflight-failed"
    try:
        runtime = Runtime()
        record_startup_diagnostic("preflight-passed")
        if "--check" in sys.argv:
            print("lares: gateway admission preflight passed")
            return
        phase = "native-app-import-failed"
        record_startup_diagnostic("native-app-import")
        from litellm.proxy.proxy_server import app
        import uvicorn
        phase = "asgi-server-failed"
        record_startup_diagnostic("asgi-server")
        uvicorn.run(GatewayApp(app), host="0.0.0.0", port=4000, workers=1, access_log=False)
    except Exception:
        record_startup_diagnostic(phase, runtime.validation_stage if runtime is not None else "not-started")
        print("lares: gateway admission configuration is missing or invalid", file=sys.stderr)
        raise SystemExit(78) from None


if __name__ == "__main__":
    # The native config imports this exact module instance, sharing the ContextVar.
    sys.modules["lares_gateway"] = sys.modules[__name__]
    main()
