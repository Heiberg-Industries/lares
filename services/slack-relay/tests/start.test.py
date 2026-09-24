"""Offline entrypoint tests; no Docker, network or real NGINX process."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

START = Path(__file__).resolve().parents[1] / 'start.sh'

class RelayStartTests(unittest.TestCase):
    def run_case(self, root, config, check_fails=False):
        root = Path(root)
        fake = root / 'nginx'
        fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@" >> "$CALLS"\n'
                        'if [ "$1" = "-t" ] && [ "$CHECK_FAILS" = "yes" ]; then exit 1; fi\n')
        fake.chmod(0o700)
        env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH'],
               'CALLS': str(root / 'calls'), 'CHECK_FAILS': 'yes' if check_fails else 'no',
               'LARES_RELAY_CONFIG': config}
        result = subprocess.run(['sh', str(START)], env=env, capture_output=True)
        calls = (root / 'calls').read_text().splitlines() if (root / 'calls').exists() else []
        return result, calls

    def test_missing_configuration_never_starts_nginx(self):
        with tempfile.TemporaryDirectory() as root:
            result, calls = self.run_case(root, root + '/missing')
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])

    def test_relative_path_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            result, calls = self.run_case(root, 'relative.conf')
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])

    def test_failed_validation_never_starts_server(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / 'config with spaces.conf'; config.write_text('example')
            result, calls = self.run_case(root, str(config), True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, ['-t', '-c', str(config)])

    def test_only_the_selected_configuration_is_used(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / 'config with spaces.conf'; config.write_text('example')
            result, calls = self.run_case(root, str(config))
            self.assertEqual(result.returncode, 0)
            self.assertEqual(calls, ['-t', '-c', str(config), '-c', str(config), '-g', 'daemon off;'])

if __name__ == '__main__':
    unittest.main()
