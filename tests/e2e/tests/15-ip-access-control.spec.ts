import { test, expect } from '@playwright/test';

test('Agent settings validates, saves and reloads IP access rules', async ({ page }) => {
  const previous = await (await page.request.get('/admin/access-control')).json();
  try {
    await page.goto('/#settings');
    await expect(page.locator('#access-current-ip')).toContainText(previous.current_ip);
    await expect(page.locator('#learn-registration-ip')).toHaveCount(0);
    await page.locator('#ip-filtering').check();
    await page.locator('#allowed-ips').fill('not-an-ip');
    await page.getByRole('button', { name: 'Save access rules' }).click();
    await expect(page.locator('#access-message')).toContainText('Invalid allowed IP');
    await page.locator('#allowed-ips').fill('');
    await page.getByRole('button', { name: 'Add my current IP' }).click();
    await expect(page.locator('#allowed-ips')).toHaveValue(previous.current_ip);
    await page.getByRole('button', { name: 'Save access rules' }).click();
    await expect(page.locator('#access-message')).toHaveText('Access rules saved.');
    await page.reload();
    await expect(page.locator('#access-current-ip')).toContainText(previous.current_ip);
    await expect(page.locator('#ip-filtering')).toBeChecked();
    await expect(page.locator('#allowed-ips')).toHaveValue(previous.current_ip);
    await page.locator('#ip-filtering').uncheck();
    await page.getByRole('button', { name: 'Save access rules' }).click();
    await expect(page.locator('#access-message')).toHaveText('Access rules saved.');
  } finally {
    const restored = await page.request.put('/admin/access-control', { data: previous });
    expect(restored.ok()).toBe(true);
  }
});
