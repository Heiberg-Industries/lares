"""Versioned gateway wire contract; no provider calls, credentials or prices in logs.

This adapter does not provision accounts or implement the admission authority. A missing
authority is a refusal. The raw-byte hash is shared with the eventual runtime caller.
"""
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import stat
import time
from dataclasses import dataclass, field
from types import MappingProxyType
from urllib.parse import urlsplit

VERSION = 1
ADMISSION_REFUSED_TYPE = "budget_admission_refused"
ADMISSION_REFUSED_TEXT = "I could not verify permission to spend. Please check the gateway setup."
# A spending-limit refusal carries one of exactly two sentences, written by the keeper. The gateway repeats one only
# when it matches these shapes; the installation sentence has no digits except the date and never an amount.
_LIMIT_DATE = r"[1-9][0-9]? (?:January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{4}"
MEMBER_LIMIT_TEXT = re.compile(r"You've reached your monthly limit of \$[0-9]{1,18}(?:\.[0-9]{2,18})?\. It resets on " + _LIMIT_DATE + r"\.")
INSTALLATION_LIMIT_TEXT = re.compile(r"This installation has reached its monthly spending limit\. It resets on " + _LIMIT_DATE + r"\.")
DENIED_REASONS = {"member-limit": MEMBER_LIMIT_TEXT, "installation-limit": INSTALLATION_LIMIT_TEXT}
ADMIT_PATH = "/v1/gateway-budget/admit"
SETTLE_PATH = "/v1/gateway-budget/settle"
REQUEST_LIFETIME = 5.0
RPC_TIMEOUT = 3.0
MAX_RPC_BYTES = 8192
MAX_RESPONSE_BYTES = 1_048_576
# An embeddings reply carries up to 32 vectors of floats, which is far larger than a chat reply.
MAX_EMBEDDING_RESPONSE_BYTES = 4 * 1_048_576
PHYSICAL_HEADER_SECONDS = 30
PHYSICAL_BODY_SECONDS = 120
TERMINAL_TAIL_SECONDS = 2
CLEANUP_SECONDS = 2
NATIVE_POLICY_SECONDS = PHYSICAL_HEADER_SECONDS + 5
EMBEDDINGS_PATH = "/v1/embeddings"
# An agent's own provider key lives as a root-only file in this read-only directory, named by the revision id the keeper selects.
PROVIDER_KEY_DIRECTORY = "/run/lares/provider-keys"
INSTALLATION_KEY = "installation"
PROVIDER_KEY_MAX_BYTES = 4096
KEY_REVISION = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
MODEL_ROUTES = frozenset(("/v1/messages", "/v1/chat/completions", EMBEDDINGS_PATH))
NATIVE_MODEL_ROUTE_GROUP = "llm_api_routes"
# Every forwarded route still executes LiteLLM's native authentication. /health is paid.
CONTROL_ROUTES = frozenset((
    ("GET", "/health/liveliness"), ("GET", "/health/readiness"),
    ("GET", "/v1/model/info"), ("GET", "/v1/models"), ("GET", "/key/info"),
    ("POST", "/key/generate"), ("POST", "/key/delete"), ("POST", "/key/update"),
    ("POST", "/team/new"), ("POST", "/team/member_add"),
    ("POST", "/team/member_delete"), ("POST", "/user/new"), ("POST", "/user/update"),
))
HASH = re.compile(r"[0-9a-f]{64}\Z")
TICKET = re.compile(r"[A-Za-z0-9_-]{43}\Z")
NATIVE_LOOKUP_ROUTES = frozenset((("POST", "/v2/key/info"), ("GET", "/team/info"), ("GET", "/key/list"), ("GET", "/user/info")))
NATIVE_MASTER_ROUTES = NATIVE_LOOKUP_ROUTES | frozenset((("POST", "/key/unblock"),))
NATIVE_LOOKUP_GET_QUERY = {"/team/info": "team_id", "/key/list": "user_id", "/user/info": "user_id"}
MAX_NATIVE_LOOKUP_BODY = 1024
OPAQUE_NATIVE_ID = re.compile(r"[A-Za-z0-9-]{1,80}\Z")


