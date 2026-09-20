/**
 * Real-browser end-to-end check on a disposable database, with a stubbed OpenRouter so it is
 * deterministic and needs no API key. Admin uploads two Excel files and clicks Generate; the
 * agent maps columns with "AI", escalates what it is unsure about; the consultant resolves every
 * case in the UI; the mock target ends up with every record. Screenshots go to test-results/e2e.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { createApp } from '../server/app.js';
import { seedUser } from '../server/auth.js';
import { Store } from '../server/store.js';
import { completion, fakeOpenRouter } from '../tests/helpers.js';

const PASSWORD = 'E2eTestPassword!2026';
const out = resolve('test-results/e2e');
await mkdir(out, { recursive: true });
const dir = await mkdtemp(join(tmpdir(), 'relay-e2e-'));

// A stand-in for the model: knows the columns, and is deliberately unsure about one of them.
const answers: Record<string, [string | null, number]> = {
  'Emp Code': ['employee_id', 0.97],
  'Personnel No.': ['employee_id', 0.96],
  'Nombre completo': ['full_name', 0.98],
  'E-mail (work)': ['email', 0.99],
  Mail: ['email', 0.95],
  'Org Unit': ['department', 0.92],
  'Position Held': ['job_title', 0.93],
  'Onboarding Date': ['start_date', 0.94],
  'Joined On': ['start_date', 0.95],
  'Emp Status': ['employment_status', 0.7],
  'Favourite Colour': [null, 0.98],
  'Manager Name': [null, 0.97],
};
const model = await fakeOpenRouter(({ body }) => {
  const request = JSON.parse((body.messages as { content: string }[])[1].content) as {
    source_columns: { column: string }[];
  };
  return {
    body: completion(
      request.source_columns.map(({ column }) => {
        const [target, confidence] = answers[column] ?? [null, 0.3];
        return {
          column,
          target,
          confidence,
          reason: `stubbed reasoning for ${column}`,
          alternatives: [],
        };
      }),
    ),
  };
});
process.env.OPENROUTER_BASE_URL = model.url;

const store = new Store(join(dir, 'e2e.sqlite'));
await seedUser(store, 'admin@e2e.example', 'Alex Admin', 'admin', PASSWORD);
await seedUser(store, 'ic@e2e.example', 'Sam Consultant', 'ic', PASSWORD);
let base = '';
const { app, settings } = createApp(store, () => base);
settings.saveAi(
  { model: 'stub/model:free', shareSamples: false, minConfidence: 0.85 },
  'sk-or-e2e-stub-key',
);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const problems: string[] = [];
const open = async (email: string, viewport = { width: 1440, height: 900 }) => {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on('pageerror', (e) => problems.push(`${email}: ${e.message}`));
  page.on(
    'console',
    (m) =>
      m.type() === 'error' && !/40[13]/.test(m.text()) && problems.push(`${email}: ${m.text()}`),
  );
  await page.goto(base);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  return page;
};
const noHorizontalScroll = async (page: Page, where: string) =>
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    `${where}: page scrolls horizontally`,
  );

try {
  // 1 — admin: upload, define target (default), generate
  const admin = await open('admin@e2e.example');
  await admin.getByRole('heading', { name: 'New migration' }).waitFor();
  await admin.getByText('AI mapping on').waitFor();
  await admin.setInputFiles('input[aria-label="Choose source files"]', [
    'samples/04-helix/hr-core.xlsx',
    'samples/04-helix/legacy-crm.xlsx',
  ]);
  await admin.getByText('legacy-crm.xlsx · Contacts').waitFor();
  assert.ok(await admin.getByText('2 sheets · 13 rows · 15 columns').isVisible());
  assert.ok(
    await admin.getByRole('button', { name: /^Generate/ }).isDisabled(),
    'Generate needs a migration name',
  );
  await admin.getByLabel('Migration name').fill('Helix consolidation');
  await admin.screenshot({ path: `${out}/1-composer.png`, fullPage: true });
  await noHorizontalScroll(admin, 'composer');
  await admin.getByRole('button', { name: /^Generate/ }).click();
  await admin.locator('.escalation').waitFor({ timeout: 30_000 });
  const banner = await admin.locator('.escalation').innerText();
  assert.match(banner, /Escalated to Sam Consultant/);
  assert.match(banner, /1 column the agent could not place/);
  await admin.screenshot({ path: `${out}/2-escalated.png` });

  // 2 — consultant: resolve every case in the UI
  const ic = await open('ic@e2e.example');
  await ic.getByRole('heading', { name: 'Assigned to you' }).waitFor();
  await ic.getByRole('button', { name: 'Open migration' }).first().click();
  const seen: string[] = [];
  for (let step = 0; step < 12 && seen.length < 4; step++) {
    const form = ic.locator('.review-form');
    await form.waitFor({ timeout: 15_000 });
    const kind = (await form.locator('.review-meta .badge').innerText()).trim();
    if (seen.includes(kind)) {
      await ic.waitForTimeout(300);
      continue;
    }
    seen.push(kind);
    await ic.screenshot({ path: `${out}/3-case-${seen.length}-${kind.replace(/\W+/g, '-')}.png` });
    if (kind === 'Column mapping') {
      assert.ok(await ic.locator('.ai-suggestion').isVisible(), 'the agent’s suggestion is shown');
      await ic
        .locator('#decision-reason')
        .fill('Confirmed with client: status column maps to employment status.');
      await ic.getByRole('button', { name: 'Apply mapping' }).click();
    } else if (kind === 'Ambiguous date') {
      await ic.locator('.value-option', { hasText: '2024-05-04' }).click();
      await ic
        .locator('#decision-reason')
        .fill('Client confirmed the export uses day/month order.');
      await ic.getByRole('button', { name: 'Approve value' }).click();
    } else if (kind === 'Conflict') {
      await ic.locator('.value-option', { hasText: 'Operations' }).click();
      await ic.locator('#decision-reason').fill('HR core is the system of record for departments.');
      await ic.getByRole('button', { name: 'Approve value' }).click();
    } else {
      await ic.locator('#resolution-value').fill('omar.haddad@example.com');
      await ic
        .locator('#decision-reason')
        .fill('Email supplied by the client in the onboarding ticket.');
      await ic.getByRole('button', { name: 'Save correction' }).click();
    }
    await ic.waitForTimeout(700);
  }
  assert.deepEqual(seen, ['Column mapping', 'Ambiguous date', 'Conflict', 'Validation']);
  await noHorizontalScroll(ic, 'review');

  // 3 — the agent delivered on its own; the mock target holds every record
  await admin.reload();
  await admin.locator('.history-item').first().click();
  await admin
    .locator('.status-banner strong', { hasText: 'Migration complete' })
    .waitFor({ timeout: 30_000 });
  assert.match(await admin.locator('.stats-grid').innerText(), /Delivered\s+10/);
  await admin.getByRole('tab', { name: 'Field mappings' }).click();
  assert.ok(
    (await admin.locator('.badge', { hasText: /^AI \d+%$/ }).count()) >= 9,
    'AI mappings are visible with confidence',
  );
  await admin.screenshot({ path: `${out}/4-complete-mappings.png` });
  await admin.getByRole('button', { name: /Mock target/ }).click();
  await admin.locator('.target-table tbody tr').first().waitFor();
  assert.equal(await admin.locator('.target-table tbody tr').count(), 10);
  await admin.screenshot({ path: `${out}/5-mock-target.png` });
  await admin.keyboard.press('Escape');

  // 4 — narrow screens: no horizontal scrolling on the composer or a run
  const phone = await open('admin@e2e.example', { width: 390, height: 800 });
  await phone.getByRole('heading', { name: 'New migration' }).waitFor();
  await noHorizontalScroll(phone, 'composer at 390px');
  await phone
    .locator('.history-item')
    .first()
    .click()
    .catch(() => undefined);
  await phone.screenshot({ path: `${out}/6-mobile.png` });

  assert.deepEqual(problems, [], `browser errors: ${problems.join('; ')}`);
  console.log(`✔ browser end-to-end passed (${out})`);
} catch (error) {
  console.error('✖ browser end-to-end failed:', error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await model.close();
  store.close();
  await rm(dir, { recursive: true, force: true });
}
