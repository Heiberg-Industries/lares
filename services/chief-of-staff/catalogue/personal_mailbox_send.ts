import {defineTool} from 'eve/tools';
import {personalSendInputSchema,personalSendApprovalRequest,sendApprovedPersonalMail} from '../lib/personal-send-approval.js';
export default defineTool({description:'Propose one plaintext email from your own exact selected personal mailbox. The complete account, all To recipients, subject and body require your explicit approval every time. No aliases, threads, Cc/Bcc, HTML or attachments. Acceptance does not establish delivery.',
  inputSchema:personalSendInputSchema,approval:personalSendApprovalRequest,
  async execute(input,ctx){return sendApprovedPersonalMail(ctx,input);},
});
