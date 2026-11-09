import { expect, test, type Page } from '@playwright/test';

const EMAIL = 'admin@demo.lumio.local';
const PASSWORD = 'demo-only-change-me';
const suffix = Date.now().toString().slice(-6);

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Dashboard/ })).toBeVisible();
}

test('redirects anonymous users to sign in, and refuses a wrong password', async ({ page }) => {
  await page.goto('/stock');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect');
});

test('every navigation page loads without an error', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`${page.url()}: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 500) problems.push(`${response.status()} ${response.url()}`);
  });
  await signIn(page);
  const links = await page.getByRole('navigation', { name: 'Main' }).getByRole('link').all();
  expect(links.length).toBeGreaterThan(25);
  const hrefs = await Promise.all(links.map((link) => link.getAttribute('href')));
  for (const href of hrefs) {
    await page.goto(href as string);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('alert'), `alert on ${href}`).toHaveCount(0);
  }
  expect(problems).toEqual([]);
});

test('switches theme, and shows the demo banner', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('Demo company')).toBeVisible();
  await page.getByRole('button', { name: /Switch to/ }).click();
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  await page.getByRole('button', { name: /Switch to/ }).click();
  const after = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  expect(dark).not.toBe(after);
});

async function newRecord(page: Page, path: string, fill: (page: Page) => Promise<void>) {
  await page.goto(path);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await fill(page);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('buy gold, sell it, take payment, and see it in the books', async ({ page }) => {
  await signIn(page);
  const dialog = page.getByRole('dialog');
  const product = `E2E Bar ${suffix}`;
  const customer = `E2E Customer ${suffix}`;
  const supplier = `E2E Supplier ${suffix}`;
  const purity = `22K ${suffix}`;

  await newRecord(page, '/purities', async () => {
    await dialog.getByLabel('Code').fill(`P${suffix}`);
    await dialog.getByLabel('Label').fill(purity);
    await dialog.getByLabel('Fineness').fill('0.9160');
  });
  await newRecord(page, '/products', async () => {
    await dialog.getByLabel('SKU').fill(`SKU${suffix}`);
    await dialog.getByLabel('Name').fill(product);
    await dialog.getByLabel('Category').selectOption('BAR');
    await dialog.getByLabel('Purity').selectOption({ label: `P${suffix} ${purity}` });
    await dialog.getByLabel('Tracking').selectOption('LOT');
  });
  await newRecord(page, '/customers', async () => {
    await dialog.getByLabel('Code').fill(`C${suffix}`);
    await dialog.getByLabel('Name', { exact: true }).fill(customer);
  });
  await newRecord(page, '/suppliers', async () => {
    await dialog.getByLabel('Code').fill(`S${suffix}`);
    await dialog.getByLabel('Name', { exact: true }).fill(supplier);
  });
  await newRecord(page, '/tax-codes', async () => {
    await dialog.getByLabel('Code').fill(`T${suffix}`);
    await dialog.getByLabel('Name').fill('Test standard');
    await dialog.getByLabel('Rate %').fill('5');
    await dialog.getByLabel('Treatment').selectOption('STANDARD');
  });
  await newRecord(page, '/tax-rules', async () => {
    await dialog.getByLabel('Name').fill(`Rule ${suffix}`);
    await dialog.getByLabel('Priority').fill('100');
    await dialog.getByLabel('Tax code').selectOption({ label: `T${suffix} Test standard` });
    await dialog.getByLabel('Direction').selectOption('ANY');
  });

  await page.goto('/gold-rates');
  await page.getByRole('button', { name: 'Enter rate' }).click();
  await dialog.getByLabel('Value').fill('400.0000');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  const trade = async (route: string, party: string, label: string, gross: string) => {
    await page.goto(`${route}/new`);
    await page
      .locator('label')
      .filter({ hasText: new RegExp(`^${label}Select`) })
      .locator('select')
      .selectOption({ label: party });
    await page.getByLabel('Product').selectOption({ label: `SKU${suffix} ${product}` });
    await page.getByLabel('Warehouse').selectOption({ label: 'Main vault' });
    await page.getByLabel('Gross g').fill(gross);
    await page.getByRole('button', { name: 'Calculate' }).click();
    await expect(page.getByText('Server calculation')).toBeVisible();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByRole('button', { name: 'Post', exact: true })).toBeVisible();
    page.once('dialog', (confirm) => void confirm.accept());
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page.getByText('posted', { exact: true })).toBeVisible();
  };
  await trade('/purchases', supplier, 'Supplier', '100.000');
  await trade('/sales', customer, 'Customer', '10.000');
  await expect(page.getByText('3,847.20').first()).toBeVisible();

  await page.goto('/stock');
  const row = page.getByRole('row', { name: new RegExp(product) });
  await expect(row).toContainText('90.000 g');

  await page.goto('/payments');
  await page.getByRole('button', { name: 'New payment' }).click();
  await dialog.getByLabel('Party').selectOption({ label: customer });
  await dialog.getByLabel('Amount', { exact: true }).fill('1000.00');
  await dialog.getByLabel('Account').selectOption({ label: 'Cash on hand' });
  await dialog.getByLabel('Method').selectOption({ label: 'Cash' });
  await dialog.getByLabel(/Allocate to/).fill('1000.00');
  await dialog.getByRole('button', { name: 'Post' }).click();
  await expect(dialog).toHaveCount(0);

  await page.goto('/statements');
  await expect(page.getByRole('cell', { name: 'Gold sales' })).toBeVisible();
  await page.getByLabel('Statement').selectOption('balance-sheet');
  await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.goto('/reports');
  await expect(page.getByRole('cell').first()).toBeVisible();
});

test('attach a document, screen a party, and reach the banking and filing pages', async ({
  page,
}) => {
  await signIn(page);
  const dialog = page.getByRole('dialog');
  const listed = `Zoltan Vexmoor ${suffix}`;

  await page.goto('/compliance/sanctions');
  await page.getByLabel('Format').selectOption('CSV');
  await page.getByLabel('List name').fill(`E2E${suffix}`);
  await page.getByLabel('List file').setInputFiles({
    name: 'list.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`externalId,name,aliases,type\nE${suffix},${listed},,INDIVIDUAL\n`),
  });
  await expect(page.getByText(/Imported 1 entries/)).toBeVisible();

  await newRecord(page, '/customers', async () => {
    await dialog.getByLabel('Code').fill(`Z${suffix}`);
    await dialog.getByLabel('Name', { exact: true }).fill(listed);
  });
  await page.goto('/compliance/sanctions');
  await expect(page.getByRole('cell', { name: listed }).first()).toBeVisible();

  await page.goto('/documents');
  await page.getByLabel('Record').selectOption({ label: `Z${suffix} ${listed}` });
  await page.getByLabel(/^File/).setInputFiles({
    name: 'licence.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nE2E\n%%EOF'),
  });
  await expect(page.getByRole('cell', { name: 'licence.pdf' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).first().click();
  expect((await download).suggestedFilename()).toBe('licence.pdf');

  await page.goto('/bank-reconciliation');
  await expect(page.getByLabel('Bank account')).toHaveValue(/.+/);
  await page.getByLabel('Dates in the file are').selectOption('YMD');
  await page.getByLabel('Statement file (CSV)').setInputFiles({
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `Date,Description,Amount\n2026-11-01,E2E ${suffix},-${suffix.slice(0, 2)}.50\n`,
    ),
  });
  await expect(page.getByRole('cell', { name: `E2E ${suffix}` })).toBeVisible();
});
