"""Offline tests. Native LiteLLM/client compatibility is proved separately in CI."""
import asyncio
import importlib.util
import json
import pathlib
import unittest
from unittest import mock
import ast
import io
import gzip
import http.server
import threading
import time
import uuid
import hashlib
import subprocess
import tempfile
import os
import base64
import tarfile
import types

ROOT = pathlib.Path(__file__).resolve().parents[3]
import sys
sys.path.insert(0, str(ROOT / "images/gateway-runtime"))
from admission_contract import RequestState, Refused, request_hash, sign, verify, parse_json, Profile, TerminalEvidence, WireEvidence, MAX_RESPONSE_BYTES


class ContractTests(unittest.TestCase):
    def test_raw_bytes_and_route_are_bound(self):
        a = request_hash("POST", "/v1/messages", b'{"a":1}')
        self.assertNotEqual(a, request_hash("POST", "/v1/messages", b'{ "a":1}'))
        self.assertNotEqual(a, request_hash("POST", "/v1/chat/completions", b'{"a":1}'))

    def test_signature_separates_request_response_and_exact_bytes(self):
        key = bytes(range(32))
        signature = sign(key, "request", "POST", "/v1/admit", b'{}')
        self.assertTrue(verify(key, signature, "request", "POST", "/v1/admit", b'{}'))
        for direction, path, body in [("response", "/v1/admit", b'{}'), ("request", "/v1/settle", b'{}'), ("request", "/v1/admit", b'{ }')]:
            self.assertFalse(verify(key, signature, direction, "POST", path, body))

    def test_duplicate_json_fields_and_nonfinite_numbers_refuse(self):
        for body in [b'{"model":"a","model":"b"}', b'{"n":NaN}', b'{"n":1e999}', b'[]']:
            with self.assertRaises(Refused): parse_json(body)

    def test_expiry_and_dispatch_are_forward_only(self):
        state = RequestState("POST", "/v1/messages", b'{}', "a" * 64, "sk-fixture", now=10)
        state.arm(12)
        state.burn(now=11)
        for now in [11, 20]:
            with self.assertRaises(Refused): state.burn(now=now)
        late = RequestState("POST", "/v1/messages", b'{}', "a" * 64, "sk-fixture", now=10)
        late.arm(11)
        with self.assertRaises(Refused): late.burn(now=11)
        with self.assertRaises(Refused): late.arm(20)

    def test_requests_do_not_share_a_right(self):
        a = RequestState("POST", "/v1/messages", b'{}', "a" * 64, "sk-fixture", now=10)
        b = RequestState("POST", "/v1/messages", b'{}', "a" * 64, "sk-fixture", now=10)
        self.assertNotEqual(a.nonce, b.nonce)
        a.arm(12); b.arm(12); a.burn(now=11); b.burn(now=11)

    def test_closed_state_cannot_be_rearmed_by_a_child_context(self):
        state = RequestState("POST", "/v1/messages", b'{}', "a" * 64, "sk-fixture", now=10)
        state.arm(12); state.close()
        with self.assertRaises(Refused): state.burn(now=11)
        with self.assertRaises(Refused): state.arm(20)

    def test_profile_refuses_unbounded_or_override_requests(self):
        profile = Profile({"version":1,"provider":"openai","model":"gpt-4o-mini","providerBaseUrl":"https://provider.example.invalid/v1","aliases":["lares-brain","lares-writer","lares-utility","lares-gate"],"maxBodyBytes":4096,"maxOutputTokens":123})
        body = {"model":"lares-brain","messages":[{"role":"user","content":"hello"}],"max_tokens":123}
        self.assertEqual(profile.check_body("/v1/messages", json.dumps(body).encode()), body)
        for extra in [{"max_tokens":124},{"api_base":"https://elsewhere.invalid"},{"num_retries":2},{"metadata":{"user_id":"spoof"}},{"n":2},{"rust":True},{"user_config":{}}]:
            with self.assertRaises(Refused): profile.check_body("/v1/messages", json.dumps({**body,**extra}).encode())
        for content in [[{"type":"image_url","image_url":{"url":"https://outside.invalid/picture"}}], [{"type":"document","source":{"type":"url","url":"https://outside.invalid"}}]]:
            with self.assertRaises(Refused): profile.check_body("/v1/messages", json.dumps({**body,"messages":[{"role":"user","content":content}]}).encode())
        with self.assertRaises(TypeError): profile.document["maxOutputTokens"] = 999
        with self.assertRaises(TypeError): profile.document["aliases"][0] = "changed"

    def test_only_exact_terminal_anthropic_stream_settles(self):
        start = {"type":"message_start","message":{"id":"msg_fixture","usage":{"input_tokens":12,"output_tokens":0,"cache_read_input_tokens":0}}}
        delta = {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}
        stop = {"type":"message_stop"}
        good = TerminalEvidence("/v1/messages")
        for chunk in [start,delta,stop]: good.feed(chunk)
        self.assertEqual(good.result()["outputTokens"], 4)
        for chunks in [[start,stop],[start,delta],[start,{**delta,"usage":{}},stop],[start,{**delta,"usage":{"output_tokens":-1}},stop],[start,delta,{**delta,"usage":{"output_tokens":3}},stop],[start,delta,{"error":{}},stop]]:
            evidence = TerminalEvidence("/v1/messages")
            for chunk in chunks: evidence.feed(chunk)
            self.assertIsNone(evidence.result())


