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
} from "@/lib/agent/core";

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

// ── Route handlers ─────────────────────────────────────────────

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "smgr-whatsapp-bot",
    timestamp: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.text();
    const params = new URLSearchParams(formData);

    const fromNumber = params.get("From") ?? "";
    const messageBody = params.get("Body") ?? "";

    if (!messageBody) {
      return new NextResponse("<Response></Response>", {
        headers: { "Content-Type": "text/xml" },
      });
    }

    console.log(`[${new Date().toISOString()}] ${fromNumber}: ${messageBody}`);

    // Get conversation history
    const history = await getConversationHistory(fromNumber);

    // Plan
    const plan = await planAction(messageBody, history);

    // Execute + summarize
    let responseText: string;
    if (plan.action === "direct") {
      responseText = plan.response ?? "";
    } else {
      const result = await executeAction(plan, fromNumber);
      responseText = await summarizeResult(messageBody, result);
    }

    // Persist conversation
    history.push({ role: "user", content: messageBody });
    history.push({ role: "assistant", content: responseText });
    await saveConversationHistory(fromNumber, history);

    console.log(`[${new Date().toISOString()}] -> ${responseText.slice(0, 100)}...`);

    // Send via Twilio
    await sendWhatsApp(fromNumber, responseText);

    // Return empty TwiML (we send via API for longer messages)
    return new NextResponse("<Response></Response>", {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error("WhatsApp webhook error:", error);

    // Return 200 with empty TwiML to prevent Twilio retries
    return new NextResponse("<Response></Response>", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }
}
