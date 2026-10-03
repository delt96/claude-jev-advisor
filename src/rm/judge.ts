import path from 'node:path';
import type { Lang } from '../config-shape.js';
import type { JevQuestion, JevRequest } from '../jev.js';
import type { Candidate, TargetFacts } from './facts.js';

export type JudgedTarget = { path: string; shown: string; kind: Candidate; p: number | null };

export const CALL_EXCERPT_CHARS = 600;
export const SAMPLE_FILES = 10;

export const RM_QUESTIONS: Record<Candidate, JevQuestion> = {
  session: {
    type: 'noul',
    instructions:
      'Is `target` a throwaway file or folder that Claude made during this session only to try something out, so that deleting it with `command` loses nothing the user wants? `created_by` lists the tool calls of this session that name it; `git` says it is not tracked by git.',
    criteria: {
      true: [
        'A scratch or probe file for a one-off check: captured output, a dump or log, a quick test script, a sample input made up for a trial.',
        'Nothing in the tool calls treats it as part of the work the user asked for.',
      ],
      false: [
        'Part of the work: source code, tests in the project test folders, documentation, configuration, migrations, or data or output the user asked for.',
        'It is unclear what it is for, or it may still be wanted.',
      ],
    },
  },
  ignored: {
    type: 'noul',
    instructions:
      'Is `target` a folder of generated output or cache that a build, install or tool run makes again, so that deleting it with `command` loses nothing? `git` says git ignores it; `sample` lists some of its entries.',
    criteria: {
      true: 'Build output, compiled files, bundles, a dependency or package cache, test or coverage output, or a tool cache that is recreated on the next run.',
      false: 'Hand-made or downloaded content, user data, local configuration, secrets, logs worth keeping, or anything that cannot simply be made again; or it is unclear.',
    },
  },
};

const PASS: Record<Lang, Record<Candidate | 'mixed', string>> = {
  ko: {
    session: 'Jev가 이 세션의 시험 파일로 판단해 묻지 않고 지웁니다',
    ignored: 'Jev가 다시 만들 수 있는 폴더로 판단해 묻지 않고 지웁니다',
    mixed: 'Jev가 지워도 되는 대상으로 판단해 묻지 않고 지웁니다',
  },
  en: {
    session: 'Jev judged it a throwaway test file of this session, so it is deleted without asking',
    ignored: 'Jev judged it a folder that is made again, so it is deleted without asking',
    mixed: 'Jev judged these safe to delete, so they are deleted without asking',
  },
};

const NOTE: Record<Lang, Record<Candidate | 'none', string>> = {
  ko: { session: '시험용 파일일 확률', ignored: '다시 만들 수 있을 확률', none: '판단 못 함' },
  en: { session: 'chance it is a test file', ignored: 'chance it can be made again', none: 'no answer' },
};

export function rmJevRequest(kind: Candidate, facts: TargetFacts, command: string, description: string): JevRequest {
  const target: Record<string, unknown> = { path: facts.path, kind: facts.folder ? 'folder' : 'file' };
  if (facts.listing) {
    target.files = facts.listing.more ? `more than ${facts.listing.entries.length}` : facts.listing.entries.length;
    target.sample = facts.listing.entries.slice(0, SAMPLE_FILES).map((e) => e.name);
  }
  const state: Record<string, unknown> = { target, command, description };
  if (kind === 'session') {
    state.created_by = facts.createdBy.map((c) => ({ tool: c.tool, input: (c.file ? `${c.file}\n${c.text}` : c.text).slice(0, CALL_EXCERPT_CHARS) }));
    state.git = 'untracked';
  } else {
    state.git = 'ignored';
  }
  return { state, questions: { ok: RM_QUESTIONS[kind] } };
}

const name = (item: JudgedTarget) => path.win32.basename(item.path);
const prob = (p: number) => p.toFixed(2);

export function lifts(items: JudgedTarget[], threshold: number): boolean {
  return items.length > 0 && items.every((item) => item.p !== null && item.p >= threshold);
}

export function passMessage(lang: Lang, items: JudgedTarget[]): string {
  const kinds = new Set(items.map((i) => i.kind));
  const phrase = PASS[lang][kinds.size === 1 ? items[0].kind : 'mixed'];
  return `[jev-advisor] ${phrase}: ${items.map((i) => `${name(i)} (${prob(i.p ?? 0)})`).join(', ')}`;
}

export function askNote(lang: Lang, items: JudgedTarget[]): string {
  if (items.length === 1) {
    const [item] = items;
    return ` · Jev: ${item.p === null ? NOTE[lang].none : `${NOTE[lang][item.kind]} ${prob(item.p)}`}`;
  }
  return ` · Jev: ${items.map((i) => `${name(i)} ${i.p === null ? '?' : prob(i.p)}`).join(', ')}`;
}
