import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Check } from './evaluate';

/**
 * summary.json as a CSV, one row per check, so a run can be filtered and pivoted in a spreadsheet:
 *
 *   pnpm tsx simulator/to-csv.ts results/<run>/summary.json    # writes results/<run>/summary.csv
 */
interface SummaryRow {
  test_id: string;
  category: string;
  ended_by: string;
  error?: string;
  customer_turns: number;
  checks: Check[];
}

const COLUMNS = ['test_id', 'category', 'scenario_verdict', 'ended_by', 'customer_turns', 'checks_passed', 'check', 'check_pass', 'detail'];

export function summaryCsv(results: SummaryRow[]): string {
  const rows = results.flatMap((r) => {
    const passed = r.checks.filter((c) => c.pass).length;
    const verdict = r.ended_by === 'error' || passed < r.checks.length ? 'FAIL' : 'PASS';
    const scenario = [r.test_id, r.category, verdict, r.ended_by, r.customer_turns, `${passed}/${r.checks.length}`];
    const checks = r.error ? [...r.checks, { name: 'error', pass: false, detail: r.error }] : r.checks;
    return checks.map((c) => [...scenario, c.name, c.pass ? 'PASS' : 'FAIL', c.detail]);
  });
  return [COLUMNS, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

function cell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

if (process.argv[1]?.endsWith('to-csv.ts')) {
  const file = process.argv[2];
  if (!file) throw new Error('usage: tsx simulator/to-csv.ts results/<run>/summary.json');
  const { results } = JSON.parse(await readFile(file, 'utf8')) as { results: SummaryRow[] };
  const out = path.join(path.dirname(file), 'summary.csv');
  await writeFile(out, summaryCsv(results));
  console.log(`wrote ${out}`);
}
