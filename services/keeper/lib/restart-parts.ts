import { createHash } from 'node:crypto';
import { doorsOf, type AgentDefinition } from '@lares/agent-kit/definition';
import { personalGoogleEnabled } from './personal-google.js';
import { personalMicrosoftEnabled } from './personal-microsoft.js';

/** The parts of an agent's definition that take effect only when its container restarts: the role
 * (which image runs), the doors and the personal-account switches (which secrets are mounted), and,
 * on an installation whose spending is guarded by a budget key, the model name (which key pays).
 * Everything else (description, instructions, personality, language, schedules, delivery, outside
 * tools) is read again for each conversation (ADR-0015), so a save makes it live at once. */
export type RestartPartsOptions = { readonly model: boolean };

export function restartFingerprint(d: AgentDefinition, options: RestartPartsOptions): string {
    return createHash('sha256').update(JSON.stringify({
        role: d.role, doors: doorsOf(d),
        personalGoogle: personalGoogleEnabled(d), personalMicrosoft: personalMicrosoftEnabled(d),
        ...(options.model ? { model: d.model } : {}),
    })).digest('hex');
}

/** True when the applied definition already runs every part of `saved` that needs a restart. */
export function restartPartsApplied(applied: AgentDefinition, saved: AgentDefinition, options: RestartPartsOptions): boolean {
    return restartFingerprint(applied, options) === restartFingerprint(saved, options);
}
