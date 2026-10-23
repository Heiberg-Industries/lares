import importlib.util
import json
import pathlib
import unittest

PROBE=pathlib.Path(__file__).with_name("gateway-admission-image.probe.py")
spec=importlib.util.spec_from_file_location("gateway_admission_probe",PROBE)
probe=importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def observation(state):
    return {
        "state":state,"capture":"ok","clientResultKind":"mismatch","teamObject":True,"roleArray":True,"membershipArray":True,
        "roleCount":0,"membershipCount":0,"roleOverflow":False,"membershipOverflow":False,
        "teamIdShape":{"missing":0,"null":0,"empty":0,"invalid":0},"teamIdMatchesExpected":True,
        "roleUserIdShape":{"missing":0,"null":0,"empty":0,"invalid":0},"roleDuplicateIds":False,"roleUnexpectedRows":0,
        "membershipUserIdShape":{"missing":0,"null":0,"empty":0,"invalid":0},
        "membershipTeamIdShape":{"missing":0,"null":0,"empty":0,"invalid":0},
        "membershipDuplicateUserIds":False,"membershipWrongTeamRows":0,"membershipUnexpectedRows":0,
        "budgetShape":{"missing":0,"null":0,"nonObject":0,"numeric":0,"durationString":0,"modelsArray":0},
    }


class GatewayRosterDiagnosticParserTests(unittest.TestCase):
    def test_accepts_only_three_unique_value_free_bounded_observations(self):
        lines=["ROSTER-OBS "+json.dumps(observation(state),separators=(",",":")) for state in probe.ROSTER_STATES]
        records,valid=probe.parse_roster_observations(lines)
        self.assertTrue(valid)
        self.assertEqual([record["state"] for record in records],list(probe.ROSTER_STATES))

    def test_requires_every_state_once_and_rejects_duplicate_or_malformed_records(self):
        empty="ROSTER-OBS "+json.dumps(observation("empty"))
        first="ROSTER-OBS "+json.dumps(observation("first"))
        records,valid=probe.parse_roster_observations([empty,first,empty])
        self.assertFalse(valid)
        self.assertEqual(len(records),2)
        self.assertIsNone(probe.parse_roster_observation(empty[:-1]+',"rawId":"must-not-be-accepted"}'))
        self.assertIsNone(probe.parse_roster_observation('ROSTER-OBS {"state":"empty","state":"first"}'))

    def test_rejects_unbounded_counts_and_boolean_as_integer(self):
        value=observation("full")
        value["roleCount"]=130
        self.assertIsNone(probe.parse_roster_observation("ROSTER-OBS "+json.dumps(value)))
        value=observation("full")
        value["membershipCount"]=True
        self.assertIsNone(probe.parse_roster_observation("ROSTER-OBS "+json.dumps(value)))


if __name__=="__main__":unittest.main(verbosity=0)
