#!/usr/bin/env python3
"""
smgr WhatsApp bot — OpenClaw-style agent that translates natural language
to smgr queries and returns results via WhatsApp.

Architecture:
    WhatsApp (via Twilio/WhatsApp Business API)
        → HTTP webhook (this server)
        → Claude interprets the message
        → Runs smgr CLI commands
        → Formats response
        → Sends back via WhatsApp

This bot is transport-agnostic at its core. The WhatsApp integration is
one adapter — you can swap in Telegram, Discord, or any messaging API
by changing the webhook handler and send function.

Environment:
    ANTHROPIC_API_KEY       Required — for the agent brain
    TWILIO_ACCOUNT_SID      Twilio account SID (for WhatsApp)
    TWILIO_AUTH_TOKEN        Twilio auth token
    TWILIO_WHATSAPP_FROM    Twilio WhatsApp sender (e.g., whatsapp:+14155238886)
    SMGR_BOT_PORT           Port to listen on (default: 8742)
    SMGR_S3_BUCKET          Passed through to smgr commands
    SMGR_S3_ENDPOINT        Passed through to smgr commands

Usage:
    # Start the bot
    python3 bot.py

    # Or use the generic agent without WhatsApp (stdin/stdout mode)
    python3 bot.py --stdio
"""

import json
import os
import subprocess
from datetime import datetime

# --- Agent Core ---
# The agent translates natural language to smgr commands using Claude.
# This is the "brain" — transport-agnostic.

AGENT_SYSTEM_PROMPT = """You are a personal media assistant. You help the user find, describe, and manage their photo/video library using the smgr CLI tool.

Available commands (run via shell):
- smgr query --format json [--search QUERY] [--type TYPE] [--since DATE] [--until DATE] [--limit N]
- smgr show <event_id>
- smgr stats
- smgr enrich --status
- smgr enrich --pending
- smgr enrich <event_id>

Rules:
1. When the user asks about their photos/media, translate to smgr query commands
2. Always use --format json to get structured data
3. Summarize results conversationally — don't dump raw JSON
4. When showing photos, include the remote_path or s3_key so the user can access them
5. For vague queries like "what photos do I have?", start with smgr stats
6. For search queries, use smgr query --search "terms"
7. You can chain multiple commands if needed
8. Keep responses concise — this is a chat interface, not a report

Respond with a JSON object:
{
    "commands": ["smgr query --format json --search \\"bed repair\\""],
    "thinking": "brief note about your approach"
}

If no command is needed (greeting, clarification, etc.), return:
{
    "commands": [],
    "direct_response": "your response text"
}"""


def agent_plan(user_message: str, conversation_history: list[dict] = None) -> dict:
    """Use Claude to interpret a user message and plan smgr commands."""
    import anthropic

    client = anthropic.Anthropic()

    messages = []
    if conversation_history:
        messages.extend(conversation_history)
    messages.append({"role": "user", "content": user_message})

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        system=AGENT_SYSTEM_PROMPT,
        messages=messages,
    )

    text = response.content[0].text.strip()

    # Parse JSON response
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
        text = text.rsplit("```", 1)[0]

    return json.loads(text)


def run_smgr_command(command: str) -> str:
    """Run an smgr command and return its output."""
    # Security: only allow smgr commands
    if not command.strip().startswith("smgr "):
        return f"Error: only smgr commands are allowed, got: {command}"

    # Replace 'smgr' with the actual Python script path
    smgr_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "smgr.py")
    actual_command = command.replace("smgr ", f"python3 {smgr_path} ", 1)

    try:
        result = subprocess.run(
            actual_command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        output = result.stdout
        if result.returncode != 0:
            output += f"\nError: {result.stderr}"
        return output.strip()
    except subprocess.TimeoutExpired:
        return "Error: command timed out after 30 seconds"
    except Exception as e:
        return f"Error running command: {e}"


SUMMARIZE_PROMPT = """You are a personal media assistant responding via chat (WhatsApp).
The user asked: "{user_message}"

You ran these commands and got these results:
{command_results}

Summarize the results conversationally. Keep it short and natural — this is a chat message, not an email.
- Use line breaks for readability
- If there are photos, mention how many and what they show (from enrichment descriptions)
- Include S3 keys or remote paths if the user might want to view specific items
- Don't include raw JSON
- Don't be overly formal"""


def agent_summarize(user_message: str, command_results: list[dict]) -> str:
    """Use Claude to summarize command results into a chat-friendly response."""
    import anthropic

    client = anthropic.Anthropic()

    results_text = ""
    for cr in command_results:
        results_text += f"Command: {cr['command']}\nOutput:\n{cr['output']}\n\n"

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": SUMMARIZE_PROMPT.format(
                user_message=user_message,
                command_results=results_text,
            ),
        }],
    )

    return response.content[0].text.strip()


def handle_message(user_message: str, conversation_history: list[dict] = None) -> str:
    """Full agent loop: interpret → execute → summarize."""
    try:
        # Step 1: Plan
        plan = agent_plan(user_message, conversation_history)

        # Direct response (no commands needed)
        if plan.get("direct_response"):
            return plan["direct_response"]

        commands = plan.get("commands", [])
        if not commands:
            return "I'm not sure what you're looking for. Try asking about your photos, or say 'stats' to see an overview."

        # Step 2: Execute
        command_results = []
        for cmd in commands:
            output = run_smgr_command(cmd)
            command_results.append({"command": cmd, "output": output})

        # Step 3: Summarize
        summary = agent_summarize(user_message, command_results)
        return summary

    except Exception as e:
        return f"Sorry, something went wrong: {e}"


