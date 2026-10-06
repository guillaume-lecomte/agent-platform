import type { GateResult } from './baseline.js';
import type { EvalReport } from './types.js';

const pct = (n: number | undefined): string =>
  n === undefined ? 'n/a' : `${(n * 100).toFixed(1)}%`;
const signed = (n: number | undefined): string =>
  n === undefined ? 'n/a' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)} pts`;

/** Human-readable summary, used in the terminal, in CI step summaries and in PR comments. */
export function renderMarkdown(report: EvalReport, gate?: GateResult): string {
  const lines: string[] = [];
  const verdict = gate ? (gate.passed ? '✅ passed' : '❌ blocked') : '';
  lines.push(`### Evals: \`${report.agent}@${report.version}\` ${verdict}`.trimEnd(), '');
  lines.push(
    `Suite \`${report.suite.name}\` v${report.suite.version}, ${report.suite.cases} cases, ` +
      `${report.mode} mode (${report.provider}). Overall score **${pct(report.scores.overall)}**, ` +
      `${report.passedCases}/${report.suite.cases} cases fully passed.`,
    '',
  );
  if (report.simulated) {
    lines.push(
      '> Token counts and latencies come from a deterministic test double, not a real model.',
      '',
    );
  }
  if (report.skippedGraders > 0) {
    lines.push(
      `> ${report.skippedGraders} LLM-judge grader(s) skipped (no judge model in mock mode).`,
      '',
    );
  }

  if (gate) {
    lines.push(
      '| Check | Baseline | Current | Change | Allowed drop | |',
      '| --- | ---: | ---: | ---: | ---: | --- |',
    );
    for (const c of gate.checks) {
      lines.push(
        `| ${c.name} | ${pct(c.baseline)} | ${pct(c.current)} | ${signed(c.delta)} | ${pct(c.allowedDrop)} | ${c.ok ? '✅' : '❌'} |`,
      );
    }
    lines.push('');
    for (const w of gate.warnings) lines.push(`> ⚠️ ${w}`, '');
    if (gate.regressedCases.length > 0) {
      lines.push('<details><summary>Cases that regressed</summary>', '');
      for (const r of gate.regressedCases.slice(0, 25)) {
        lines.push(`- \`${r.id}\`: ${pct(r.baseline)} → ${pct(r.current)}`);
      }
      lines.push('', '</details>', '');
    }
  } else {
    lines.push('| Category | Score |', '| --- | ---: |');
    for (const [name, score] of Object.entries(report.scores.categories)) {
      lines.push(`| ${name} | ${pct(score)} |`);
    }
    lines.push('');
  }

  const failing = report.cases.filter((c) => !c.passed).slice(0, 10);
  if (failing.length > 0) {
    lines.push('<details><summary>First failing cases</summary>', '');
    for (const c of failing) {
      const why = c.graders
        .filter((g) => !g.passed && !g.skipped)
        .map((g) => `${g.type}: ${g.detail}`);
      lines.push(`- \`${c.id}\` (${pct(c.score)}): ${why.slice(0, 3).join(' · ')}`);
    }
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}
