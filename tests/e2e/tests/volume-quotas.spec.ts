import { test, expect } from '@playwright/test';

test('named-volume form creates, resizes, displays and removes quota-managed storage', async ({ page }) => {
  let volumes: Record<string, unknown>[] = [];
  let quotaStatus = { available: true, reason: "Ext4 project quotas are enabled and accessible" };
  const writes: { method: string; data: Record<string, unknown> }[] = [];
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    let data: unknown;
    if (url.pathname === '/info') data = { docker: { Version: '29', ApiVersion: '1.54' }, dockerInfo: {}, volumeQuotas: { ...quotaStatus, capacity: { free_bytes: 6 * 1073741824, reserved_bytes: 0, available_bytes: volumes.some(v => v.max_size) ? 536870912 : 6 * 1073741824, volumes: volumes.filter(v => v.project_id).map(v => ({ name: v.Name, limit_bytes: Number(v.max_size) * 1048576, usage_bytes: v.usage_bytes })) } }, configured: 'nok', config: {}, uptime: {} };
    else if (url.pathname === '/system/usage') data = { images: { size: 0 }, containers: { size_rootfs: 0 }, volumes: 0, build_cache: 0 };
    else if (url.pathname === '/api/engine/volumes') {
      const input = request.postDataJSON().data;
      writes.push({ method: request.method(), data: input });
      if (request.method() === 'POST') volumes = [{ Name: input.name, Driver: 'local', max_size: input.max_size, usage_bytes: 1610612736, project_id: 1000000 }];
      if (request.method() === 'PUT') volumes[0].max_size = input.max_size;
      if (request.method() === 'DELETE') volumes = [];
      return route.fulfill({ status: 202, json: { data: input } });
    } else if (url.pathname === '/api/volumes') data = { Volumes: volumes, Warnings: null };
    else if (url.pathname.startsWith('/api/')) data = [];
    // Use the running agent for assets, as in the CI /e2e-only container mount.
    else return route.continue();
    return route.fulfill({ json: data });
  });
  await page.goto('/#info');
  await expect(page.locator('#info-list')).toContainText('Available — ext4 project quotas');
  await expect(page.locator('#quota-setup')).toHaveCount(0);
  quotaStatus = { available: false, reason: 'Docker volumes must reside on real ext4 mounted with prjquota' };
  await page.reload();
  await expect(page.locator('#info-list dt:has-text("Volume quotas") + dd')).toHaveText('Unavailable');
  await expect(page.getByRole('button', { name: 'Copy commands' })).toHaveCount(0);
  quotaStatus = { available: false, reason: 'Host tool findmnt is missing. On Debian/Ubuntu, run on the Docker host: sudo apt-get install util-linux' };
  await page.reload();
  await expect(page.locator('#info-list dt:has-text("Volume quotas") + dd')).toHaveText('Unavailable');
  await expect(page.locator('#info-list')).not.toContainText('sudo apt-get');
  await page.locator('#nav-volumes-btn').click();
  await page.getByRole('button', { name: 'Create volume', exact: true }).click();
  await expect(page.locator('#volume-limit')).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Type', exact: true })).toBeEnabled();
  await expect(page.locator('#volume-type')).toHaveValue('local');
  await expect(page.locator('#volume-type option')).toHaveText(['Local']);
  await expect(page.locator('#volume-limit')).toHaveValue('0');
  await expect(page.locator('#resource-hint')).toContainText('Volume quotas are unavailable');
  await expect(page.locator('#resource-data')).not.toBeVisible();
  await expect(page.locator('#resource-data')).toBeDisabled();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('unlimited');
  await page.locator('#resource-dialog').getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('#resource-dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Change limit' })).toHaveCount(0);
  expect(writes[0].data.max_size).toBe(0);
  expect(writes[0].data.driver).toBe('local');
  volumes = [];
  writes.length = 0;
  quotaStatus = { available: true, reason: 'Ext4 project quotas are enabled and accessible' };
  await page.reload();
  await page.locator('#nav-volumes-btn').click();
  await page.getByRole('button', { name: 'Create volume', exact: true }).click();
  await expect(page.locator('#volume-limit')).toBeEnabled();
  await expect(page.locator('#resource-hint')).toContainText('Available for this volume: 6 GiB');
  await expect(page.locator('#volume-limit option[value="10240"]')).toHaveJSProperty('disabled', true);
  await expect(page.locator('#volume-limit option[value="5120"]')).toHaveJSProperty('disabled', false);
  await expect(page.locator('#resource-data')).not.toBeVisible();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('my-volume');
  await page.locator('#volume-limit').selectOption('5120');
  await page.locator('#resource-dialog').getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('#volumes-list .volume-size')).toHaveText('5 GiB');
  await expect(page.locator('#volumes-list .volume-used')).toHaveText('1.5 GiB');
  await expect(page.locator('#volumes-list')).toContainText('30.0% used');
  await expect(page.getByRole('progressbar', { name: 'Storage used for my-volume' })).toHaveAttribute('value', '1610612736');
  await page.getByRole('button', { name: 'Change limit' }).click();
  await expect(page.locator('#volume-name')).toHaveValue('my-volume');
  await expect(page.locator('#volume-name')).toHaveAttribute('readonly', '');
  await expect(page.locator('#resource-hint')).toContainText('Available for this volume: 5.5 GiB');
  await expect(page.locator('#volume-limit option[value="1024"]')).toHaveJSProperty('disabled', true);
  await expect(page.locator('#volume-limit option[value="5120"]')).toHaveJSProperty('disabled', false);
  await page.locator('#volume-limit').selectOption('0');
  await page.locator('#resource-dialog').getByRole('button', { name: 'Submit' }).click();
  await expect(page.locator('#volumes-list .volume-size')).toHaveText('Unlimited');
  await expect(page.locator('#volumes-list progress')).toHaveCount(0);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#volumes-list').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('#volumes-list .card')).toHaveCount(0);
  expect(writes.map(w => [w.method, w.data.max_size])).toEqual([['POST', 5120], ['PUT', 0], ['DELETE', undefined]]);
  volumes = [
    { Name: 'ordinary', Driver: 'local', UsageData: { Size: 2621440 } },
    { Name: 'empty', Driver: 'local', UsageData: { Size: 0 } },
    { Name: 'unknown', Driver: 'plugin', UsageData: { Size: -1 } },
  ];
  await page.reload();
  const ordinary = page.locator('#volumes-list .card').filter({ has: page.getByRole('heading', { name: 'ordinary', exact: true }) });
  await expect(ordinary.locator('.volume-used')).toHaveText('2.5 MiB');
  await expect(ordinary.locator('.volume-size')).toHaveText('Unlimited');
  const empty = page.locator('#volumes-list .card').filter({ has: page.getByRole('heading', { name: 'empty', exact: true }) });
  await expect(empty.locator('.volume-used')).toHaveText('0 B');
  const unknown = page.locator('#volumes-list .card').filter({ has: page.getByRole('heading', { name: 'unknown', exact: true }) });
  await expect(unknown.locator('.volume-used')).toHaveText('Unavailable');
  await expect(unknown.locator('.volume-size')).toHaveText('Not reported');
});
