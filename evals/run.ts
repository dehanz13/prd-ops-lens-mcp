import { ToolResultSchema } from '../src/core/result.js';

// Foundation replay: a zero-row answer still needs a provider, query, and window.
const answer = {
  data: { errors: 0 },
  examined: {
    provider: 'synthetic',
    query: 'errors for service-a',
    window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T01:00:00.000Z' },
    rowCount: 0,
    byteCount: 0,
    lineCount: 0,
    truncated: false,
    warnings: [],
  },
};

function citesEvidence(value: unknown): boolean {
  const parsed = ToolResultSchema.safeParse(value);
  return parsed.success && parsed.data.examined.window !== null &&
    parsed.data.examined.query.length > 0;
}

const positive = citesEvidence(answer);
const removedEvidence = { ...answer, examined: { ...answer.examined, query: '' } };
const negativeControl = !citesEvidence(removedEvidence);
const report = { suite: 'foundation-replay', scenarios: 1, evidencePassed: Number(positive), positiveControlsPassed: Number(negativeControl) };
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!positive || !negativeControl) process.exitCode = 1;