class NativeCallbackTests(unittest.TestCase):
    """Adapter enforcement with offline stand-ins, never a native compatibility claim."""
    names = ("callbacks", "input_callback", "_async_input_callback", "success_callback", "failure_callback",
             "_async_success_callback", "_async_failure_callback", "service_callback", "audit_log_callbacks")

    def setUp(self):
        source = ast.parse((ROOT / "images/gateway-runtime/lares_gateway.py").read_text())
        runtime_class = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == "Runtime")
        self.litellm = types.ModuleType("litellm")
        for name in self.names: setattr(self.litellm, name, [])
        self.Budget = type("NativeModelBudget", (), {})
        self.DBLogger = type("NativeDBLogger", (), {})
        self.Service = type("NativeService", (), {})
        self.Hook = type("NativeProxyHook", (), {})
        self.Gateway = type("GatewayHook", (), {})
        self.Shadow = type("ShadowEvalLogger", (), {"async_log_success_event": mock.Mock(side_effect=AssertionError("shadow ran"))})
        class Router:
            def sync_deployment_callback_on_success(self): pass
            async def deployment_callback_on_success(self): pass
            def deployment_callback_on_failure(self): pass
            async def async_deployment_callback_on_failure(self): pass
        self.Router = Router
        self.router = Router()
        self.gateway, self.budget, self.service, self.hook = self.Gateway(), self.Budget(), self.Service(), self.Hook()
        self.db, self.async_db = self.DBLogger(), self.DBLogger()
        self.proxy = types.SimpleNamespace(llm_router=self.router, model_max_budget_limiter=self.budget,
            proxy_logging_obj=types.SimpleNamespace(service_logging_obj=self.service, proxy_hook_mapping={"max_budget_limiter": self.hook}))
        modules = {"litellm": self.litellm}
        def module(name, **values):
            item = types.ModuleType(name);item.__dict__.update(values);modules[name] = item
        self.litellm.Router = Router
        module("litellm.proxy", proxy_server=self.proxy)
        module("litellm.rust_bridge.configuration", rust_enabled=lambda: False)
        self.litellm.cache = None
        self.litellm.disable_aiohttp_transport = self.litellm.use_chat_completions_url_for_anthropic_messages = True
        self.proxy.store_model_in_db, self.proxy.user_custom_auth = False, None
        module("litellm.proxy.hooks", PROXY_HOOKS={"max_budget_limiter": self.Hook}, get_proxy_hook=lambda name: self.Hook)
        module("litellm.proxy.hooks.model_max_budget_limiter", _PROXY_VirtualKeyModelMaxBudgetLimiter=self.Budget)
        module("litellm.proxy.hooks.proxy_track_cost_callback", _ProxyDBLogger=self.DBLogger)
        module("litellm.integrations.shadow_eval_logger", ShadowEvalLogger=self.Shadow)
        module("litellm._service_logger", ServiceLogging=self.Service)
        self.modules = mock.patch.dict(sys.modules, modules);self.modules.start();self.addCleanup(self.modules.stop)
        namespace = {"litellm": self.litellm, "gateway_hook": self.gateway, "Refused": Refused, "os": os}
        diagnostics = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "callback_startup_checks")
        exec(compile(ast.Module(body=[diagnostics, runtime_class], type_ignores=[]), "adapter-runtime", "exec"), namespace)
        self.callback_checks = namespace["callback_startup_checks"]
        self.runtime = namespace["Runtime"].__new__(namespace["Runtime"])
        self.runtime.callback_ids = self.runtime.secondary_callback_ids = self.runtime.callback_references = None
        self.runtime.profile = types.SimpleNamespace(document={"aliases": ["lares-brain"], "provider": "openai", "model": "fixture", "providerBaseUrl": "https://provider.example.invalid/v1"})
        self.router.model_names, self.router.default_deployment = ["lares-brain"], None
        self.router.get_model_list = lambda **kwargs: [{"litellm_params": {"model": "openai/fixture", "api_base": "https://provider.example.invalid/v1", "num_retries": 0, "max_retries": 0}}]
        self.litellm.callbacks[:] = [self.budget, self.gateway, self.db, self.hook, self.service]
        self.litellm.success_callback[:] = [self.router.sync_deployment_callback_on_success, *self.litellm.callbacks]
        self.litellm.failure_callback[:] = [self.router.deployment_callback_on_failure, *self.litellm.callbacks]
        self.litellm._async_success_callback[:] = [self.router.deployment_callback_on_success, self.async_db]
        self.litellm._async_failure_callback[:] = [self.router.async_deployment_callback_on_failure]

    def check(self, startup=False): self.runtime.check_callbacks(self.proxy, startup)

    def test_pinned_native_objects_and_lazy_primary_promotions_remain_valid(self):
        self.runtime.check_runtime(startup=True)
        original = self.runtime.callback_ids
        # function_setup promotes these same primary objects after startup. Native
        # class deduplication preserves cost_tracking's separate async DB logger.
        self.litellm.input_callback.extend(self.litellm.callbacks)
        self.litellm._async_success_callback.extend(c for c in self.litellm.callbacks if type(c) is not self.DBLogger)
        self.litellm._async_failure_callback.extend(self.litellm.callbacks)
        for _ in range(3): self.runtime.check_runtime()
        self.assertEqual(self.runtime.validation_stage, "complete")
        self.assertEqual(self.runtime.callback_ids, original)

    def test_shadow_is_removed_from_every_registry_without_running_it(self):
        for name in self.names: getattr(self.litellm, name).append(self.Shadow())
        self.check(startup=True)
        for name in self.names:
            self.assertFalse(any(type(c) is self.Shadow for c in getattr(self.litellm, name)))
        self.Shadow.async_log_success_event.assert_not_called()
        self.check()

    def test_secondary_only_shadow_is_removed_at_startup_but_late_shadow_refuses(self):
        self.litellm._async_success_callback.append(self.Shadow())
        self.check(startup=True)
        self.litellm._async_success_callback.append(self.Shadow())
        with self.assertRaises(Refused): self.check()
        self.Shadow.async_log_success_event.assert_not_called()

    def test_unknown_callbacks_and_shadow_subclasses_fail_closed_in_every_registry(self):
        for name in self.names:
            for callback in (object(), type("UnreviewedShadow", (self.Shadow,), {})()):
                with self.subTest(registry=name, callback=type(callback).__name__):
                    items = getattr(self.litellm, name);items.append(callback)
                    with self.assertRaises(Refused): self.check(startup=True)
                    items.pop()

    def test_missing_duplicate_and_same_type_gateway_instances_refuse(self):
        for callbacks in ([c for c in self.litellm.callbacks if c is not self.gateway],
                          [*self.litellm.callbacks, self.gateway],
                          [self.Gateway() if c is self.gateway else c for c in self.litellm.callbacks]):
            with self.subTest(callbacks=len(callbacks)):
                original = self.litellm.callbacks;self.litellm.callbacks = callbacks
                with self.assertRaises(Refused): self.check(startup=True)
                self.litellm.callbacks = original

    def test_native_singleton_replacement_and_extra_db_instances_refuse_at_startup(self):
        for old, new in ((self.budget, self.Budget()), (self.service, self.Service()), (self.hook, self.Hook())):
            original = self.litellm.callbacks[:]
            self.litellm.callbacks[:] = [new if c is old else c for c in original]
            with self.assertRaises(Refused): self.check(startup=True)
            self.litellm.callbacks[:] = original
        self.litellm._async_success_callback.append(self.DBLogger())
        with self.assertRaises(Refused): self.check(startup=True)

    def test_missing_native_async_accounting_or_router_method_refuses(self):
        for name, index in (("_async_success_callback", 1), ("success_callback", 0),
                            ("failure_callback", 0), ("_async_success_callback", 0), ("_async_failure_callback", 0)):
            items = getattr(self.litellm, name);callback = items.pop(index)
            with self.subTest(registry=name), self.assertRaises(Refused): self.check(startup=True)
            items.insert(index, callback)

    def test_same_type_replacement_and_registry_mutation_refuse_after_startup(self):
        self.check(startup=True)
        for name, index, new in (("callbacks", 2, self.DBLogger()), ("_async_success_callback", 1, self.DBLogger()),
                                 ("success_callback", 0, self.router.sync_deployment_callback_on_success)):
            items = getattr(self.litellm, name);old = items[index];items[index] = new
            with self.subTest(registry=name), self.assertRaises(Refused): self.check()
            items[index] = old
        for name in self.names:
            items = getattr(self.litellm, name);items.append(object())
            with self.subTest(registry=name), self.assertRaises(Refused): self.check()
            items.pop()
        self.litellm.callbacks.reverse()
        with self.assertRaises(Refused): self.check()

    def test_startup_snapshot_identifies_each_native_predicate_without_disclosing_values(self):
        probe_path = ROOT / "services/keeper/tests/gateway-admission-image.probe.py"
        spec = importlib.util.spec_from_file_location("callback_marker_probe", probe_path)
        probe = importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
        self.hook.private_value = "private-credential-must-not-appear"
        # Reproduce native manager deduplication leaving a newly constructed owner
        # mapping distinct from the callback it retained; diagnose, never admit it.
        self.proxy.proxy_logging_obj.proxy_hook_mapping = {"max_budget_limiter": self.Hook()}
        with mock.patch.dict(os.environ, {"CI": "true", "LARES_GATEWAY_PROBE_DIAGNOSTICS": "1"}):
            with self.assertRaises(Refused): self.check(startup=True)
        self.assertEqual(self.runtime.validation_stage, "callback-native-membership")
        checks = self.runtime.startup_checks
        self.assertTrue(probe.valid_callback_startup_checks(checks))
        self.assertEqual(checks["proxy_hooks"]["max_budget_limiter"], {"mapped": True, "mapped_type": True, "mapped_present": False, "count": 1})
        self.assertEqual(checks["native"]["model_budget"], {"owner_type": True, "owner_present": True, "count": 1})
        self.assertEqual(checks["primary"]["unowned_count"], 1)
        marker = {"phase": "runtime-validation-failed", "stage": self.runtime.validation_stage, "checks": checks}
        raw = json.dumps(marker).encode()
        self.assertLess(len(raw), 8192)
        self.assertNotIn(b"private-credential", raw)
        self.assertNotIn(type(self.hook).__name__.encode(), raw)
        self.assertEqual(probe.validated_startup_marker(raw), marker)
        for mutate in (lambda d: d["native"]["model_budget"].update(count=32),
                       lambda d: d["native"]["model_budget"].update(count=True),
                       lambda d: d["native"]["model_budget"].update(owner_present="private"),
                       lambda d: d["proxy_hooks"].update(private={}),
                       lambda d: d["primary"].update(private="private")):
            bad = json.loads(raw);mutate(bad["checks"])
            self.assertEqual(probe.validated_startup_marker(json.dumps(bad).encode()), "unknown")
        archive_bytes = io.BytesIO()
        with tarfile.open(fileobj=archive_bytes, mode="w") as archive:
            info = tarfile.TarInfo("failure.json");info.size = len(raw);archive.addfile(info, io.BytesIO(raw))
        self.assertEqual(probe.startup_marker_from_archive(archive_bytes.getvalue(), "failure.json"), marker)
        source = ast.parse((ROOT / "images/gateway-runtime/lares_gateway.py").read_text())
        names = {"STARTUP_STATE_FILE", "STARTUP_FAILURE_FILE", "STARTUP_PHASES", "STARTUP_STAGES"}
        selected = [node for node in source.body if (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in names) or (isinstance(node, ast.FunctionDef) and node.name == "record_startup_diagnostic")]
        from admission_contract import canonical
        namespace = {"os": os, "pathlib": pathlib, "tempfile": tempfile, "canonical": canonical}
        exec(compile(ast.Module(body=selected, type_ignores=[]), "callback-diagnostic-writer", "exec"), namespace)
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ, {"CI": "true", "LARES_GATEWAY_PROBE_DIAGNOSTICS": "1"}):
            state = pathlib.Path(folder) / "state.json";failure = pathlib.Path(folder) / "failure.json"
            namespace.update(STARTUP_STATE_FILE=str(state), STARTUP_FAILURE_FILE=str(failure))
            namespace["record_startup_diagnostic"](marker["phase"], marker["stage"], checks)
            first = failure.read_bytes()
            namespace["record_startup_diagnostic"]("native-lifespan-error", marker["stage"])
            self.assertEqual(failure.read_bytes(), first)
            self.assertEqual(probe.validated_startup_marker(first), marker)

    def test_startup_snapshot_is_ci_only_capped_and_cannot_change_enforcement(self):
        for environment in ({"CI": "false", "LARES_GATEWAY_PROBE_DIAGNOSTICS": "1"}, {"CI": "true", "LARES_GATEWAY_PROBE_DIAGNOSTICS": "0"}):
            with mock.patch.dict(os.environ, environment):
                self.check(startup=True)
            self.assertIsNone(getattr(self.runtime, "startup_checks", None))
            self.runtime.callback_ids = self.runtime.secondary_callback_ids = None
        self.litellm.input_callback[:] = [object() for _ in range(40)]
        checks = self.callback_checks(self.proxy)
        self.assertEqual(checks["events"]["input_callback"]["unknown_count"], 31)
        self.litellm.input_callback.clear()
        with mock.patch.dict(os.environ, {"CI": "true", "LARES_GATEWAY_PROBE_DIAGNOSTICS": "1"}), mock.patch.dict(self.runtime.check_callbacks.__globals__, {"callback_startup_checks": mock.Mock(side_effect=RuntimeError("private"))}):
            self.check(startup=True)
        self.assertIsNone(self.runtime.startup_checks)

    def test_unknown_router_methods_and_foreign_router_instances_refuse(self):
        for callback in (self.Router().sync_deployment_callback_on_success, self.router.deployment_callback_on_failure):
            self.litellm.success_callback.append(callback)
            with self.assertRaises(Refused): self.check(startup=True)
            self.litellm.success_callback.pop()


