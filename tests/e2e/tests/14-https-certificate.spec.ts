import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';

test('Agent settings offers the public certificate download only over HTTPS', async ({ page }, testInfo) => {
  await page.goto('/#settings');
  const panel = page.locator('#tls-certificate-panel');
  if (new URL(page.url()).protocol !== 'https:') {
    await expect(panel).toBeHidden();
    return;
  }
  await expect(panel).toBeVisible();
  const downloadStarted = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download certificate (.crt)' }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe('paashup-agent.crt');
  const filename = testInfo.outputPath('paashup-agent.crt');
  await download.saveAs(filename);
  const contents = await readFile(filename, 'utf8');
  expect(contents).not.toContain('PRIVATE KEY');
  const response = await page.request.get('/api/tls/certificate');
  expect(response.ok()).toBe(true);
  expect(new X509Certificate(contents).fingerprint256).toBe(new X509Certificate(await response.body()).fingerprint256);
});
