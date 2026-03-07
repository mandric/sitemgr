import { test, expect } from '@playwright/test';

test.describe('Site Manager Agent', () => {
  const testEmail = process.env.CI ? 'test@example.com' : 'foo@bar.com';
  const testPassword = 'test123';

  test.beforeEach(async ({ page }) => {
    // Login first
    await page.goto('/auth/login');
    await page.fill('input[name="email"]', testEmail);
    await page.fill('input[name="password"]', testPassword);
    await page.click('button[type="submit"]');

    // Wait for redirect after login
    await page.waitForURL('/', { timeout: 5000 }).catch(() => {
      // If redirect fails, we might already be logged in
      console.log('Already logged in or redirect not needed');
    });
  });

  test('should display initial greeting', async ({ page }) => {
    await page.goto('/agent');

    // Check for initial message
    await expect(page.getByText(/Site Manager agent/i)).toBeVisible();
  });

  test('should send message and receive response', async ({ page }) => {
    await page.goto('/agent');

    // Type a message
    await page.fill('input[placeholder="Ask me anything..."]', 'What can you help me with?');
    await page.click('button[type="submit"]');

    // Wait for response
    await expect(page.getByText(/buckets/i)).toBeVisible({ timeout: 10000 });
  });

  test('should render markdown links', async ({ page }) => {
    await page.goto('/agent');

    // Ask about buckets
    await page.fill('input[placeholder="Ask me anything..."]', 'How do I add a bucket?');
    await page.click('button[type="submit"]');

    // Check for clickable link
    const bucketsLink = page.getByRole('link', { name: /buckets/i });
    await expect(bucketsLink).toBeVisible({ timeout: 10000 });
    await expect(bucketsLink).toHaveAttribute('href', '/buckets');
  });

  test('should navigate to buckets page from agent link', async ({ page }) => {
    await page.goto('/agent');

    // Ask about buckets
    await page.fill('input[placeholder="Ask me anything..."]', 'How do I configure a bucket?');
    await page.click('button[type="submit"]');

    // Click the buckets link
    await page.getByRole('link', { name: /buckets/i }).click();

    // Verify navigation
    await expect(page).toHaveURL('/buckets');
    await expect(page.getByText(/S3 Bucket Configuration/i)).toBeVisible();
  });
});
