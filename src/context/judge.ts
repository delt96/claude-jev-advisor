import type { Config } from '../config-shape.js';
import type { Judgment } from '../display/line.js';
import type { JevQuestion, JevRequest } from '../jev.js';

export const REPLY_EDGE_CHARS = 1500;

export const QUESTIONS: Record<'unit_done' | 'phase_done', JevQuestion> = {
  unit_done: {
    type: 'noul',
    instructions: "Has Claude finished or handed back the work the user asked for in `recent_requests`, so that `last_assistant_reply` is a natural break before the user's next instruction?",
    criteria: {
      true: 'The asked-for work is done, checked, reported or handed back. It still counts as done when the reply also lists unverified points, risks or follow-ups, offers optional extras, or asks the user to choose or approve what comes next.',
      false: 'Claude stopped partway through the asked-for work: it needs information to continue it, is waiting for background work that belongs to it, reports a failure it has not resolved, or says it will now go on with the next step of the same request.',
    },
  },
  phase_done: {
    type: 'noul',
    instructions: 'Does `last_assistant_reply` close a whole stage of the work, so that what comes next is a new stage that can start from the saved results (commits, documents, a release) rather than from this conversation?',
    criteria: {
      true: [
        'A whole plan, feature, fix or multi-step job is finished and merged, pushed, released, deployed, installed or put into operation.',
        'An investigation or analysis is finished and its final conclusion is reported or saved as a document.',
        'A design or implementation plan is written and saved as a document, ready for review or for the next stage to work from.',
      ],
      false: [
        'Only one task, step or part of a larger stage is done, and the same stage goes on (for example the next task of the same plan).',
        'The reply answers a single small request or question, or makes a small edit, without closing a larger stage.',
        'Work is still going on, failed, or is waiting for information it needs to continue.',
      ],
    },
  },
};

export function cutReply(text: string, edge = REPLY_EDGE_CHARS): string {
  return text.length <= edge * 2 ? text : `${text.slice(0, edge)}\n…\n${text.slice(-edge)}`;
}

export function jevRequest(requests: string[], lastReply: string): JevRequest {
  return {
    state: { recent_requests: requests, last_assistant_reply: cutReply(lastReply) },
    questions: { unit_done: QUESTIONS.unit_done, phase_done: QUESTIONS.phase_done },
  };
}

export function judgmentFrom(answers: Record<string, number>, config: Config): Judgment | null {
  const unit = answers.unit_done;
  if (typeof unit !== 'number') return null;
  const stage = answers.phase_done;
  if (typeof stage === 'number' && stage >= config.context.phaseDoneYes) return { phase: 'unit_done', clear: true };
  return unit >= config.context.unitDoneYes ? { phase: 'unit_done', clear: false } : { phase: 'working', clear: false };
}

export function hasBackgroundTasks(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}
