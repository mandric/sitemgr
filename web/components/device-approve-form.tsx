"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSearchParams, useRouter } from "next/navigation";
import { useState } from "react";

// Exported for testability

export function parseCodeFromUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  const code = params.get("code");
  return code ? code.toUpperCase() : null;
}

export async function approveDevice(
  userCode: string,
): Promise<{
  success: boolean;
  error?: string;
  unauthorized?: boolean;
}> {
  try {
    const res = await fetch("/api/auth/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
    });

    const data = await res.json();

    if (res.status === 401) {
      return { success: false, error: "Unauthorized", unauthorized: true };
    }

    if (!res.ok) {
      return { success: false, error: data.error || "Unknown error" };
    }

    return { success: true };
  } catch {
    return { success: false, error: "Network error. Please try again." };
  }
}

export function DeviceApproveForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const codeFromUrl = searchParams.get("code")?.toUpperCase() ?? null;

  const [code, setCode] = useState(codeFromUrl ?? "");
  const [manualEntry, setManualEntry] = useState(!codeFromUrl);
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;

    setStatus("loading");
    setErrorMessage(null);

    const result = await approveDevice(code.trim().toUpperCase());

    if (result.unauthorized) {
      const returnUrl = `/auth/device?code=${encodeURIComponent(code.trim())}`;
      router.push(`/auth/login?redirect=${encodeURIComponent(returnUrl)}`);
      return;
    }

    if (result.success) {
      setStatus("success");
    } else {
      setStatus("error");
      setErrorMessage(result.error ?? "Unknown error");
    }
  };

  if (status === "success") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Device Approved</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            You can close this tab and return to your terminal.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Approve Device</CardTitle>
        <CardDescription>
          A CLI is requesting access to your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {!manualEntry && codeFromUrl ? (
            <div className="flex flex-col gap-2">
              <Label>Device Code</Label>
              <div className="rounded-md border bg-muted p-4 text-center font-mono text-2xl tracking-widest">
                {codeFromUrl}
              </div>
              <button
                type="button"
                onClick={() => setManualEntry(true)}
                className="text-xs text-muted-foreground underline"
              >
                Not this code?
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="code">Enter the code from your terminal</Label>
              <Input
                id="code"
                type="text"
                placeholder="XXXX-XXXX"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="font-mono text-center text-xl tracking-widest"
                maxLength={9}
                autoFocus
              />
            </div>
          )}

          {errorMessage && (
            <p className="text-sm text-destructive">{errorMessage}</p>
          )}

          <Button type="submit" disabled={status === "loading" || !code.trim()}>
            {status === "loading" ? "Approving..." : "Approve"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
