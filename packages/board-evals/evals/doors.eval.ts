import {defineEval} from 'eve/evals';
import {readFileSync} from 'node:fs';
import definition from '../door-definition.json' with {type:'json'};
export default defineEval({async test(t){
 if(definition.doors[0].kind!=='telegram'||definition.doors[0].enabled!==false)throw new Error('Expected a disabled Telegram definition');
 const result=await t.send('inert door turn');
 if(!result.message?.includes('DONE:inert door turn'))throw new Error('Mock runtime turn did not complete');
 if(/INERT_DOOR_(TOKEN|OUTBOUND)_ATTEMPT/.test(readFileSync(process.env.BOARD_LOG!,'utf8')))throw new Error('Disabled door touched credentials or attempted outbound');
 t.log('PASS: real eve adapter compiled with disabled Telegram definition and no token; turn completes; no credential resolution or outbound call.');
}});