def valid_anthropic_safety_metadata(value, path, provider):
    """Accept only Eve's hashed user identifier on Anthropic's messages route."""
    if type(value) is not dict or path != "/v1/messages" or provider != "anthropic" or set(value) != {"user_id"}:
        return False
    user_id = value["user_id"]
    return type(user_id) is str and HASH.fullmatch(user_id) is not None


class Refused(Exception):
    """Deliberately carries no request, key, ticket, provider or response text."""
    def __init__(self): super().__init__("Gateway admission unavailable or refused")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def parse_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise Refused()
            result[key] = value
        return result
    try:
        def finite(number):
            value = float(number)
            if not math.isfinite(value): raise Refused()
            return value
        value = json.loads(raw, object_pairs_hook=pairs, parse_float=finite, parse_constant=lambda _: (_ for _ in ()).throw(Refused()))
        if not isinstance(value, dict): raise Refused()
        return value
    except (ValueError, UnicodeError, RecursionError): raise Refused() from None


def native_lookup_query(path, query_string):
    """Accept only the two exact native lookup query shapes; never decode aliases."""
    name = NATIVE_LOOKUP_GET_QUERY.get(path)
    if name is None or not isinstance(query_string, bytes): raise Refused()
    match = re.fullmatch(name.encode("ascii") + rb"=([A-Za-z0-9-]{1,80})", query_string)
    if match is None: raise Refused()
    value = match.group(1).decode("ascii")
    if not OPAQUE_NATIVE_ID.fullmatch(value): raise Refused()
    return value


def native_lookup_key_hash(raw):
    """Require one bounded, exact hash lookup document with no extra authority."""
    if not isinstance(raw, bytes) or len(raw) > MAX_NATIVE_LOOKUP_BODY: raise Refused()
    body = parse_json(raw)
    keys = body.get("keys")
    if set(body) != {"keys"} or not isinstance(keys, list) or len(keys) != 1 or not isinstance(keys[0], str) or not HASH.fullmatch(keys[0]):
        raise Refused()
    return keys[0]


def native_unblock_key_hash(raw):
    """Require one bounded unblock document containing only a lowercase key fingerprint."""
    if not isinstance(raw, bytes) or len(raw) > MAX_NATIVE_LOOKUP_BODY: raise Refused()
    body = parse_json(raw)
    key = body.get("key")
    if set(body) != {"key"} or not isinstance(key, str) or not HASH.fullmatch(key): raise Refused()
    return key


def native_route_allowed(allowed_routes, path):
    """Match the native model-route group without widening gateway route access."""
    if path not in MODEL_ROUTES or not isinstance(allowed_routes, list) or not allowed_routes:
        return False
    if any(type(route) is not str or route not in MODEL_ROUTES | {NATIVE_MODEL_ROUTE_GROUP} for route in allowed_routes):
        return False
    if len(set(allowed_routes)) != len(allowed_routes):
        return False
    if NATIVE_MODEL_ROUTE_GROUP in allowed_routes:
        return allowed_routes == [NATIVE_MODEL_ROUTE_GROUP]
    return path in allowed_routes


def request_hash(method, path, raw):
    return hashlib.sha256(b"lares.gateway.raw-request.v1\0" + method.encode("ascii") + b"\0" + path.encode("ascii") + b"\0" + raw).hexdigest()


def sign(key, direction, method, path, raw):
    envelope = canonical(["lares.gateway.rpc.v1", direction, method, path, hashlib.sha256(raw).hexdigest()])
    return hmac.new(key, envelope, hashlib.sha256).hexdigest()


def verify(key, signature, direction, method, path, raw):
    return isinstance(signature, str) and HASH.fullmatch(signature) is not None and hmac.compare_digest(signature, sign(key, direction, method, path, raw))


def https_url(value):
    try:
        url = urlsplit(value)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise Refused()
        if url.port is not None and not 1 <= url.port <= 65535: raise Refused()
        return value.rstrip("/")
    except (ValueError, TypeError): raise Refused() from None