class EmbeddedFixtureTests(unittest.TestCase):
    """Exercise the actual generated fixture wire bytes without Docker or a socket."""
    @classmethod
    def setUpClass(cls):
        module = ast.parse((ROOT / "services/keeper/tests/gateway-admission-image.probe.py").read_text())
        cls.scripts = {node.targets[0].id: ast.literal_eval(node.value) for node in module.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ("FIXTURE", "CLIENT")}
        for script in cls.scripts.values():
            assert "\\\\n" not in script and "\\\\0" not in script
        cls.fixture_ast = ast.parse(cls.scripts["FIXTURE"])
        with tempfile.NamedTemporaryFile(suffix=".mjs") as source:
            source.write(cls.scripts["CLIENT"].encode());source.flush()
            subprocess.run(["node", "--check", source.name], check=True, capture_output=True)

    def fixture_request(self, provider, mode="normal", stream=True, path=None):
        from admission_contract import canonical, ADMIT_PATH, SETTLE_PATH
        release=threading.Event();release.set()
        namespace={"http":http,"ssl":None,"threading":threading,"json":json,"time":time,"pathlib":pathlib,"hashlib":hashlib,"uuid":uuid,"sys":sys,"gzip":gzip,"sign":sign,"verify":verify,"canonical":canonical,"ADMIT_PATH":ADMIT_PATH,"SETTLE_PATH":SETTLE_PATH,"key":bytes(range(32)),"lock":threading.Lock(),"release":release}
        data_node=next(n for n in self.fixture_ast.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id=="data")
        handler_node=next(n for n in self.fixture_ast.body if isinstance(n,ast.ClassDef))
        exec(compile(ast.Module(body=[data_node,handler_node],type_ignores=[]),"fixture-definitions","exec"),namespace)
        namespace["data"]["mode"]=mode
        handler=namespace["Handler"].__new__(namespace["Handler"])
        handler.path=path or ("/v1/messages" if provider=="anthropic" else "/v1/chat/completions")
        raw=json.dumps({"model":"fixture-model","messages":[{"role":"user","content":"fixture"}],"stream":stream}).encode()
        handler.headers={"content-length":str(len(raw))};handler.rfile=io.BytesIO(raw);handler.wfile=io.BytesIO();headers={}
        handler.send_response=lambda status:headers.update(status=status)
        handler.send_header=lambda key,value:headers.update({key:value})
        handler.end_headers=lambda:None
        handler.do_POST()
        return handler.wfile.getvalue(),headers,namespace["data"]

    def test_fixture_sse_is_real_framing_and_validates_actual_usage(self):
        for provider in ("openai","anthropic"):
            wire,headers,data=self.fixture_request(provider)
            self.assertIn(b"\n\n",wire);self.assertNotIn(b"\\n",wire)
            evidence=WireEvidence(provider,headers["content-type"],headers["status"])
            for start in range(0,len(wire),7):evidence.feed(wire[start:start+7])
            self.assertEqual(evidence.finish()["outputTokens"],4)
            self.assertEqual(data["upstream"],1)
            for mode in ("partial","malformed-usage","missing-finish","late-content","mixed-id","compressed"):
                wire,headers,_=self.fixture_request(provider,mode)
                evidence=WireEvidence(provider,headers["content-type"],headers["status"])
                evidence.feed(wire)
                self.assertIsNone(evidence.finish(),(provider,mode))

    def test_unknown_physical_routes_are_counted(self):
        _,headers,data=self.fixture_request("openai",path="/v1/responses")
        self.assertEqual(headers["status"],404)
        self.assertEqual(data["upstream"],1);self.assertEqual(data["routes"]["other"],1)

    def test_embedded_node_hash_matches_raw_bytes_after_shaping(self):
        code=self.scripts["CLIENT"]
        expression=code.split("hash=createHash('sha256')",1)[1].split(".digest('hex')",1)[0]
        raw='{"model":"lares-brain", "text":"ø cache_control"}'.encode()
        script="import{createHash}from'node:crypto';const path='/v1/messages';const init={body:Buffer.from("+json.dumps(list(raw))+")};console.log(createHash('sha256')"+expression+".digest('hex'));"
        result=subprocess.run(["node","--input-type=module","-e",script],text=True,capture_output=True,check=True).stdout.strip()
        self.assertEqual(result,request_hash("POST","/v1/messages",raw))

    def test_live_usage_probe_help_and_spending_guard_are_offline(self):
        path=ROOT / "services/keeper/tests/live/gateway-provider-usage.live.py"
        compile(path.read_text(),str(path),"exec")
        help_result=subprocess.run([sys.executable,"-B",str(path),"--help"],text=True,capture_output=True,check=True)
        self.assertIn("--max-output-tokens",help_result.stdout)
        arguments=["--profile","/nonexistent/probe-private-profile","--key-file","/nonexistent/probe-private-key","--provider","anthropic","--model","probe-private-model","--mode","stream","--max-output-tokens","8"]
        environment={**os.environ,"I_UNDERSTAND_THIS_SPENDS_MONEY":"0"}
        result=subprocess.run([sys.executable,"-B",str(path),*arguments],env=environment,text=True,capture_output=True)
        self.assertEqual(result.returncode,1)
        self.assertEqual(result.stdout,"")
        self.assertEqual(result.stderr,"FAIL: probe refused or terminal provider usage was not verified.\n")
        invalid=subprocess.run([sys.executable,"-B",str(path),*arguments,"--provider","private-invalid-value"],env=environment,text=True,capture_output=True)
        self.assertEqual(invalid.returncode,2)
        self.assertNotIn("private-invalid-value",invalid.stderr)

    def test_live_usage_worker_has_an_absolute_process_deadline(self):
        path=ROOT / "services/keeper/tests/live/gateway-provider-usage.live.py"
        spec=importlib.util.spec_from_file_location("live_usage_probe",path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        started=time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            module.bounded_worker([sys.executable,"-c","import time; time.sleep(60)"],.05)
        self.assertLess(time.monotonic()-started,2)

    def test_ci_startup_diagnostics_are_bounded_and_redacted(self):
        path=ROOT / "services/keeper/tests/gateway-admission-image.probe.py"
        spec=importlib.util.spec_from_file_location("admission_image_probe",path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        secret=b"sk-fixture-password-PRIVATE"
        service=bytes(range(32))
        representations=[secret.decode(),secret.hex(),repr(secret),base64.b64encode(secret).decode(),base64.urlsafe_b64encode(secret).decode().rstrip("="),repr(service),service.hex()]
        raw=json.dumps({"log":"\n".join(representations)+" https://user:PRIVATE@example.invalid/path Authorization: Bearer PRIVATE"})
        clean=module.sanitize_diagnostic(raw,[secret,service])
        self.assertNotIn("PRIVATE",clean);self.assertNotIn("example.invalid",clean)
        for representation in representations:self.assertNotIn(json.dumps(representation)[1:-1],clean)
        self.assertNotIn("PRIVATE",module.sanitize_diagnostic('{"token":"PRIVATE"}',[]))
        bounded=module.bounded_capture(sys.executable,"-c","print('safe-line');print('x'*10000)",maximum=80,seconds=1)
        self.assertIn("safe-line",bounded);self.assertIn("truncated",bounded);self.assertLess(len(bounded),160)
        started=time.monotonic()
        module.bounded_capture(sys.executable,"-c","import time;time.sleep(60)",seconds=.05)
        self.assertLess(time.monotonic()-started,2)

    def test_first_startup_failure_survives_shutdown_and_requires_both_ci_flags(self):
        source=ast.parse((ROOT / "images/gateway-runtime/lares_gateway.py").read_text())
        names={"STARTUP_STATE_FILE","STARTUP_FAILURE_FILE","STARTUP_PHASES","STARTUP_STAGES"}
        selected=[node for node in source.body if (isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name) and node.targets[0].id in names) or (isinstance(node,ast.FunctionDef) and node.name=="record_startup_diagnostic")]
        from admission_contract import canonical
        namespace={"os":os,"pathlib":pathlib,"tempfile":tempfile,"canonical":canonical}
        exec(compile(ast.Module(body=selected,type_ignores=[]),"startup-diagnostic","exec"),namespace)
        probe_path=ROOT / "services/keeper/tests/gateway-admission-image.probe.py"
        spec=importlib.util.spec_from_file_location("startup_marker_probe",probe_path)
        probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
        self.assertEqual(namespace["STARTUP_PHASES"],probe.STARTUP_PHASES)
        self.assertEqual(namespace["STARTUP_STAGES"],probe.STARTUP_STAGES)
        with tempfile.TemporaryDirectory() as folder:
            state_file=pathlib.Path(folder)/"state.json";failure_file=pathlib.Path(folder)/"failure.json"
            namespace.update(STARTUP_STATE_FILE=str(state_file),STARTUP_FAILURE_FILE=str(failure_file))
            record=namespace["record_startup_diagnostic"]
            for environment in ({"CI":"false","LARES_GATEWAY_PROBE_DIAGNOSTICS":"1"},{"CI":"true","LARES_GATEWAY_PROBE_DIAGNOSTICS":"0"}):
                with mock.patch.dict(os.environ,environment):record("process-starting")
                self.assertFalse(state_file.exists())
            with mock.patch.dict(os.environ,{"CI":"true","LARES_GATEWAY_PROBE_DIAGNOSTICS":"1"}):
                record("process-starting");record("preflight-passed");record("native-lifespan-complete")
                record("runtime-validation-failed","callback-registry")
                record("native-lifespan-error","complete")
                first=failure_file.read_bytes()
                self.assertEqual(probe.validated_startup_marker(first),{"phase":"runtime-validation-failed","stage":"callback-registry"})
                record("PRIVATE","PRIVATE")
                self.assertEqual(first,failure_file.read_bytes())
            self.assertEqual(probe.validated_startup_marker(b'{"phase":"PRIVATE","stage":"PRIVATE"}'),"unknown")
            self.assertEqual(probe.validated_startup_marker(b'x'*1025),"unknown")
            archive_bytes=io.BytesIO()
            with tarfile.open(fileobj=archive_bytes,mode="w") as archive:
                info=tarfile.TarInfo("failure.json");info.size=len(first);archive.addfile(info,io.BytesIO(first))
            self.assertEqual(probe.startup_marker_from_archive(archive_bytes.getvalue(),"failure.json"),probe.validated_startup_marker(first))
            self.assertEqual(probe.startup_marker_from_archive(b"not tar","failure.json"),"unknown")
            noisy="Gateway admission runtime validation failed: callback-registry\n"+"shutdown traceback\n"*10000
            self.assertEqual(probe.fixed_startup_log_markers(noisy),["runtime-validation-failed:callback-registry"])

    def test_only_exact_terminal_openai_stream_settles(self):
        done = {"id":"completion_fixture","choices":[{"index":0,"finish_reason":"stop"}]}
        final = {"id":"completion_fixture","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}
        good = TerminalEvidence("/v1/chat/completions")
        for chunk in [done,final]: good.feed(chunk)
        self.assertEqual(good.result()["outputTokens"],4)
        for chunks in [[done],[final],[done,{**final,"usage":{"prompt_tokens":12,"completion_tokens":4}}],[done,{**final,"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":15}}],[done,{**final,"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":-1}}}],[done,final,final]]:
            evidence = TerminalEvidence("/v1/chat/completions")
            for chunk in chunks: evidence.feed(chunk)
            self.assertIsNone(evidence.result())

    def test_nonstream_needs_terminal_marker_and_valid_aggregate(self):
        anthropic = TerminalEvidence("/v1/messages")
        openai = TerminalEvidence("/v1/chat/completions")
        self.assertIsNone(anthropic.nonstream({"type":"message","stop_reason":None,"usage":{"input_tokens":12,"output_tokens":4}}))
        self.assertIsNone(openai.nonstream({"choices":[{"finish_reason":None}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}))
        self.assertIsNone(openai.nonstream({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}))
        self.assertIsNone(anthropic.nonstream({"type":"message","stop_reason":"end_turn","usage":{"input_tokens":12}}))

    def test_actual_wire_stream_requires_complete_termination(self):
        done = {"id":"completion_fixture","choices":[{"index":0,"finish_reason":"stop"}]}
        final = {"id":"completion_fixture","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}
        wire = b"".join(b"data: "+json.dumps(item).encode()+b"\n\n" for item in [done,final])+b"data: [DONE]\n\n"
        evidence = WireEvidence("openai","text/event-stream",200)
        for byte in wire: evidence.feed(bytes([byte]))
        self.assertEqual(evidence.finish()["outputTokens"],4)
        for bad in [wire[:-1],wire.replace(b"data: [DONE]\n\n",b""),wire+b"data: {}\n\n",wire.replace(b'"total_tokens": 16',b'"total_tokens": -1')]:
            evidence=WireEvidence("openai","text/event-stream",200);evidence.feed(bad)
            self.assertIsNone(evidence.finish())
        too_big=WireEvidence("openai","application/json",200)
        too_big.feed(b" "*(MAX_RESPONSE_BYTES+1))
        self.assertIsNone(too_big.finish());self.assertEqual(too_big.buffer,b"")

    def test_late_content_and_mixed_stream_ids_poison_usage(self):
        done={"id":"one","choices":[{"index":0,"finish_reason":"stop"}]}
        usage={"id":"one","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}
        for late in [{"id":"one","choices":[{"index":0,"delta":{"content":"late"},"finish_reason":None}]},{**usage,"id":"two"}]:
            evidence=TerminalEvidence("/v1/chat/completions")
            for chunk in [done,usage,late]:evidence.feed(chunk)
            self.assertIsNone(evidence.result())


if __name__ == "__main__": unittest.main()
