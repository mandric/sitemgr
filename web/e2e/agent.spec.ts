import { test, expect } from "@playwright/test";

const MAILPIT_URL = "http://127.0.0.1:54324";

interface MailpitMessage {
  ID: string;
  From: { Address: string };
  To: Array<{ Address: string }>;
  Subject: string;
  Created: string;
}

interface MailpitMessagesResponse {
  messages: MailpitMessage[];
  total: number;
}

async function getConfirmationLink(email: string): Promise<string> {
  // Wait for email to arrive in Mailpit (retry with exponential backoff)
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const response = await fetch(`${MAILPIT_URL}/api/v1/messages`);
    const data: MailpitMessagesResponse = await response.json();

    // Find confirmation email for this user
    const confirmEmail = data.messages.find(
      (msg) =>
        msg.To.some((to) => to.Address === email) &&
        msg.Subject.includes("Confirm"),
    );

    if (confirmEmail) {
      // Fetch full email content
      const msgResponse = await fetch(
        `${MAILPIT_URL}/api/v1/message/${confirmEmail.ID}`,
      );
      const msgData = await msgResponse.json();

      // Extract confirmation link from email body
      const htmlBody = msgData.HTML || "";
      const match = htmlBody.match(/href="([^"]*confirm[^"]*)"/);

      if (match && match[1]) {
        return match[1];
      }
    }

    // Wait before retrying (exponential backoff)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000 * Math.pow(2, attempts), 5000)),
    );
    attempts++;
  }

  throw new Error(
    `No confirmation email found for ${email} after ${maxAttempts} attempts`,
  );
}

// Unique email per test run to avoid conflicts on Playwright retries
const testEmail = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const testPassword = "test123";

test.describe.configure({ mode: "serial" }); // Run tests serially to share setup