# --- WhatsApp Transport (Twilio) ---

def start_whatsapp_server(port: int):
    """Start an HTTP server that receives WhatsApp webhooks via Twilio."""
    from http.server import HTTPServer, BaseHTTPRequestHandler
    from urllib.parse import parse_qs

    # Conversation history per phone number (in-memory, resets on restart)
    conversations: dict[str, list[dict]] = {}

    class WhatsAppHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/whatsapp":
                self.send_response(404)
                self.end_headers()
                return

            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            params = parse_qs(body)

            from_number = params.get("From", [""])[0]
            message_body = params.get("Body", [""])[0]

            if not message_body:
                self.send_response(200)
                self.end_headers()
                return

            print(f"[{datetime.now().strftime('%H:%M:%S')}] {from_number}: {message_body}")

            # Get or create conversation history
            history = conversations.get(from_number, [])

            # Handle the message
            response_text = handle_message(message_body, history)

            # Update conversation history (keep last 10 exchanges)
            history.append({"role": "user", "content": message_body})
            history.append({"role": "assistant", "content": response_text})
            if len(history) > 20:
                history = history[-20:]
            conversations[from_number] = history

            print(f"[{datetime.now().strftime('%H:%M:%S')}] → {response_text[:100]}...")

            # Send response via Twilio
            send_whatsapp(from_number, response_text)

            # Respond to Twilio webhook
            self.send_response(200)
            self.send_header("Content-Type", "text/xml")
            self.end_headers()
            # Empty TwiML response (we send via API instead for longer messages)
            self.wfile.write(b"<Response></Response>")

        def do_GET(self):
            if self.path == "/health":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"ok","service":"smgr-whatsapp-bot"}')
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, format, *args):
            pass  # Quiet logs

    server = HTTPServer(("0.0.0.0", port), WhatsAppHandler)
    print(f"WhatsApp bot listening on http://0.0.0.0:{port}/whatsapp")
    print(f"Health check: http://0.0.0.0:{port}/health")
    print(f"Configure Twilio webhook URL: https://your-domain:{port}/whatsapp")
    print("Press Ctrl+C to stop.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()


def send_whatsapp(to: str, message: str):
    """Send a WhatsApp message via Twilio API."""
    account_sid = os.environ.get("TWILIO_ACCOUNT_SID")
    auth_token = os.environ.get("TWILIO_AUTH_TOKEN")
    from_number = os.environ.get("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886")

    if not account_sid or not auth_token:
        print(f"[send] Would send to {to}: {message}")
        print("[send] Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to enable actual sending")
        return

    try:
        from twilio.rest import Client
        client = Client(account_sid, auth_token)

        # WhatsApp has a 1600 char limit per message, split if needed
        chunks = _split_message(message, 1500)
        for chunk in chunks:
            client.messages.create(
                body=chunk,
                from_=from_number,
                to=to,
            )
    except ImportError:
        # Fallback: use requests directly
        import urllib.request
        import base64

        url = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"
        auth = base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()

        chunks = _split_message(message, 1500)
        for chunk in chunks:
            data = f"To={to}&From={from_number}&Body={chunk}".encode()
            req = urllib.request.Request(url, data=data, method="POST")
            req.add_header("Authorization", f"Basic {auth}")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
            urllib.request.urlopen(req)


def _split_message(text: str, max_len: int) -> list[str]:
    """Split a message into chunks, preferring line breaks."""
    if len(text) <= max_len:
        return [text]

    chunks = []
    while text:
        if len(text) <= max_len:
            chunks.append(text)
            break

        # Find a good split point
        split_at = text.rfind("\n", 0, max_len)
        if split_at < max_len // 2:
            split_at = text.rfind(" ", 0, max_len)
        if split_at < max_len // 2:
            split_at = max_len

        chunks.append(text[:split_at])
        text = text[split_at:].lstrip()

    return chunks


# --- STDIO Transport (for testing without WhatsApp) ---

def run_stdio():
    """Interactive mode via stdin/stdout. Great for testing."""
    print("smgr agent (stdio mode)")
    print("Ask me about your photos. Type 'quit' to exit.\n")

    history = []

    while True:
        try:
            user_input = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye!")
            break

        if not user_input:
            continue
        if user_input.lower() in ("quit", "exit", "q"):
            print("Bye!")
            break

        response = handle_message(user_input, history)

        history.append({"role": "user", "content": user_input})
        history.append({"role": "assistant", "content": response})
        if len(history) > 20:
            history = history[-20:]

        print(f"\nagent> {response}\n")


# --- Main ---

def main():
    import argparse

    parser = argparse.ArgumentParser(prog="smgr-bot", description="smgr WhatsApp agent bot")
    parser.add_argument("--stdio", action="store_true", help="Run in interactive stdin/stdout mode")
    parser.add_argument("--port", type=int, default=int(os.environ.get("SMGR_BOT_PORT", "8742")),
                        help="Port for WhatsApp webhook server (default: 8742)")

    args = parser.parse_args()

    if args.stdio:
        run_stdio()
    else:
        start_whatsapp_server(args.port)


if __name__ == "__main__":
    main()
