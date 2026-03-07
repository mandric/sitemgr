import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

async function ProfileContent() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect("/auth/login");
  }

  // Fetch user profile
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Account Information</CardTitle>
          <CardDescription>Your account details</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="text-sm font-medium text-muted-foreground">Email</div>
            <div className="text-lg">{user.email}</div>
          </div>

          {profile?.phone_number && (
            <div>
              <div className="text-sm font-medium text-muted-foreground">Phone Number</div>
              <div className="text-lg">{profile.phone_number}</div>
            </div>
          )}

          <div>
            <div className="text-sm font-medium text-muted-foreground">User ID</div>
            <div className="font-mono text-sm">{user.id}</div>
          </div>

          <div>
            <div className="text-sm font-medium text-muted-foreground">Account Created</div>
            <div className="text-sm">{new Date(user.created_at!).toLocaleDateString()}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quick Links</CardTitle>
          <CardDescription>Manage your account</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <a href="/buckets" className="block text-primary hover:underline">
            → Manage S3 Buckets
          </a>
          <a href="/agent" className="block text-primary hover:underline">
            → Chat with Agent
          </a>
        </CardContent>
      </Card>
    </div>
  );
}

function ProfileLoading() {
  return (
    <div className="space-y-6">
      <div className="h-48 rounded-lg border bg-card animate-pulse" />
      <div className="h-32 rounded-lg border bg-card animate-pulse" />
    </div>
  );
}

export default function ProfilePage() {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold mb-2">Profile</h1>
      <p className="text-muted-foreground mb-8">
        Manage your account settings and preferences
      </p>

      <Suspense fallback={<ProfileLoading />}>
        <ProfileContent />
      </Suspense>
    </div>
  );
}
