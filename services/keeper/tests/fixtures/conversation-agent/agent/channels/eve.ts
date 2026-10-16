import {eveChannel} from 'eve/channels/eve';
import {httpBasic} from 'eve/channels/auth';
export default eveChannel({auth:[httpBasic({username:'fixture',password:'disposable-fixture-only'})]});
