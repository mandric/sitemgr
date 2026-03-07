"""Unit tests for bot.py — agent logic, message splitting, and mocked services."""

import json
import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bot


# --- Pure function tests ---


class TestSplitMessage:
    def test_short_message(self):
        assert bot._split_message("hello", 1500) == ["hello"]

    def test_exact_limit(self):
        msg = "a" * 1500
        assert bot._split_message(msg, 1500) == [msg]

    def test_splits_at_newline(self):
        # 6 chars for "line1\n" then 1500 x's — total > 100
        msg = "line1\n" + "x" * 1500
        chunks = bot._split_message(msg, 100)
        assert len(chunks) >= 2
        # First chunk should be <= 100 chars
        assert len(chunks[0]) <= 100

    def test_splits_at_space(self):
        msg = "word " * 400  # 2000 chars
        chunks = bot._split_message(msg, 100)
        assert all(len(c) <= 100 for c in chunks)

    def test_empty_message(self):
        assert bot._split_message("", 100) == [""]

    def test_long_word_forces_hard_split(self):
        msg = "a" * 200
        chunks = bot._split_message(msg, 50)
        assert len(chunks) >= 4
        assert all(len(c) <= 50 for c in chunks)


# --- Security test ---


class TestRunSmgrCommand:
    def test_rejects_non_smgr_commands(self):
        result = bot.run_smgr_command("rm -rf /")
        assert "Error" in result
        assert "only smgr commands" in result

    def test_rejects_empty(self):
        result = bot.run_smgr_command("ls -la")
        assert "Error" in result

    @patch("subprocess.run")
    def test_runs_smgr_command(self, mock_run):
        mock_run.return_value = MagicMock(
            stdout='{"total": 5}',
            stderr="",
            returncode=0,
        )
        result = bot.run_smgr_command("smgr stats")
        assert '{"total": 5}' in result
        mock_run.assert_called_once()

    @patch("subprocess.run")
    def test_handles_timeout(self, mock_run):
        import subprocess
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="smgr stats", timeout=30)
        result = bot.run_smgr_command("smgr stats")
        assert "timed out" in result


# --- Mocked agent tests ---


class TestAgentPlan:
    def test_returns_commands(self):
        mock_client = MagicMock()
        plan_json = json.dumps({
            "commands": ["smgr stats"],
            "thinking": "user wants an overview",
        })
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text=plan_json)]
        mock_client.messages.create.return_value = mock_response

        mock_anthropic = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        with patch.dict("sys.modules", {"anthropic": mock_anthropic}):
            result = bot.agent_plan("what photos do I have?")

        assert result["commands"] == ["smgr stats"]
        mock_client.messages.create.assert_called_once()

    def test_returns_direct_response(self):
        mock_client = MagicMock()
        plan_json = json.dumps({
            "commands": [],
            "direct_response": "Hello! How can I help?",
        })
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text=plan_json)]
        mock_client.messages.create.return_value = mock_response

        mock_anthropic = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        with patch.dict("sys.modules", {"anthropic": mock_anthropic}):
            result = bot.agent_plan("hello")

        assert result["direct_response"] == "Hello! How can I help?"

    def test_strips_markdown_fences(self):
        mock_client = MagicMock()
        fenced = '```json\n{"commands": ["smgr stats"], "thinking": "test"}\n```'
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text=fenced)]
        mock_client.messages.create.return_value = mock_response

        mock_anthropic = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        with patch.dict("sys.modules", {"anthropic": mock_anthropic}):
            result = bot.agent_plan("stats")

        assert result["commands"] == ["smgr stats"]

    def test_includes_conversation_history(self):
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text='{"commands": [], "direct_response": "ok"}')]
        mock_client.messages.create.return_value = mock_response

        mock_anthropic = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        history = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]

        with patch.dict("sys.modules", {"anthropic": mock_anthropic}):
            bot.agent_plan("follow up", history)

        call_args = mock_client.messages.create.call_args
        messages = call_args.kwargs["messages"]
        assert len(messages) == 3
        assert messages[0]["content"] == "hello"
        assert messages[2]["content"] == "follow up"


class TestAgentSummarize:
    def test_formats_results(self):
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.content = [MagicMock(text="You have 5 photos total.")]
        mock_client.messages.create.return_value = mock_response

        mock_anthropic = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        with patch.dict("sys.modules", {"anthropic": mock_anthropic}):
            result = bot.agent_summarize(
                "how many photos?",
                [{"command": "smgr stats", "output": '{"total": 5}'}],
            )

        assert result == "You have 5 photos total."
        call_args = mock_client.messages.create.call_args
        assert call_args.kwargs["model"] == "claude-haiku-4-5-20251001"


class TestHandleMessage:
    @patch("bot.agent_summarize")
    @patch("bot.run_smgr_command")
    @patch("bot.agent_plan")
    def test_full_pipeline(self, mock_plan, mock_run, mock_summarize):
        mock_plan.return_value = {
            "commands": ["smgr stats"],
            "thinking": "user wants stats",
        }
        mock_run.return_value = '{"total": 10}'
        mock_summarize.return_value = "You have 10 photos!"

        result = bot.handle_message("how many photos?")

        assert result == "You have 10 photos!"
        mock_plan.assert_called_once()
        mock_run.assert_called_once_with("smgr stats")
        mock_summarize.assert_called_once()

    @patch("bot.agent_plan")
    def test_direct_response(self, mock_plan):
        mock_plan.return_value = {
            "commands": [],
            "direct_response": "Hello!",
        }

        result = bot.handle_message("hi")
        assert result == "Hello!"

    @patch("bot.agent_plan")
    def test_empty_commands_fallback(self, mock_plan):
        mock_plan.return_value = {"commands": []}

        result = bot.handle_message("???")
        assert "not sure" in result.lower()

    @patch("bot.agent_plan")
    def test_handles_exception(self, mock_plan):
        mock_plan.side_effect = Exception("API down")

        result = bot.handle_message("test")
        assert "something went wrong" in result.lower()
