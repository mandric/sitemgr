"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function SearchBar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const params = new URLSearchParams(searchParams.toString());
      if (query.trim()) {
        params.set("q", query.trim());
      } else {
        params.delete("q");
      }
      params.delete("page");
      router.push(`/media?${params.toString()}`);
    },
    [query, searchParams, router],
  );

  const handleClear = useCallback(() => {
    setQuery("");
    const params = new URLSearchParams(searchParams.toString());
    params.delete("q");
    params.delete("page");
    router.push(`/media?${params.toString()}`);
  }, [searchParams, router]);

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <Input
        type="search"
        placeholder="Search photos... (e.g. beach, sunset, dogs)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="flex-1"
      />
      <Button type="submit">Search</Button>
      {searchParams.get("q") && (
        <Button type="button" variant="outline" onClick={handleClear}>
          Clear
        </Button>
      )}
    </form>
  );
}
