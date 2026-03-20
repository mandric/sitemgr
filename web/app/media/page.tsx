import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getMediaEvents } from "@/components/media/actions";
import { MediaGrid } from "@/components/media/media-grid";
import { SearchBar } from "@/components/media/search-bar";
import { TypeFilter } from "@/components/media/type-filter";
import { Button } from "@/components/ui/button";

async function MediaContent({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; page?: string }>;
}) {
  const resolvedParams = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect("/auth/login");

  const page = parseInt(resolvedParams.page ?? "1", 10);
  const limit = 24;
  const offset = (page - 1) * limit;

  const { data: events, count: total, error } = await getMediaEvents({
    search: resolvedParams.q,
    type: resolvedParams.type,
    offset,
    limit,
  });

  if (error) {
    return <p className="text-red-500">Failed to load media.</p>;
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <>
      <MediaGrid events={events} />

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 pt-4">
          {page > 1 && (
            <Link
              href={{
                pathname: "/media",
                query: {
                  ...(resolvedParams.q ? { q: resolvedParams.q } : {}),
                  ...(resolvedParams.type
                    ? { type: resolvedParams.type }
                    : {}),
                  page: String(page - 1),
                },
              }}
            >
              <Button variant="outline" size="sm">
                Previous
              </Button>
            </Link>
          )}
          <span className="flex items-center text-sm text-muted-foreground px-3">
            Page {page} of {totalPages} ({total} items)
          </span>
          {page < totalPages && (
            <Link
              href={{
                pathname: "/media",
                query: {
                  ...(resolvedParams.q ? { q: resolvedParams.q } : {}),
                  ...(resolvedParams.type
                    ? { type: resolvedParams.type }
                    : {}),
                  page: String(page + 1),
                },
              }}
            >
              <Button variant="outline" size="sm">
                Next
              </Button>
            </Link>
          )}
        </div>
      )}
    </>
  );
}

function MediaLoading() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="aspect-square rounded-lg border bg-card animate-pulse"
        />
      ))}
    </div>
  );
}

export default function MediaPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; page?: string }>;
}) {
  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto py-8 px-4">
      <div>
        <h1 className="text-3xl font-bold mb-2">Media Gallery</h1>
        <p className="text-muted-foreground">
          Browse and search your indexed photos and videos.
        </p>
      </div>

      <Suspense>
        <SearchBar />
      </Suspense>

      <Suspense>
        <TypeFilter />
      </Suspense>

      <Suspense fallback={<MediaLoading />}>
        <MediaContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
