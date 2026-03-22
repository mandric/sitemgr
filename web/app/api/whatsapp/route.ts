/**
 * WhatsApp webhook handler (Twilio)
 * Migrated from Supabase Edge Function to Vercel API route.
 *
 * Flow: receive Twilio webhook → plan (Claude) → execute (Postgres) → summarize (Claude) → reply via Twilio
 */

import { NextRequest, NextResponse } from "next/server";
import {
  planAction,
  executeAction,
  summarizeResult,
  getConversationHistory,
  saveConversationHistory,
  resolveUserId,
} from "@/lib/agent/core";
import { getAdminClient } from "@/lib/media/db";

// TEMPORARY: Section 04 replaces this with webhook service account
function createWebhookClient() {
  return getAdminClient({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  });
}

// ── Twilio helpers ─────────────────────────────────────────────

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

async function sendWhatsApp(to: string, message: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid || !authToken || !from) {
    throw new Error("Twilio credentials not configured");
  }

  const chunks = splitMessage(message, 1500);

  for (const chunk of chunks) {
    const body = new URLSearchParams();
    body.append("To", to);
    body.append("From", from);
    body.append("Body", chunk);

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio API error: ${response.status} - ${error}`);
    }
  }
}

// ── Route handler ──────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const reqId = crypto.randomUUID().slice(0, 8);
  const ts = () => new Date().toISOString();
  let fromNumber = "";

  try {
    const formData = await req.text();
    const params = new URLSearchParams(formData);

    fromNumber = params.get("From") ?? "";
    const messageBody = params.get("Body") ?? "";

    console.log(`[${ts()}][${reqId}] from=${fromNumber} body=${JSON.stringify(messageBody)}`);

    if (!messageBody) {
      return new NextResponse("<Response></Response>", {
        headers: { "Content-Type": "text/xml" },
      });
    }

    const client = createWebhookClient();

    // Resolve phone number to user_id
    const userId = await resolveUserId(client, fromNumber);

    // Get conversation history
    console.log(`[${ts()}][${reqId}] fetching conversation history`);
    const history = await getConversationHistory(client, fromNumber, userId);

    // Plan
    console.log(`[${ts()}][${reqId}] planning action`);
    const plan = await planAction(messageBody, history);
    console.log(`[${ts()}][${reqId}] plan: ${JSON.stringify(plan)}`);

    // Execute + summarize
    let responseText: string;
    if (plan.action === "direct") {
      responseText = plan.response ?? "";
    } else {
      console.log(`[${ts()}][${reqId}] executing action: ${plan.action}`);
      const result = await executeAction(client, plan, fromNumber, userId);
      console.log(`[${ts()}][${reqId}] summarizing result (${result.length} chars)`);
      responseText = await summarizeResult(messageBody, result);
    }

    // Persist conversation
    history.push({ role: "user", content: messageBody });
    history.push({ role: "assistant", content: responseText });
    await saveConversationHistory(client, fromNumber, history, userId);

    console.log(`[${ts()}][${reqId}] sending reply (${responseText.length} chars): ${responseText.slice(0, 100)}...`);

    // Send via Twilio
    await sendWhatsApp(fromNumber, responseText);

    console.log(`[${ts()}][${reqId}] done`);

    // Return empty TwiML (we send via API for longer messages)
    return new NextResponse("<Response></Response>", {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error(`[${ts()}][${reqId}] WhatsApp webhook error:`, error);

    // Try to send an error message back to the user so they don't get silence
    if (fromNumber) {
      try {
        await sendWhatsApp(
          fromNumber,
          "Sorry, something went wrong processing your message. Please try again."
        );
      } catch (sendErr) {
        console.error(`[${ts()}][${reqId}] Failed to send error message:`, sendErr);
      }
    }

    // Return 200 with empty TwiML to prevent Twilio retries
    return new NextResponse("<Response></Response>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }
}
