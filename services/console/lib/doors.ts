/** Pure setup instructions. Public door origin is separate from the private console origin. */
export function publicDoorOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Configure an HTTPS public door origin without credentials, path, query or fragment.');
  return url.origin;
}
/** The Slack app's bot permissions, by role. Every role reads and answers direct messages and hears
 * a mention of the app in a channel (`app_mentions:read`). No permission to read a channel's other
 * messages is asked for. `assistant:write` is what lets Slack label the app an agent. Only a
 * role that starts conversations on a schedule (the chief of staff) also gets `im:write`: Slack's
 * `conversations.open`, which looks up the owner's direct-message channel before such a
 * conversation starts, needs it. Any other role, including one added later, does not. */
export function slackBotScopes(role:string):string[] {
  const base=['chat:write','im:history','app_mentions:read','assistant:write'];
  return role==='chief-of-staff'?[...base,'im:write']:base;
}
/** Shown on the app's Slack profile. `agent_view` is the manifest setting that makes Slack label the
 * app an agent (with `assistant:write`) instead of a plain app. */
export const SLACK_APP_DESCRIPTION='An assistant you talk to in direct messages, or mention in a channel.';
/** Slack limits: the profile line is 140 characters, the agent description 300. */
const SLACK_PROFILE_MAX=140, SLACK_AGENT_DESCRIPTION_MAX=300;
/** The app's background colour. The definition has no colour or brand field, so every app gets this
 * one neutral grey; the owner can change it in Slack. */
export const SLACK_APP_BACKGROUND_COLOR='#4a4a4a';
/** Suggested prompts shown when someone opens the agent in Slack (Slack allows up to four). Plain
 * defaults the agent's default tools can answer; the definition has no field for prompts. */
export const SLACK_SUGGESTED_PROMPTS:{title:string;message:string}[]=[
  {title:'Today',message:"What's on my calendar today?"},
  {title:'My inbox',message:"What's new in my inbox?"},
  {title:'Reply',message:'Draft a reply to my latest email.'},
  {title:'This week',message:'What should I prepare this week?'},
];
function fitted(text:string|undefined,max:number):string {
  const t=(text??'').trim().replace(/\s+/g,' ');
  if(t==='')return SLACK_APP_DESCRIPTION;
  return t.length<=max?t:`${t.slice(0,max-1).trimEnd()}…`;
}
/** A Slack manifest cannot carry the app's picture; it is uploaded by hand. */
export const SLACK_ICON_STEP='Slack cannot take the picture from the manifest. Upload one yourself: Basic Information, then Display Information, then App icon.';
/** For an app made before this setting existed. Slack cannot undo the switch to agent view. */
export const slackExistingAppSteps:string[]=[
  'Open your Slack app at api.slack.com/apps and choose App Manifest.',
  'Replace its contents with the manifest shown here (Copy manifest) and save. Slack lists what changed; confirm it.',
  'Slack asks you to reinstall the app because it now has the assistant:write permission. Do that; the bot token stays the same.',
  'Switching an app to agent view cannot be undone. Reload Slack with a full refresh (Cmd/Ctrl+Shift+R in the browser) to see the app labelled as an agent.',
  SLACK_ICON_STEP,
];
export function slackManifest(agent: {name:string;display:string;role:string;description?:string}, consoleUrl:string) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(agent.name)) throw new Error('Invalid agent name');
  const origin=publicDoorOrigin(consoleUrl);
  const manifest={
    display_information:{name:agent.display,description:fitted(agent.description,SLACK_PROFILE_MAX),background_color:SLACK_APP_BACKGROUND_COLOR},
    features:{agent_view:{agent_description:fitted(agent.description,SLACK_AGENT_DESCRIPTION_MAX),suggested_prompts:SLACK_SUGGESTED_PROMPTS},bot_user:{display_name:agent.display,always_online:true},app_home:{home_tab_enabled:false,messages_tab_enabled:true,messages_tab_read_only_enabled:false}},
    oauth_config:{scopes:{bot:slackBotScopes(agent.role)}},
    settings:{event_subscriptions:{request_url:`${origin}/api/doors/${agent.name}/slack/events`,bot_events:['message.im','app_mention']},
      interactivity:{is_enabled:true,request_url:`${origin}/api/doors/${agent.name}/slack/events`},org_deploy_enabled:false,socket_mode_enabled:false,token_rotation_enabled:false},
  };
  return {manifest,createUrl:`https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`};
}
export function telegramSteps(agent:string):{step:number;text:string}[] {
  return [
    {step:1,text:'Open the verified @BotFather account in Telegram.'},
    {step:2,text:`Send /newbot and enter ${agent} as the display name.`},
    {step:3,text:'Choose an available username ending in bot. Copy the bot token privately.'},
    {step:4,text:'Paste the token below and press Connect. Everything else happens by itself; at the end you tap one link and press Start.'},
  ];
}
/** The door's row as the keeper reports it. `configured` means a token was saved at some point. */
export interface DoorRow {kind:string;enabled:boolean;configured?:boolean;claimed:boolean;pending:boolean;pending_reason?:string;applied:boolean}
/** A door the owner has never touched: not enabled, no saved token, no owner. The
 * keeper's pending flag belongs to the whole agent, so it says nothing about such a door. */
export function doorTouched(row?:DoorRow):boolean {
  return Boolean(row&&(row.enabled||row.configured||row.claimed));
}
export function doorStateText(row?:DoorRow):string {
  if(!row||!doorTouched(row))return 'Not set up';
  if(row.pending)return `Pending: ${row.pending_reason??'Apply connection changes'}`;
  if(row.applied&&row.enabled)return row.claimed?'Connected':'Owner connection applied';
  return row.enabled?'Credentials applied; owner connection still needed':'Credentials saved; door is off';
}
/** Telegram's deep link: opening it and pressing Start sends `/start <code>` to the bot. The
 * code is the one-time code (letters and digits only, which Telegram allows in a start link). */
export function telegramConnectLink(username:string,code:string):string {
  if(!/^[A-Za-z0-9_]{4,32}$/.test(username)||!/^[A-Z0-9]{24}$/.test(code))throw new Error('Invalid Telegram bot username or code');
  return `https://t.me/${username}?start=${code}`;
}
export const slackClaimMessage=(code:string)=>`claim ${code}`;
