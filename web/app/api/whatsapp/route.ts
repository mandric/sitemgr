/**
 * WhatsApp webhook handler (Twilio)
 * Moved from Supabase Edge Function to Vercel API route for code sharing
 */

import { NextRequest, NextResponse } from "next/server";
import { sendMessageToAgent } from "@/lib/agent/core";

async function sendWhatsAppMessage(to: string, body: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid || !authToken || !from) {
    throw new Error("Twilio credentials not configured");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      From: from,
      To: to,
      Body: body,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Twilio API error: ${response.status} - ${error}`);
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const from = formData.get("From") as string;
    const body = formData.get("Body") as string;

    if (!from || !body) {
      return NextResponse.json(
        { error: "Missing From or Body" },
        { status: 400 }
      );
    }

    console.log(`WhatsApp message from ${from}: ${body}`);

    // Get response from agent
    const response = await sendMessageToAgent(body);

    if (response.error) {
      await sendWhatsAppMessage(
        from,
        "Sorry, I encountered an error. Please try again later."
      );
      return NextResponse.json({ error: response.error }, { status: 500 });
    }

    // Send response back to WhatsApp
    if (response.content) {
      await sendWhatsAppMessage(from, response.content);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("WhatsApp webhook error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// Health check endpoint
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "whatsapp-webhook",
    timestamp: new Date().toISOString(),
  });
}
