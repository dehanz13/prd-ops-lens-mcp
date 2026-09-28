import { z } from 'zod';

const source = z.strictObject({
  tool: z.enum(['loki_logs', 'uptime_status', 'cloudwatch_alarms', 'cloudwatch_logs_insights',
    'posthog_error_issues', 'prometheus_range', 'cloudwatch_metric_data']),
  provider: z.string().min(1), query: z.string().min(1), data: z.unknown(),
});
export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/), fault: z.string().min(1),
  marker: z.string().min(1), keySource: z.number().int().nonnegative(),
  shapeSource: z.string().min(1), sources: z.array(source).min(1).max(8),
});
export const suiteSchema = z.strictObject({ version: z.literal(1), note: z.string().min(1),
  cases: z.array(scenarioSchema).min(8).max(12) });
export type Scenario = z.output<typeof scenarioSchema>;

type TimelineData = { events?: Array<{ summary?: string; citations?: Array<{
  tool?: string; examined?: { query?: string; window?: { from?: string; to?: string } } }> }> };

export function evidenceScore(result: unknown, scenario: Scenario): boolean {
  if (!result || typeof result !== 'object') return false;
  const data = (result as { data?: TimelineData }).data;
  const key = scenario.sources[scenario.keySource];
  if (!key || !Array.isArray(data?.events)) return false;
  return data.events.some((event) => event.summary?.includes(scenario.marker) &&
    event.citations?.some((citation) => citation.tool === key.tool &&
      citation.examined?.query === key.query &&
      Boolean(citation.examined.window?.from && citation.examined.window?.to)));
}

export function positiveControlScore(result: { isError?: boolean | undefined; structuredContent?: unknown },
  scenario: Scenario): boolean {
  if (result.isError || !result.structuredContent || typeof result.structuredContent !== 'object') return false;
  const data = (result.structuredContent as { data?: TimelineData }).data;
  return Array.isArray(data?.events) && !evidenceScore(result.structuredContent, scenario);
}
