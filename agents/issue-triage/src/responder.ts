import type { MockReply, MockResponder, Message } from '@agent-platform/core';

/**
 * Stand-in for an LLM in mock mode. It is a test double, not a measurement of any model: it reads the
 * system prompt for a few instructions and behaves as a model that follows them would.
 *
 *   "Search for similar issues first"  -> searches before deciding
 *   the "P0: ... P3:" rubric           -> derives the priority from the issue, otherwise P2
 *   "ask for reproduction steps"       -> asks for missing information in bug comments
 *   "area:" labels                     -> adds area labels
 *
 * `mock-small` only reads the title and the first 160 characters of the body; `mock-large` reads it all
 * (see ADR 0007).
 */

type Category = 'bug' | 'feature' | 'question' | 'duplicate';
type Priority = 'P0' | 'P1' | 'P2' | 'P3';

interface PromptFlags {
  search: boolean;
  rubric: boolean;
  askInfo: boolean;
  areaLabels: boolean;
}

function readFlags(system: string): PromptFlags {
  return {
    search: /search for similar issues first/i.test(system),
    rubric: /P0:.*P3:/is.test(system),
    askInfo: /ask for reproduction steps/i.test(system),
    areaLabels: /area:/i.test(system),
  };
}

interface ParsedIssue {
  number: number;
  title: string;
  body: string;
}

function parseIssue(userMessage: string): ParsedIssue {
  const m = /^Issue #(\d+)\nTitle: (.*)\n\n([\s\S]*)$/.exec(userMessage);
  return { number: Number(m?.[1] ?? 0), title: m?.[2] ?? userMessage, body: m?.[3] ?? '' };
}