def protected_key(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o027: raise Refused()
            key = source.read(33)
            if len(key) != 32: raise Refused()
            return key
    except (OSError, TypeError): raise Refused() from None


def read_provider_key(selector, directory=None, owner=0):
    """Read the agent's key file once. Anything unexpected is a refusal: there is no fallback to the installation key."""
    if not isinstance(selector, str) or KEY_REVISION.fullmatch(selector) is None: raise Refused()
    try:
        fd = os.open(os.path.join(directory or PROVIDER_KEY_DIRECTORY, selector), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != owner or info.st_mode & 0o077: raise Refused()
            if not 1 <= info.st_size <= PROVIDER_KEY_MAX_BYTES + 1: raise Refused()
            data = source.read(PROVIDER_KEY_MAX_BYTES + 2)
    except OSError: raise Refused() from None
    if data.endswith(b"\n"): data = data[:-1]
    # One printable-ASCII token: it goes into an HTTP header and must be exactly what the keeper wrote.
    if not 1 <= len(data) <= PROVIDER_KEY_MAX_BYTES or re.fullmatch(rb"[\x21-\x7e]+", data) is None: raise Refused()
    return data.decode("ascii")


PROFILE_REQUIRED_KEYS = frozenset(("version", "provider", "model", "aliases", "providerBaseUrl", "maxBodyBytes", "maxOutputTokens"))
EMBEDDING_KEYS = frozenset(("alias", "provider", "model", "providerBaseUrl", "maxInputs", "maxInputTokens"))
EMBED_MAX_INPUTS = 32
MODEL_NAME = re.compile(r"[A-Za-z0-9_.:-]{1,160}\Z")
# The upstream path and the shape of the provider's usage, per provider. Every chat alias of one
# profile shares the provider, its address and its key; only the model can differ by alias.
CHAT_UPSTREAM = {"openai": ("/chat/completions", "openai"), "anthropic": ("/v1/messages", "anthropic")}


@dataclass(frozen=True)
class Route:
    """Where one served alias really goes. Nothing here is read from a request."""
    alias: str
    model: str
    litellm_model: str
    base: str
    key_env: str
    path: str
    format: str
    kind: str = "chat"


@dataclass(frozen=True)
class Profile:
    document: dict
    digest: str = field(init=False)

    def __post_init__(self):
        p = self.document
        # Two optional keys: purposeModels (a model of its own for the writer, utility or gate alias) and
        # embedding (a fifth alias, served over the embeddings wire with its own address and key).
        if not PROFILE_REQUIRED_KEYS <= set(p) <= PROFILE_REQUIRED_KEYS | {"purposeModels", "embedding"}: raise Refused()
        if type(p["version"]) is not int or p["version"] != VERSION or p["provider"] not in ("openai", "anthropic"): raise Refused()
        if not isinstance(p["model"], str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", p["model"]): raise Refused()
        aliases = p["aliases"]
        wanted = 5 if "embedding" in p else 4
        if not isinstance(aliases, list) or len(aliases) != wanted or len(set(aliases)) != wanted or any(not isinstance(a, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", a) for a in aliases): raise Refused()
        for name, maximum in (("maxBodyBytes", 1048576), ("maxOutputTokens", 1000000)):
            if type(p[name]) is not int or not 1 <= p[name] <= maximum: raise Refused()
        https_url(p["providerBaseUrl"])
        embedding = p.get("embedding")
        if "embedding" in p:
            # Absent is the default. Present describes the one embedding alias, which is always the fifth.
            if type(embedding) is not dict or set(embedding) != EMBEDDING_KEYS: raise Refused()
            if embedding["alias"] != aliases[4] or embedding["provider"] != "openai": raise Refused()
            if not isinstance(embedding["model"], str) or not MODEL_NAME.fullmatch(embedding["model"]): raise Refused()
            if not isinstance(embedding["providerBaseUrl"], str) or https_url(embedding["providerBaseUrl"]) != embedding["providerBaseUrl"]: raise Refused()
            if type(embedding["maxInputs"]) is not int or embedding["maxInputs"] != EMBED_MAX_INPUTS: raise Refused()
            if type(embedding["maxInputTokens"]) is not int or not 1 <= embedding["maxInputTokens"] <= 1_000_000: raise Refused()
        purpose_models = p.get("purposeModels")
        if "purposeModels" in p:
            # Absent is the default. Present means at least one alias really differs from the brain model.
            if type(purpose_models) is not dict or not purpose_models: raise Refused()
            for alias, own in purpose_models.items():
                if alias not in aliases[1:4] or type(own) is not str or not MODEL_NAME.fullmatch(own) or own == p["model"]: raise Refused()
        object.__setattr__(self, "digest", hashlib.sha256(canonical(p)).hexdigest())
        document = {**p, "aliases": tuple(aliases)}
        if purpose_models is not None: document["purposeModels"] = MappingProxyType(dict(purpose_models))
        if embedding is not None: document["embedding"] = MappingProxyType(dict(embedding))
        object.__setattr__(self, "document", MappingProxyType(document))

    def route(self, alias):
        p = self.document
        if alias not in p["aliases"]: raise Refused()
        embedding = p.get("embedding")
        if embedding is not None and alias == embedding["alias"]:
            return Route(alias, embedding["model"], "openai/" + embedding["model"], embedding["providerBaseUrl"], "LARES_EMBED_PROVIDER_KEY", "/embeddings", "embedding", "embedding")
        model = p.get("purposeModels", {}).get(alias, p["model"])
        path, wire = CHAT_UPSTREAM[p["provider"]]
        return Route(alias, model, p["provider"] + "/" + model, p["providerBaseUrl"], "LARES_MODEL_PROVIDER_KEY", path, wire)

    def chat_aliases(self):
        """The aliases a chat route may name. The embedding alias is never one of them."""
        embedding = self.document.get("embedding")
        return [a for a in self.document["aliases"] if embedding is None or a != embedding["alias"]]

    def check_embedding_body(self, raw):
        """The only embeddings request that is admitted: model, string inputs, and float encoding. Nothing else."""
        p = self.document
        embedding = p.get("embedding")
        if embedding is None or len(raw) > p["maxBodyBytes"]: raise Refused()
        body = parse_json(raw)
        if set(body) != {"model", "input", "encoding_format"} or body["model"] != embedding["alias"] or body["encoding_format"] != "float": raise Refused()
        inputs = body["input"]
        if not isinstance(inputs, list) or not 1 <= len(inputs) <= embedding["maxInputs"]: raise Refused()
        if any(not isinstance(item, str) or not item for item in inputs): raise Refused()
        return body

    def check_body(self, path, raw):
        p = self.document
        if path == EMBEDDINGS_PATH: return self.check_embedding_body(raw)
        if path not in MODEL_ROUTES or len(raw) > p["maxBodyBytes"]: raise Refused()
        body = parse_json(raw)
        allowed = {"model", "messages", "max_tokens", "max_completion_tokens", "stream", "stream_options", "temperature", "top_p", "stop", "stop_sequences", "system", "tools", "tool_choice", "parallel_tool_calls", "thinking", "metadata"}
        if set(body) - allowed or body.get("model") not in self.chat_aliases(): raise Refused()
        if "metadata" in body:
            if not valid_anthropic_safety_metadata(body["metadata"], path, p["provider"]): raise Refused()
        if not isinstance(body.get("messages"), list) or not body["messages"]: raise Refused()
        if "max_tokens" in body and "max_completion_tokens" in body: raise Refused()
        maximum = body.get("max_tokens", body.get("max_completion_tokens"))
        if type(maximum) is not int or not 1 <= maximum <= p["maxOutputTokens"]: raise Refused()
        if type(body.get("stream", False)) is not bool: raise Refused()
        if "stream_options" in body and body["stream_options"] != {"include_usage": True}: raise Refused()
        def cache(value):
            if value not in (None, {"type": "ephemeral"}, {"type": "ephemeral", "ttl": "5m"}): raise Refused()
        def content(value, tools=True):
            if isinstance(value, str) or value is None: return
            if not isinstance(value, list): raise Refused()
            for block in value:
                if not isinstance(block, dict): raise Refused()
                kind = block.get("type")
                fields = {
                    "text": {"type", "text", "cache_control"},
                    # A provider's own tool call carries caller; only a direct call may come back.
                    "tool_use": {"type", "id", "name", "input", "caller", "cache_control"},
                    "tool_result": {"type", "tool_use_id", "content", "is_error", "cache_control"},
                    "thinking": {"type", "thinking", "signature"},
                    "redacted_thinking": {"type", "data"},
                }.get(kind)
                if fields is None or set(block) - fields or (not tools and kind != "text"): raise Refused()
                if path == "/v1/chat/completions" and kind != "text": raise Refused()
                cache(block.get("cache_control"))
                if kind == "text" and not isinstance(block.get("text"), str): raise Refused()
                if kind == "tool_use" and block.get("caller", {"type": "direct"}) != {"type": "direct"}: raise Refused()
                if kind == "tool_result": content(block.get("content"), tools=False)
        content(body.get("system"), tools=False)
        for message in body["messages"]:
            if not isinstance(message, dict) or set(message) - {"role", "content", "tool_calls", "tool_call_id", "name"}: raise Refused()
            if message.get("role") not in ("user", "assistant", "system", "developer", "tool"): raise Refused()
            content(message.get("content"))
            calls = message.get("tool_calls", [])
            if not isinstance(calls, list): raise Refused()
            for call in calls:
                if not isinstance(call, dict) or set(call) - {"id", "type", "function"} or call.get("type") != "function": raise Refused()
        thinking = body.get("thinking")
        if thinking is not None:
            if not isinstance(thinking, dict) or set(thinking) != {"type", "budget_tokens"} or thinking["type"] != "enabled" or type(thinking["budget_tokens"]) is not int or not 1 <= thinking["budget_tokens"] < maximum: raise Refused()
        # Definitions of client-executed tools are allowed; provider-hosted tools are not.
        tools = body.get("tools", [])
        if not isinstance(tools, list): raise Refused()
        for tool in tools:
            if not isinstance(tool, dict): raise Refused()
            kind = tool.get("type")
            if path == "/v1/chat/completions" and kind != "function": raise Refused()
            if path == "/v1/messages" and kind not in (None, "custom"): raise Refused()
            allowed = {"type", "function"} if path == "/v1/chat/completions" else {"type", "name", "description", "input_schema", "cache_control", "eager_input_streaming"}
            if set(tool) - allowed: raise Refused()
            if "eager_input_streaming" in tool and (path != "/v1/messages" or type(tool["eager_input_streaming"]) is not bool): raise Refused()
            cache(tool.get("cache_control"))
        return body

    def expected_config(self):
        p = self.document
        return {
            "model_list": [{"model_name": route.alias, "litellm_params": {"model": route.litellm_model, "api_key": "os.environ/" + route.key_env, "api_base": route.base, "max_retries": 0, "num_retries": 0}} for route in map(self.route, p["aliases"])],
            "litellm_settings": {"telemetry": False, "callbacks": ["lares_gateway.gateway_hook"], "disable_aiohttp_transport": True, "drop_params": False, "use_chat_completions_url_for_anthropic_messages": True},
            "router_settings": {"num_retries": 0, "fallbacks": [], "context_window_fallbacks": [], "content_policy_fallbacks": []},
            "general_settings": {"master_key": "os.environ/LARES_GATEWAY_MASTER_KEY", "background_health_checks": False, "disable_auto_add_proxy_admin_to_teams": True},
        }

    def validate_config(self, config):
        general = config.get("general_settings") if isinstance(config, dict) else None
        if not isinstance(general, dict) or type(general.get("disable_auto_add_proxy_admin_to_teams")) is not bool or general["disable_auto_add_proxy_admin_to_teams"] is not True:
            raise Refused()
        if config != self.expected_config(): raise Refused()


class RequestState:
    def __init__(self, method, path, raw, endpoint_hash, credential, now=None):
        self.method, self.path, self.raw = method, path, raw
        self.request_hash = request_hash(method, path, raw)
        self.endpoint_hash = endpoint_hash
        self.key_fingerprint = hashlib.sha256(credential.encode()).hexdigest()
        self.nonce = secrets.token_hex(32)
        self.deadline = (time.monotonic() if now is None else now) + REQUEST_LIFETIME
        self.phase = "captured"
        self.dispatched = False
        self._authored_refusal = False
        self.pre_seen = False
        self.deployment_phases = []
        self.allow = None
        self.policy = None
        self.clients = []
        self.terminal = False
        self.closed = False
        self.cancelled = False
        self.wire_usage = None
        self.denial_text = None
        # Which key pays: INSTALLATION_KEY, or the revision id of the agent's own key file. The key itself is held here only.
        self.selector = INSTALLATION_KEY
        self.provider_key = None

    @property
    def refusal_message(self):
        """What a refused model call says: the keeper's validated limit sentence, else the fixed text."""
        return self.denial_text or ADMISSION_REFUSED_TEXT

    def fresh(self, now=None):
        if self.closed or self.terminal or (time.monotonic() if now is None else now) >= self.deadline: raise Refused()

    def arm(self, deadline):
        if self.closed or self.terminal or self.phase != "captured": raise Refused()
        self.deadline = min(self.deadline, deadline)
        self.phase = "armed"

    def burn(self, now=None):
        self.fresh(now)
        if self.phase != "armed" or self.dispatched: raise Refused()
        self.dispatched = True
        self.phase = "burned"

    def close(self):
        self.closed = True
        self.phase = "closed"
        self.provider_key = None

    def observation(self, profile, ticket, alias):
        return {"version": VERSION, "nonce": self.nonce, "ticket": ticket, "requestHash": self.request_hash, "profileHash": profile.digest, "endpointHash": self.endpoint_hash, "keyFingerprint": self.key_fingerprint, "purposeAlias": alias}

    def accept(self, request, reply, rpc_started):
        if isinstance(reply, dict) and reply.get("state") == "denied":
            self.deny(request, reply)
            raise Refused()
        keys = {"version", "state", "nonce", "requestHash", "profileHash", "endpointHash", "keyFingerprint", "purposeAlias", "attemptId", "bindingId", "providerKey", "validForMs"}
        if set(reply) != keys or reply["state"] != "allowed": raise Refused()
        if type(reply["version"]) is not int: raise Refused()
        for name in ("version", "nonce", "requestHash", "profileHash", "endpointHash", "keyFingerprint", "purposeAlias"):
            if reply[name] != request[name]: raise Refused()
        for name in ("attemptId", "bindingId"):
            if not isinstance(reply[name], str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", reply[name]): raise Refused()
        selector = reply["providerKey"]
        if not isinstance(selector, str) or (selector != INSTALLATION_KEY and KEY_REVISION.fullmatch(selector) is None): raise Refused()
        # Embeddings always use the installation's embedding key.
        if selector != INSTALLATION_KEY and self.path == EMBEDDINGS_PATH: raise Refused()
        if type(reply["validForMs"]) is not int or not 1 <= reply["validForMs"] <= RPC_TIMEOUT * 1000: raise Refused()
        self.selector = selector
        self.allow = reply
        self.arm(rpc_started + reply["validForMs"] / 1000)
        self.fresh()


    def load_provider_key(self, directory=None, owner=0):
        """After accept: read the selected key file once. A missing or unsafe file refuses; it never falls back."""
        if self.selector == INSTALLATION_KEY: return False
        self.provider_key = read_provider_key(self.selector, directory, owner)
        return True

    def credential(self, installation_key):
        """The key this request sends: the agent's when one is selected, else the installation's."""
        if self.selector == INSTALLATION_KEY: return installation_key
        if self.provider_key is None: raise Refused()
        return self.provider_key

    def check_credential(self, wire, headers, installation_key):
        """Called before the request is sent. With an agent key selected, the one auth header must carry exactly that key and
        no header may carry the installation's; the comparison is constant time. Nothing here is logged."""
        if self.selector == INSTALLATION_KEY: return
        if self.provider_key is None: raise Refused()
        name, want = ("x-api-key", self.provider_key) if wire == "anthropic" else ("authorization", "Bearer " + self.provider_key)
        found = [value for header, value in headers if header.lower() == name]
        if len(found) != 1 or not hmac.compare_digest(found[0].encode(), want.encode()): raise Refused()
        other = (installation_key or "").encode()
        if other and any(other in value.encode() for _, value in headers): raise Refused()

    def deny(self, request, reply):
        """Remember a signed limit sentence. Anything not exactly that shape leaves the fixed refusal text."""
        keys = {"version", "state", "reason", "message", "nonce", "requestHash", "profileHash", "endpointHash", "keyFingerprint", "purposeAlias"}
        if set(reply) != keys or type(reply["version"]) is not int: return
        for name in ("version", "nonce", "requestHash", "profileHash", "endpointHash", "keyFingerprint", "purposeAlias"):
            if reply[name] != request[name]: return
        grammar = DENIED_REASONS.get(reply["reason"]) if isinstance(reply["reason"], str) else None
        message = reply["message"]
        if grammar is None or not isinstance(message, str) or grammar.fullmatch(message) is None: return
        self.denial_text = message


class TerminalEvidence:
    """Only exact terminal provider evidence can reduce a reservation. Invalid usage
    poisons the whole receipt; partial/cancelled streams never call result()."""
    def __init__(self, path):
        self.path = path
        self.poisoned = False
        self.started = False
        self.stopped = False
        self.final_delta = False
        self.usage = None
        self.output = 0
        self.response_id = None

    @staticmethod
    def integer(value):
        if type(value) is not int or not 0 <= value <= 2**53-1: raise Refused()
        return value

    @classmethod
    def openai_usage(cls, usage):
        if not isinstance(usage, dict): raise Refused()
        input_tokens = cls.integer(usage.get("prompt_tokens"))
        output_tokens = cls.integer(usage.get("completion_tokens"))
        if cls.integer(usage.get("total_tokens")) != input_tokens + output_tokens: raise Refused()
        details = usage.get("prompt_tokens_details") or {}
        if not isinstance(details, dict): raise Refused()
        cached = cls.integer(details.get("cached_tokens", 0))
        if cached > input_tokens: raise Refused()
        return {"inputTokens":input_tokens,"outputTokens":output_tokens,"cacheReadTokens":cached,"cacheWriteTokens":0}

    @classmethod
    def anthropic_usage(cls, usage):
        if not isinstance(usage, dict): raise Refused()
        return {"inputTokens":cls.integer(usage.get("input_tokens")),"outputTokens":cls.integer(usage.get("output_tokens")),"cacheReadTokens":cls.integer(usage.get("cache_read_input_tokens",0)),"cacheWriteTokens":cls.integer(usage.get("cache_creation_input_tokens",0))}

    @classmethod
    def embedding_usage(cls, usage):
        """Embeddings are charged on input tokens only; any output or cache token is a refusal."""
        if not isinstance(usage, dict): raise Refused()
        prompt = cls.integer(usage.get("prompt_tokens"))
        completion = cls.integer(usage.get("completion_tokens", 0))
        if completion != 0 or cls.integer(usage.get("total_tokens")) != prompt + completion: raise Refused()
        return {"inputTokens":prompt,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}

    @staticmethod
    def stop_reason(value, anthropic=False):
        permitted = {"end_turn","max_tokens","stop_sequence","tool_use","pause_turn","refusal"} if anthropic else {"stop","length","tool_calls","content_filter","function_call"}
        return isinstance(value, str) and value in permitted

    def nonstream(self, response):
        try:
            if not isinstance(response, dict): raise Refused()
            if self.path == EMBEDDINGS_PATH:
                # The provider's reply carries no stop reason and, for some providers, no id.
                data = response.get("data")
                if response.get("object") != "list" or not isinstance(data, list) or not data: raise Refused()
                for index, item in enumerate(data):
                    if not isinstance(item, dict) or item.get("object") != "embedding" or type(item.get("index")) is not int or item["index"] != index: raise Refused()
                return self.embedding_usage(response.get("usage"))
            if not isinstance(response.get("id"), str) or not response["id"]: raise Refused()
            if self.path == "/v1/messages":
                if response.get("type") != "message" or response.get("role") != "assistant" or not self.stop_reason(response.get("stop_reason"), True): raise Refused()
                return self.anthropic_usage(response.get("usage"))
            choices = response.get("choices")
            if response.get("object") != "chat.completion" or not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict) or choices[0].get("index") != 0 or not self.stop_reason(choices[0].get("finish_reason")): raise Refused()
            return self.openai_usage(response.get("usage"))
        except Refused: return None

    def feed(self, document):
        try:
            if self.poisoned or not isinstance(document, dict) or "error" in document: raise Refused()
            if self.path == "/v1/messages":
                kind = document.get("type")
                if self.stopped: raise Refused()
                if kind == "message_start":
                    if self.started: raise Refused()
                    message = document.get("message")
                    if not isinstance(message, dict): raise Refused()
                    if not isinstance(message.get("id"), str) or not message["id"]: raise Refused()
                    self.response_id = message["id"]
                    self.usage = self.anthropic_usage(message.get("usage"))
                    self.output = self.usage["outputTokens"]
                    self.started = True
                elif kind == "message_delta":
                    if not self.started or self.final_delta: raise Refused()
                    delta, usage = document.get("delta"), document.get("usage")
                    if not isinstance(delta, dict) or not isinstance(usage, dict): raise Refused()
                    output = self.integer(usage.get("output_tokens"))
                    if output < self.output: raise Refused()
                    self.output = output
                    if delta.get("stop_reason") is not None:
                        if not self.stop_reason(delta["stop_reason"], True): raise Refused()
                        self.final_delta = True
                        self.usage["outputTokens"] = output
                elif kind == "message_stop":
                    if not self.started or not self.final_delta: raise Refused()
                    self.stopped = True
                elif kind not in ("content_block_start","content_block_delta","content_block_stop","ping") or self.final_delta or not self.started:
                    raise Refused()
            else:
                choices = document.get("choices")
                if not isinstance(choices, list) or len(choices) > 1: raise Refused()
                identity = document.get("id")
                if not isinstance(identity, str) or not identity: raise Refused()
                if self.response_id is None: self.response_id = identity
                elif identity != self.response_id: raise Refused()
                if self.stopped and choices: raise Refused()
                for choice in choices:
                    if not isinstance(choice, dict): raise Refused()
                    if choice.get("index") != 0: raise Refused()
                    reason = choice.get("finish_reason")
                    if reason is not None:
                        if self.stopped or not self.stop_reason(reason): raise Refused()
                        self.stopped = True
                if document.get("usage") is not None:
                    if not self.stopped or self.usage is not None: raise Refused()
                    self.usage = self.openai_usage(document["usage"])
        except Refused: self.poisoned = True

    def result(self):
        return self.usage if self.stopped and not self.poisoned else None


class WireEvidence:
    """Bounded transient parsing of the ACTUAL provider bytes, before SDKs can fill
    missing usage. No content leaves this object or enters a receipt/log."""
    def __init__(self, wire, content_type, status):
        # `wire` is the route's usage format: "openai", "anthropic" or "embedding".
        self.path = "/v1/messages" if wire == "anthropic" else EMBEDDINGS_PATH if wire == "embedding" else "/v1/chat/completions"
        self.limit = MAX_EMBEDDING_RESPONSE_BYTES if wire == "embedding" else MAX_RESPONSE_BYTES
        self.sse = content_type.split(";")[0].strip() == "text/event-stream"
        self.poisoned = status != 200 or content_type.split(";")[0].strip() not in ("application/json", "text/event-stream") or (wire == "embedding" and self.sse)
        self.buffer = b""
        self.total = 0
        self.done = False
        self.events = TerminalEvidence(self.path)

    def feed(self, raw):
        if self.poisoned: return
        self.total += len(raw)
        if self.total > self.limit:
            self.poisoned = True; self.buffer = b""; return
        self.buffer += raw
        if not self.sse: return
        self.buffer = self.buffer.replace(b"\r\n", b"\n")
        try:
            while b"\n\n" in self.buffer:
                event, self.buffer = self.buffer.split(b"\n\n", 1)
                lines = [line[5:].lstrip() for line in event.split(b"\n") if line.startswith(b"data:")]
                if not lines: continue # keepalive comments are not usage
                if self.done: raise Refused()
                payload = b"\n".join(lines)
                if payload == b"[DONE]":
                    if self.path != "/v1/chat/completions" or self.events.result() is None: raise Refused()
                    self.done = True
                else:
                    document = parse_json(payload)
                    self.events.feed(document)
                    if self.events.poisoned: raise Refused()
        except Refused:
            self.poisoned = True; self.buffer = b""

    def finish(self):
        if self.poisoned: return None
        if self.sse:
            if self.buffer.strip() or (self.path == "/v1/chat/completions" and not self.done): return None
            return self.events.result()
        try: return self.events.nonstream(parse_json(self.buffer))
        except Refused: return None
