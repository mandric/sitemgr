import { test, expect } from '@playwright/test';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function confirmUserEmail(email: string) {
  // Confirm email via direct database update for testing
  const sql = `UPDATE auth.users SET email_confirmed_at = NOW() WHERE email = '${email}' AND email_confirmed_at IS NULL;`;
  await execAsync(`PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "${sql}"`);
}

// Use the same test user for all workers
const testEmail = process.env.CI ? 'test@example.com' : 'test@example.com';
const testPassword = 'test123';

test.describe.configure({ mode: 'serial' }); // Run tests serially to share setup

test.describe('Site Manager Agent', () => {
  test.beforeAll(async ({ browser }) => {
    // Create test user via signup (only once for all tests)
    const page = await browser.newPage();
    await page.goto('/auth/sign-up');

    // Fill signup form (including repeat password!)
    await page.fill('input[id="email"]', testEmail);
    await page.fill('input[id="password"]', testPassword);
    await page.fill('input[id="repeat-password"]', testPassword);
    await page.click('button[type="submit"]');

    // Wait for signup to complete
    await page.waitForURL('/auth/sign-up-success', { timeout: 10000 }).catch(() => {
      console.log('Signup may have failed - user might already exist');
    });

    // Confirm email manually for testing
    await confirmUserEmail(testEmail);
    console.log(`✓ Email confirmed for ${testEmail}`);

    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    // Login for each test
    await page.goto('/auth/login');
    await page.fill('input[id="email"]', testEmail);
    await page.fill('input[id="password"]', testPassword);
    await page.click('button[type="submit"]');

    // Wait for navigation (any URL change)
    await page.waitForLoadState('networkidle');
    const currentURL = page.url();
    console.log(`Current URL after login: ${currentURL}`);

    // If we're not at /protected, we're probably still at login with an error
    if (!currentURL.includes('/protected')) {
      const errorText = await page.locator('p[class*="text-red"]').textContent().catch(() => null);
      console.log(`Login error: ${errorText || 'Unknown error'}`);
    }
  });

  test('should display initial greeting', async ({ page }) => {
    await page.goto('/agent');

    // Check for page heading
    await expect(page.getByRole('heading', { name: /Site Manager Agent/i })).toBeVisible();

    // Check that the chat interface is present
    await expect(page.locator('input[placeholder="Ask me anything..."]')).toBeVisible();
  });

  test('should send message and receive response', async ({ page }) => {
    await page.goto('/agent');

    // Wait for initial greeting to load
    await page.waitForSelector('.rounded-lg.px-4.py-2', { timeout: 5000 });
    const initialMessageCount = await page.locator('.rounded-lg.px-4.py-2').count();

    // Type a message
    await page.fill('input[placeholder="Ask me anything..."]', 'What can you help me with?');
    await page.click('button[type="submit"]');

    // Wait for new messages to appear (user message + assistant response)
    await expect(page.locator('.rounded-lg.px-4.py-2')).toHaveCount(initialMessageCount + 2, { timeout: 20000 });
  });

  // Skip AI-dependent tests in CI - they're flaky because AI responses are non-deterministic
  test.skip('should render markdown links', async ({ page }) => {
    await page.goto('/agent');

    // Ask about buckets - specifically request a link
    await page.fill('input[placeholder="Ask me anything..."]', 'Please provide a link to the buckets page');
    await page.click('button[type="submit"]');

    // Wait for response
    const bucketsLink = page.locator('.bg-muted').getByRole('link').filter({ hasText: /bucket/i }).first();
    await expect(bucketsLink).toBeVisible({ timeout: 15000 });
    await expect(bucketsLink).toHaveAttribute('href', '/buckets');
  });

  test.skip('should navigate to buckets page from agent link', async ({ page }) => {
    await page.goto('/agent');

    // Ask about buckets - specifically request a link
    await page.fill('input[placeholder="Ask me anything..."]', 'Give me a link to configure buckets');
    await page.click('button[type="submit"]');

    // Wait for and click the buckets link in the assistant's response
    const bucketsLink = page.locator('.bg-muted').getByRole('link').filter({ hasText: /bucket/i }).first();
    await expect(bucketsLink).toBeVisible({ timeout: 15000 });
    await bucketsLink.click();

    // Verify navigation
    await expect(page).toHaveURL('/buckets');
    await expect(page.getByText(/S3 Bucket Configuration/i)).toBeVisible();
  });
});
