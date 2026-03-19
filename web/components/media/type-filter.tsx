"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

const TYPES = [
  { value: "", label: "All" },
  { value: "photo", label: "Photos" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
];

export function TypeFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get("type") ?? "";

  const handleFilter = (type: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (type) {
      params.set("type", type);
    } else {
      params.delete("type");
    }
    params.delete("page");
    router.push(`/media?${params.toString()}`);
  };

  return (
    <div className="flex gap-1">
      {TYPES.map((t) => (
        <Button
          key={t.value}
          variant={current === t.value ? "default" : "outline"}
          size="sm"
          onClick={() => handleFilter(t.value)}
        >
          {t.label}
        </Button>
      ))}
    </div>
  );
}
