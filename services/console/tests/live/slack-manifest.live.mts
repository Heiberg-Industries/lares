/** Manual probe only; never creates an app. With SLACK_CONFIGURATION_TOKEN_FILE, validates
 * through apps.manifest.validate. Without it, prints the create URL; a human must create
 * one real app in Task20. Printing a URL is NOT live validation.
 * LARES_PUBLIC_DOOR_ORIGIN=https://doors.example.com pnpm -C services/console exec tsx tests/live/slack-manifest.live.mts
 * Source: https://docs.slack.dev/reference/methods/apps.manifest.validate/
 */
import {readFileSync} from 'node:fs';
import {slackManifest} from '../../lib/doors.ts';
const origin=process.env.LARES_PUBLIC_DOOR_ORIGIN;
if(!origin) throw new Error('Set LARES_PUBLIC_DOOR_ORIGIN to the explicit public HTTPS origin.');
const {manifest,createUrl}=slackManifest({name:process.env.SLACK_PROBE_AGENT??'door-probe',display:'Door probe'},origin);
const file=process.env.SLACK_CONFIGURATION_TOKEN_FILE;
if(!file) {
  console.log('LIVE VALIDATION PENDING: no configuration token supplied. Human app creation acceptance required in Task20.');
  console.log(createUrl);
} else {
  const token=readFileSync(file,'utf8').trim();
  if(!token) throw new Error('Configuration token file is empty.');
  let response:Response;
  try {response=await fetch('https://slack.com/api/apps.manifest.validate',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({manifest:JSON.stringify(manifest)}),signal:AbortSignal.timeout(15000)});}
  catch {throw new Error('Slack validation request failed; no app was created.');}
  const result=await response.json() as {ok?:boolean};
  if(!response.ok||result.ok!==true) throw new Error('Slack rejected the manifest. Inspect it in Slack app settings; response omitted to protect credentials.');
  console.log('PASS: Slack apps.manifest.validate accepted the generated manifest. No app was created.');
}
