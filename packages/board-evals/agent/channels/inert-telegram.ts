// Real authored eve adapter, compiled with the fixture. Disabled definition, no token.
import {telegramChannel} from 'eve/channels/telegram';
import {parseDefinition} from '@lares/agent-kit/definition';
import {appendFileSync} from 'node:fs';
import source from '../../door-definition.json' with {type:'json'};
const definition=parseDefinition(source);
if(definition.doors?.[0]?.enabled!==false)throw new Error('Inert-door fixture must stay disabled');
export default telegramChannel({
 route:'/proof/inert-telegram',
 credentials:{botToken:()=>{appendFileSync(process.env.BOARD_LOG!,'INERT_DOOR_TOKEN_ATTEMPT\n');throw new Error('Disabled door has no token');}},
 api:{fetch:async()=>{appendFileSync(process.env.BOARD_LOG!,'INERT_DOOR_OUTBOUND_ATTEMPT\n');throw new Error('Disabled door attempted outbound');}},
});
