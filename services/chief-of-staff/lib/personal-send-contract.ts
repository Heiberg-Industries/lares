/** Closed, own-mail plaintext send. No model URLs, aliases, threads or general Graph client. */
import type { PersonalMailPayload, PersonalActionReceipt } from '@lares/agent-kit/personal-action-store';
export class PersonalSendError extends Error {
  constructor(){super('Personal mail action unavailable or authority changed');this.name='PersonalSendError';}
}
export interface PersonalSendAdapter {
  /** Called only once, after a durable claim and a fresh locked authority check. Any thrown
   * error means uncertainty once invoked; an accepted receipt never proves delivery. */
  send(payload:PersonalMailPayload):Promise<Extract<PersonalActionReceipt,{state:'accepted'}>>;
}
export function oneShotSend(signal:AbortSignal,write:PersonalSendAdapter['send']):PersonalSendAdapter {
  let invoked=false;
  return {async send(payload){
    if(invoked)throw new PersonalSendError();
    invoked=true;signal.throwIfAborted();return write(payload);
  }};
}