test.describe("Site Manager Agent", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(60000); // 60s for signup + Mailpit email delivery
    // Create test user via signup (only once for all tests)
    const page = await browser.newPage();
    await page.goto("/auth/sign-up");

    // Fill signup form (including repeat password!)
    await page.fill('input[id="email"]', testEmail);
    await page.fill('input[id="password"]', testPassword);
    await page.fill('input[id="repeat-password"]', testPassword);
    await page.click('button[type="submit"]');

    // Wait for signup to complete
    await page
      .waitForURL("/auth/sign-up-success", { timeout: 10000 })
      .catch(() => {
        console.log("Signup may have failed - user might already exist");
      });

    // Get confirmation link from Mailpit and confirm email
    try {
      const confirmationLink = await getConfirmationLink(testEmail);
      console.log(`✓ Confirmation email received for ${testEmail}`);

      // Visit confirmation link to confirm email
      await page.goto(confirmationLink);
      console.log(`✓ Email confirmed for ${testEmail}`);
    } catch (error) {
      console.log(`Email confirmation failed: ${error}`);
      console.log("User may already be confirmed");
    }

    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    // Login for each test
    await page.goto("/auth/login");
    await page.fill('input[id="email"]', testEmail);
    await page.fill('input[id="password"]', testPassword);
    await page.click('button[type="submit"]');

    // Wait for navigation (any URL change)
    await page.waitForLoadState("networkidle");
    const currentURL = page.url();
    console.log(`Current URL after login: ${currentURL}`);

    // If we're not at /protected, we're probably still at login with an error
    if (!currentURL.includes("/protected")) {
      const errorText = await page
        .locator('p[class*="text-red"]')
        .textContent()
        .catch(() => null);
      console.log(`Login error: ${errorText || "Unknown error"}`);
    }
  });

  test("should display initial greeting", async ({ page }) => {
    await page.goto("/agent");

    // Check for page heading
    await expect(
      page.getByRole("heading", { name: /Site Manager Agent/i }),
    ).toBeVisible();

    // Check that the chat interface is present
    await expect(
      page.locator('input[placeholder="Ask me anything..."]'),
    ).toBeVisible();
  });

  test("should send message and receive response", async ({ page }) => {
    await page.goto("/agent");

    // Wait for initial greeting to load
    await page.waitForSelector(".rounded-lg.px-4.py-2", { timeout: 5000 });
    const initialMessageCount = await page
      .locator(".rounded-lg.px-4.py-2")
      .count();

    // Type a message
    await page.fill(
      'input[placeholder="Ask me anything..."]',
      "What can you help me with?",
    );
    await page.click('button[type="submit"]');

    // Wait for new messages to appear (user message + assistant response)
    await expect(page.locator(".rounded-lg.px-4.py-2")).toHaveCount(
      initialMessageCount + 2,
      { timeout: 20000 },
    );
  });

  test("should render markdown links", async ({ page }) => {
    await page.goto("/agent");

    // Ask about buckets - specifically request a link
    await page.fill(
      'input[placeholder="Ask me anything..."]',
      "Please provide a link to the buckets page",
    );
    await page.click('button[type="submit"]');

    // Wait for response
    const bucketsLink = page
      .locator(".bg-muted")
      .getByRole("link")
      .filter({ hasText: /bucket/i })
      .first();
    await expect(bucketsLink).toBeVisible({ timeout: 15000 });
    await expect(bucketsLink).toHaveAttribute("href", "/buckets");
  });

  test("should answer media library questions via tool use", async ({
    page,
  }) => {
    // This verifies the tool-use loop end-to-end: the agent must call
    // `get_stats` (or `query_media`) against real Supabase and incorporate
    // the result into its response. The test user was just created with no
    // seeded media, so the live stats call should return 0 events — the
    // assistant's reply must mention that the library is empty or contains 0.
    await page.goto("/agent");

    // Snapshot the initial message count (just the greeting).
    await page.waitForSelector(".rounded-lg.px-4.py-2", { timeout: 5000 });
    const initialMessageCount = await page
      .locator(".rounded-lg.px-4.py-2")
      .count();

    const input = page.locator('input[placeholder="Ask me anything..."]');
    await input.fill("How many media items are in my library right now?");
    await page.click('button[type="submit"]');

    // Wait for the agent to finish responding. The tool-use loop involves
    // an Anthropic round-trip plus a Supabase query, so give it up to 60s.
    // isLoading=false flips the input back to enabled, which is the cleanest
    // signal that the server action returned — avoids racing against the
    // intermediate loading-indicator .bg-muted bubble.
    await expect(input).toBeEnabled({ timeout: 60000 });

    // Two new bubbles should exist: the user's message and the assistant's reply.
    await expect(page.locator(".rounded-lg.px-4.py-2")).toHaveCount(
      initialMessageCount + 2,
      { timeout: 5000 },
    );

    // Read the latest assistant bubble (last .bg-muted on the page) and
    // assert it grounds its answer in live data. If the tool was actually
    // invoked, Claude has ground-truth data (0 events for this fresh user).
    // Accept common phrasings: "0", "zero", "empty", "no media", "don't have".
    const lastAssistantBubble = page.locator(".bg-muted").last();
    const responseText = (await lastAssistantBubble.textContent()) ?? "";
    expect(responseText).toMatch(
      /\b(0|zero|empty|no media|don't have|haven't)\b/i,
    );
  });

  test("should navigate to buckets page from agent link", async ({
    page,
  }) => {
    await page.goto("/agent");

    // Ask about buckets - specifically request a link
    await page.fill(
      'input[placeholder="Ask me anything..."]',
      "Give me a link to configure buckets",
    );
    await page.click('button[type="submit"]');

    // Wait for and click the buckets link in the assistant's response
    const bucketsLink = page
      .locator(".bg-muted")
      .getByRole("link")
      .filter({ hasText: /bucket/i })
      .first();
    await expect(bucketsLink).toBeVisible({ timeout: 15000 });
    await bucketsLink.click();

    // Verify navigation
    await expect(page).toHaveURL("/buckets");
    await expect(page.getByText(/S3 Bucket Configuration/i)).toBeVisible();
  });
});