const QUESTION_TITLE =
  /^(how (do|can|to|should)|is it possible|what('s| is)|where (are|is|do)|can i|does (the|it|tasklane)|do i|why does)\b/i;
const FEATURE =
  /\b(please add|add support|would be nice|feature request|ability to|allow |support (for|sso)|provide an|official|it would be great|integration|option|export .* as|(add|offer) a )/i;
const BUG =
  /\b(crash\w*|error\w*|exception\w*|fail\w*|broken|regression\w*|does nothing|not working|doesn'?t work|wrong|incorrect|500|502|overflow\w*|cut off|typo|shift\w*|forced logout|silently|dropped|leak\w*|hang\w*|freez\w*|cannot|can'?t|unable|slow|takes \d+|intermittent|deletes?|unescaped|xss)\b/i;

function classify(text: string, title: string): 'bug' | 'feature' | 'question' {
  if (QUESTION_TITLE.test(title) || /\?\s*$/.test(title)) return 'question';
  const feature = FEATURE.test(title) ? 2 : FEATURE.test(text) ? 1 : 0;
  const bug = BUG.test(title) ? 2 : BUG.test(text) ? 1 : 0;
  if (feature > bug) return 'feature';
  if (bug > 0) return 'bug';
  return feature > 0 ? 'feature' : 'question';
}

function prioritize(
  category: Category,
  text: string,
  flags: PromptFlags,
  small: boolean,
): Priority {
  if (!flags.rubric) return 'P2';
  if (category === 'question' || category === 'duplicate') return 'P3';
  // The small model skims: it only has the title to go on.
  const t = small ? (text.split('\n\n')[0] ?? text) : text;
  if (
    /\b(data loss|permanently|deletes? .*(tasks|data|project)|crash(es)? on startup|won'?t start|all users|production|xss|vulnerab|injection|credential|cve)\b/i.test(
      t,
    )
  ) {
    return 'P0';
  }
  if (
    /\b(typo|cosmetic|tooltip|overflow|cut off|narrow|colou?r|compact|theme|markdown|translation|alignment)\b/i.test(
      t,
    )
  ) {
    return 'P3';
  }
  if (category === 'bug') {
    if (/\bworkaround\b/i.test(t)) return 'P2';
    if (
      /\b(cannot|can'?t|unable|fails?|does nothing|forced logout|502|silently|invalid token)\b/i.test(
        t,
      )
    )
      return 'P1';
  }
  return 'P2';
}

function areaLabels(text: string): string[] {
  const out: string[] = [];
  const add = (label: string, re: RegExp): void => {
    if (re.test(text)) out.push(label);
  };
  add('area:auth', /\b(login|log in|password|oauth|token|sso|saml|logout|session)\b/i);
  add(
    'area:ui',
    /\b(button|css|layout|dark|theme|tooltip|progress bar|sidebar|screen|view|translation|chart)\b/i,
  );
  add('area:api', /\b(api|endpoint|rest|502|openapi|\/api)\b/i);
  add('area:docs', /\b(docs?|documentation|readme)\b/i);
  add('area:performance', /\b(slow|memory|latency|takes \d+|performance)\b/i);
  add('security', /\b(xss|vulnerab|injection|cve|unescaped)\b/i);
  return out;
}

const CATEGORY_LABEL: Record<Category, string> = {
  bug: 'bug',
  feature: 'enhancement',
  question: 'question',
  duplicate: 'duplicate',
};

function comment(
  category: Category,
  priority: Priority,
  issue: ParsedIssue,
  duplicateOf: number | null,
  flags: PromptFlags,
): string {
  if (!flags.askInfo && !flags.rubric) return 'Thanks for your report!';
  switch (category) {
    case 'duplicate':
      return `Thanks for the report! This looks like a duplicate of #${duplicateOf}, so I'm linking the two. Please follow that issue for updates.`;
    case 'feature':
      return "Thanks for the suggestion! I've labeled this as an enhancement so it can be considered for the roadmap.";
    case 'question':
      return "Thanks for asking! Please check the documentation first, and let us know if it doesn't answer your question.";
    case 'bug': {
      const missing = !/steps to reproduce|reproduce|how to reproduce|version/i.test(issue.body);
      return flags.askInfo && missing
        ? 'Thanks for the report! Could you share the steps to reproduce the problem and the Tasklane version you are running? That will help us confirm the issue.'
        : `Thanks for the detailed report! I've labeled this as a bug (priority ${priority}) and we will investigate.`;
    }
  }
}

interface SearchResult {
  number: number;
  similarity: number;
}

function lastSearch(messages: Message[]): SearchResult | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'tool' && m.name === 'search_similar_issues' && !m.isError) {
      try {
        const parsed = JSON.parse(m.content) as { results?: SearchResult[] };
        return parsed.results?.[0];
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export const DUPLICATE_THRESHOLD = 0.5;

export const issueTriageResponder: MockResponder = ({ model, messages }): MockReply => {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const userMessage = messages.find((m) => m.role === 'user')?.content ?? '';
  const flags = readFlags(system);
  const small = /small/i.test(model);
  const issue = parseIssue(userMessage);
  const visibleBody = small ? issue.body.slice(0, 160) : issue.body;
  const text = `${issue.title}\n\n${visibleBody}`;

  const results = messages.filter((m) => m.role === 'tool');
  const done = (name: string): boolean => results.some((m) => m.role === 'tool' && m.name === name);

  if (flags.search && !done('search_similar_issues')) {
    return { toolCalls: [{ name: 'search_similar_issues', arguments: { query: issue.title } }] };
  }

  const top = flags.search ? lastSearch(messages) : undefined;
  const isDuplicate = top !== undefined && top.similarity >= DUPLICATE_THRESHOLD;
  const category: Category = isDuplicate ? 'duplicate' : classify(text, issue.title);
  const duplicateOf = isDuplicate ? top.number : null;
  const priority = prioritize(category, text, flags, small);
  const labels = [
    CATEGORY_LABEL[category],
    ...(flags.rubric ? [`priority:${priority}`] : []),
    ...(flags.areaLabels && !small ? areaLabels(text) : []),
  ];

  if (!done('add_labels')) {
    return {
      toolCalls: [{ name: 'add_labels', arguments: { issue_number: issue.number, labels } }],
    };
  }
  const body = comment(category, priority, issue, duplicateOf, flags);
  if (!done('post_comment')) {
    return {
      toolCalls: [{ name: 'post_comment', arguments: { issue_number: issue.number, body } }],
    };
  }
  return {
    content: JSON.stringify({
      category,
      priority,
      labels,
      duplicate_of: duplicateOf,
      comment: body,
    }),
  };
};
