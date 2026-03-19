import { AuthButton } from "@/components/auth-button";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { hasEnvVars } from "@/lib/utils";
import Link from "next/link";
import { Suspense } from "react";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center">
      <div className="flex-1 w-full flex flex-col gap-20 items-center">
        <nav className="w-full flex justify-center border-b border-b-foreground/10 h-16">
          <div className="w-full max-w-5xl flex justify-between items-center p-3 px-5 text-sm">
            <div className="flex gap-5 items-center font-semibold">
              <Link href="/">sitemgr</Link>
              <div className="flex items-center gap-4 text-sm font-normal text-muted-foreground">
                <Link href="/media" className="hover:text-foreground transition-colors">
                  Media
                </Link>
                <Link href="/buckets" className="hover:text-foreground transition-colors">
                  Buckets
                </Link>
                <Link href="/agent" className="hover:text-foreground transition-colors">
                  Chat
                </Link>
                <Link href="/profile" className="hover:text-foreground transition-colors">
                  Profile
                </Link>
              </div>
            </div>
            {hasEnvVars && (
              <Suspense>
                <AuthButton />
              </Suspense>
            )}
          </div>
        </nav>
        <div className="flex-1 flex flex-col gap-12 max-w-5xl p-5">
          <div className="text-center space-y-4 pt-12">
            <h1 className="text-4xl font-bold">sitemgr</h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Media management system — watch S3 buckets for photos and videos,
              enrich them with AI vision, and search with natural language.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-8">
            <Link
              href="/media"
              className="group rounded-lg border p-6 hover:border-foreground/25 transition-colors"
            >
              <h2 className="text-xl font-semibold mb-2">Media Gallery</h2>
              <p className="text-sm text-muted-foreground">
                Browse and search your indexed photos and videos with AI-generated descriptions.
              </p>
            </Link>

            <Link
              href="/buckets"
              className="group rounded-lg border p-6 hover:border-foreground/25 transition-colors"
            >
              <h2 className="text-xl font-semibold mb-2">Bucket Config</h2>
              <p className="text-sm text-muted-foreground">
                Configure your S3-compatible storage buckets for media management.
              </p>
            </Link>

            <Link
              href="/agent"
              className="group rounded-lg border p-6 hover:border-foreground/25 transition-colors"
            >
              <h2 className="text-xl font-semibold mb-2">AI Chat</h2>
              <p className="text-sm text-muted-foreground">
                Ask questions about your media in natural language — powered by Claude.
              </p>
            </Link>
          </div>
        </div>

        <footer className="w-full flex items-center justify-center border-t mx-auto text-center text-xs gap-8 py-16">
          <p>
            Powered by{" "}
            <a
              href="https://supabase.com/?utm_source=create-next-app&utm_medium=template&utm_term=nextjs"
              target="_blank"
              className="font-bold hover:underline"
              rel="noreferrer"
            >
              Supabase
            </a>
          </p>
          <ThemeSwitcher />
        </footer>
      </div>
    </main>
  );
}
