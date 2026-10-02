import type { Config } from '../config-shape.js';
import type { Judgment } from '../display/line.js';
import type { JevQuestion, JevRequest } from '../jev.js';

export const REPLY_EDGE_CHARS = 1500;

export const QUESTIONS: Record<'unit_done' | 'goal_done', JevQuestion> = {
  unit_done: {
    type: 'noul',
    instructions: 'Has the work asked for in `recent_requests` reached a natural stopping point in `last_assistant_reply`?',
    criteria: {
      true: 'The requested work is finished, verified or handed over; anything still mentioned is optional.',
      false: 'The work is still in progress: the reply asks a question it needs answered to continue, says what it will do next, or reports something still running or failing.',
    },
  },
  goal_done: {
    type: 'noul',
    instructions: 'Does `last_assistant_reply` wrap up the overall goal behind `recent_requests`, with no further steps on that goal left to take next?',
    criteria: {
      true: 'The goal is finished: the reply hands over the result or reports a commit, release or completion, and plans or proposes no further work toward the same goal.',
      false: 'Steps toward the same goal remain: the next task of a plan, a proposed follow-up, or a review, test or decision the user still has to make.',
    },
  },
};

export function cutReply(text: string, edge = REPLY_EDGE_CHARS): string {
  return text.length <= edge * 2 ? text : `${text.slice(0, edge)}\n…\n${text.slice(-edge)}`;
}

export function jevRequest(requests: string[], lastReply: string): JevRequest {
  return {
    state: { recent_requests: requests, last_assistant_reply: cutReply(lastReply) },
    questions: { unit_done: QUESTIONS.unit_done, goal_done: QUESTIONS.goal_done },
  };
}

export function judgmentFrom(answers: Record<string, number>, config: Config): Judgment | null {
  const unit = answers.unit_done;
  if (typeof unit !== 'number') return null;
  if (unit < config.context.unitDoneYes) return { phase: 'working', clear: false };
  const goal = answers.goal_done;
  return { phase: 'unit_done', clear: typeof goal === 'number' && goal >= config.context.goalDoneYes };
}

export function hasBackgroundTasks(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}
