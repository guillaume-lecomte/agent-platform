#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { baselineFromReport, writeBaseline } from '../baseline.js';
import { evalsDir, evaluateVersion } from '../evaluate.js';

const USAGE = `Usage:
  evals run --agent <id> --version <vN> [--baseline <path>|none] [--out <dir>]
            [--summary-file <path>] [--max-overall-drop <n>] [--max-category-drop <n>]
  evals baseline --agent <id> --version <vN>      Record the current scores as the baseline

Exit code 1 when the baseline gate fails.`;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      version: { type: 'string' },
      baseline: { type: 'string' },
      out: { type: 'string' },
      'summary-file': { type: 'string' },
      'max-overall-drop': { type: 'string' },
      'max-category-drop': { type: 'string' },
    },
  });
  const command = positionals[0];
  if (!command || !values.agent || !values.version) {
    console.error(USAGE);
    return 2;
  }

  if (command === 'baseline') {
    const { report } = await evaluateVersion({
      agentId: values.agent,
      version: values.version,
      baselinePath: 'none',
    });
    const path = join(evalsDir(values.agent), 'baseline.json');
    await writeBaseline(path, baselineFromReport(report));
    console.log(
      `Baseline written to ${path} (${report.agent}@${report.version}, overall ${report.scores.overall})`,
    );
    return 0;
  }

  if (command === 'run') {
    const result = await evaluateVersion({
      agentId: values.agent,
      version: values.version,
      baselinePath: values.baseline,
      outDir: values.out,
      gateOverrides: {
        ...(values['max-overall-drop']
          ? { max_overall_drop: Number(values['max-overall-drop']) }
          : {}),
        ...(values['max-category-drop']
          ? { max_category_drop: Number(values['max-category-drop']) }
          : {}),
      },
    });
    console.log(result.markdown);
    console.log(`\nReport: ${result.reportPaths.json}`);
    if (values['summary-file']) {
      await mkdir(dirname(values['summary-file']), { recursive: true });
      await writeFile(values['summary-file'], result.markdown + '\n');
    }
    if (result.gate && !result.gate.passed) {
      console.error('\nGate FAILED: the score dropped beyond the allowed threshold.');
      return 1;
    }
    if (!result.gate) console.error('\nNo baseline found: nothing to compare against.');
    return 0;
  }

  console.error(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
