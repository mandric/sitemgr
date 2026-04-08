import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChatInterface } from "@/components/agent/chat-interface";

async function AgentContent() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    return redirect("/auth/login");
  }

  // ChatInterface resolves the authenticated user server-side via the session,
  // so we don't need to pass anything from here.
  return <ChatInterface />;
}

function AgentLoading() {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="animate-pulse">Loading agent...</div>
    </div>
  );
}

export default function AgentPage() {
  return (
    <div className="h-screen flex flex-col">
      <div className="border-b p-4">
        <h1 className="text-2xl font-bold">Site Manager Agent</h1>
        <p className="text-sm text-muted-foreground">
          Chat with Claude to manage your media and buckets
        </p>
      </div>

      <Suspense fallback={<AgentLoading />}>
        <AgentContent />
      </Suspense>
    </div>
  );
}
