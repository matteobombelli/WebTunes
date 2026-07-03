"use client";

import { useState } from "react";
import Dialog from "@/components/Dialog";

const RELEASES_URL = "https://github.com/matteobombelli/webtunes-importer/releases";

const buttonClasses =
  "rounded-md bg-surface-3 px-4 py-2 text-sm font-semibold text-fg hover:bg-border";

export default function DownloadImporterButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <a
        href={RELEASES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`hidden md:inline-flex ${buttonClasses}`}
      >
        Download Importer
      </a>
      <button onClick={() => setOpen(true)} className={`md:hidden ${buttonClasses}`}>
        Importer
      </button>
      <Dialog title="WebTunes Importer" open={open} onClose={() => setOpen(false)}>
        <p className="text-sm text-fg-muted">
          The importer is a desktop app that imports music into your library
          directly from YouTube, Spotify, and Apple Music. It is only available
          on desktop, so visit this page from your computer to download it.
        </p>
      </Dialog>
    </>
  );
}
