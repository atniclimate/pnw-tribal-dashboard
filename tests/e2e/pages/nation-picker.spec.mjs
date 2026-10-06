// @ts-check
/** Real registry, real keyboard events; no weather values are supplied by these tests. */
import { test, expect } from '@playwright/test';
import { horizontalOverflow, axeProblems } from '../support/harness.mjs';

const LUMMI_ID = 'us-wa-lummi-tribe-of-the-lummi-reservation';
const LUMMI_NAME = 'Lummi Tribe of the Lummi Reservation';

/** @param {import('@playwright/test').Page} page */
async function mountPicker(page) {
  await page.goto('./dev/harness.html');
  for (const sheet of ['tokens', 'fonts', 'base', 'components', 'dashboard']) {
    await page.addStyleTag({ url: `../static/css/${sheet}.css` });
  }
  await page.evaluate(async () => {
    const modulePath = '/pnw-tribal-dashboard/static/js/ui/nation-picker.js';
    const { createNationPicker } = /** @type {typeof import('../../../site/static/js/ui/nation-picker.js')} */ (await import(modulePath));
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Open Nation Picker'; button.className = 'btn btn--primary';
    document.querySelector('#sandbox')?.append(button);
    createNationPicker(button, { onSelect(id) { document.body.dataset.selectedNation = id ?? 'regional'; } });
  });
  const trigger = page.getByRole('button', { name: 'Open Nation Picker' });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Choose a Nation' });
  const input = picker.getByRole('combobox', { name: 'Tribal Nation or First Nation' });
  return { trigger, picker, input };
}

test('region filter, keyboard selection, and recents retain full names without navigating', async ({ page }, testInfo) => {
  const { trigger, picker, input } = await mountPicker(page);
  const initialURL = page.url();
  await expect(input).toBeFocused();
  const region = picker.getByRole('combobox', { name: 'State or Province' });
  await region.selectOption('BC');
  await input.fill('Lummi');
  await expect(picker.getByRole('status')).toContainText('No matching Nations');
  await region.selectOption('WA');
  await expect(picker.getByRole('listbox').getByRole('option')).toHaveCount(1);
  await expect(picker.getByRole('option', { name: new RegExp(LUMMI_NAME) })).toBeVisible();
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', /nation-picker-\d+-0/);
  await page.screenshot({ path: testInfo.outputPath('nation-picker-filtered.png') });
  await input.press('Enter');
  await expect(picker).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator('body')).toHaveAttribute('data-selected-nation', LUMMI_ID);
  expect(page.url()).toBe(initialURL);
  await trigger.click();
  const recent = picker.getByRole('region', { name: 'Recent Choices' });
  await expect(recent.getByRole('button', { name: LUMMI_NAME, exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(region).toHaveValue('');
  expect(await horizontalOverflow(page)).toBe(false);
  expect(await axeProblems(page)).toEqual([]);
  await recent.getByRole('button', { name: 'Clear Recent Choices' }).click();
  await expect(recent).toBeHidden();
  await expect(input).toBeFocused();
  await picker.getByRole('button', { name: 'All of Cascadia', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-selected-nation', 'regional');
});

test('Escape clears search before closing the modal and returns focus', async ({ page }) => {
  const { trigger, picker, input } = await mountPicker(page);
  await input.fill('Lummi');
  await expect(picker.getByRole('listbox').getByRole('option')).toHaveCount(1);
  await input.press('Escape');
  await expect(input).toHaveValue('');
  await expect(picker).toBeVisible();
  await input.press('Escape');
  await expect(picker).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('a missing registry provides a working retry and regional escape', async ({ page }) => {
  await page.route('**/data/registry/nations-index.json', (route) => route.fulfill({ status: 404, body: '' }));
  const { picker, input } = await mountPicker(page);
  await expect(picker.getByRole('status')).toContainText('could not be loaded');
  const retry = picker.getByRole('button', { name: 'Try Loading Nations Again' });
  await expect(retry).toBeVisible();
  await expect(picker.getByRole('button', { name: 'All of Cascadia', exact: true })).toBeEnabled();
  await page.unroute('**/data/registry/nations-index.json');
  await retry.click();
  await input.fill('Lummi');
  await expect(picker.getByRole('option', { name: new RegExp(LUMMI_NAME) })).toBeVisible();
  await expect(retry).toBeHidden();
});
