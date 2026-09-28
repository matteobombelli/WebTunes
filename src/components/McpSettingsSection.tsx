"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { BASE_PATH } from "@/lib/base-path";
import type {
  McpActionDTO,
  McpActionPageDTO,
  OAuthGrantDTO,
  UndoReportDTO,
} from "@/lib/types";
import { useToastStore } from "@/stores/toast";
import { Button } from "@/components/ui/Button";

const PAGE_SIZE = 20;

const rowClass =
  "flex items-start gap-2 rounded-md border border-border-subtle bg-surface-1 px-3 py-2";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  if (mins < 7 * 24 * 60) return `${Math.floor(mins / (24 * 60))}d ago`;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== new Date().getFullYear() && { year: "numeric" }),
  });
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Settings section for MCP clients: the connection URL, the OAuth grants
 * (revocable), and the log of changes made through them (undoable within the
 * server's window). Mounted only while the Settings main view is open, so both
 * lists load once per open.
 */
export default function McpSettingsSection() {
  const [grants, setGrants] = useState<OAuthGrantDTO[] | null>(null);
  const [grantsFailed, setGrantsFailed] = useState(false);
  // Inline confirm: the global ConfirmDialog shares Settings' z-index but
  // mounts before it, so it would open hidden behind this modal.
  const [confirmingGrant, setConfirmingGrant] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const [actions, setActions] = useState<McpActionDTO[] | null>(null);
  const [actionsFailed, setActionsFailed] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);

  const mcpUrl = `${window.location.origin}${BASE_PATH}/api/mcp`;
  const toast = (msg: string) => useToastStore.getState().show(msg);

  useEffect(() => {
    let active = true;
    api<OAuthGrantDTO[]>("/oauth/grants")
      .then((rows) => {
        if (active) setGrants(rows);
      })
      .catch(() => {
        if (active) {
          setGrants([]);
          setGrantsFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    api<McpActionPageDTO>(`/mcp/actions?limit=${PAGE_SIZE}`)
      .then((page) => {
        if (active) {
          setActions(page.actions);
          setNextCursor(page.nextCursor);
        }
      })
      .catch(() => {
        if (active) {
          setActions([]);
          setActionsFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const copyUrl = () => {
    navigator.clipboard.writeText(mcpUrl).then(
      () => toast("Copied connection URL to clipboard!"),
      () => toast("Couldn’t copy URL")
    );
  };

  const disconnect = async (grant: OAuthGrantDTO) => {
    setRevoking(grant.id);
    try {
      await api(`/oauth/grants/${grant.id}`, { method: "DELETE" });
      setGrants((prev) => prev?.filter((g) => g.id !== grant.id) ?? prev);
      toast(`Disconnected ${grant.clientName}`);
    } catch (err) {
      toast(errorMessage(err, "Couldn’t disconnect app"));
    } finally {
      setRevoking(null);
      setConfirmingGrant(null);
    }
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<McpActionPageDTO>(
        `/mcp/actions?limit=${PAGE_SIZE}&before=${nextCursor}`
      );
      setActions((prev) => [...(prev ?? []), ...page.actions]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      toast(errorMessage(err, "Couldn’t load more changes"));
    } finally {
      setLoadingMore(false);
    }
  };

  const undo = async (action: McpActionDTO) => {
    setUndoing(action.id);
    try {
      const { report } = await api<{ report: UndoReportDTO }>(
        `/mcp/actions/${action.id}/undo`,
        { method: "POST" }
      );
      setActions(
        (prev) =>
          prev?.map((a) =>
            a.id === action.id
              ? {
                  ...a,
                  status: "undone" as const,
                  undoneAt: new Date().toISOString(),
                  undoReport: report,
                  canUndo: false,
                }
              : a
          ) ?? prev
      );
      toast(
        report.skipped.length > 0
          ? `Undone, ${report.skipped.length} skipped`
          : "Undone"
      );
    } catch (err) {
      toast(errorMessage(err, "Couldn’t undo change"));
      // Expired or already-undone rows are stale here; refetch the first page
      // (which drops extra pages) so the row shows its real state.
      try {
        const page = await api<McpActionPageDTO>(
          `/mcp/actions?limit=${PAGE_SIZE}`
        );
        setActions(page.actions);
        setNextCursor(page.nextCursor);
      } catch {
        // Keep the current list; the toast already reported the failure.
      }
    } finally {
      setUndoing(null);
    }
  };

  return (
    <div className="mt-6 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-fg">AI assistants (MCP)</h3>
      <p className="mt-1 text-xs text-fg-muted">
        Connect an AI assistant that supports MCP to browse your library and
        make changes for you. Add this URL as a custom connector, then sign in
        to approve it.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 break-all font-mono text-xs text-fg-muted">
          {mcpUrl}
        </span>
        <Button size="sm" onClick={copyUrl}>
          Copy
        </Button>
      </div>

      <h4 className="mt-5 text-sm text-fg">Connected apps</h4>
      {grants === null ? (
        <p className="mt-2 text-xs text-fg-muted">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="mt-2 text-xs text-fg-muted">
          {grantsFailed
            ? "Couldn’t load connected apps - check your connection."
            : "No apps connected."}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {grants.map((grant) => (
            <li key={grant.id} className={`${rowClass} flex-col`}>
              <div className="flex w-full items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm text-fg">
                    {grant.clientName}
                  </p>
                  <p className="break-words text-xs text-fg-muted">
                    {[
                      grant.clientHost,
                      grant.scopes.includes("library:write")
                        ? "Read & change"
                        : "Read only",
                      grant.lastUsedAt
                        ? `Last used ${formatWhen(grant.lastUsedAt)}`
                        : "Never used",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {confirmingGrant !== grant.id && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="shrink-0"
                    onClick={() => setConfirmingGrant(grant.id)}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
              {confirmingGrant === grant.id && (
                <div className="w-full">
                  <p className="text-xs text-fg-muted">
                    Disconnect {grant.clientName}? It will lose access
                    immediately. Changes it made stay undoable below.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => disconnect(grant)}
                      disabled={revoking === grant.id}
                      className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-accent-fg hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {revoking === grant.id ? "Disconnecting…" : "Disconnect"}
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={revoking === grant.id}
                      onClick={() => setConfirmingGrant(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-5 text-sm text-fg">Recent AI changes</h4>
      {actions === null ? (
        <p className="mt-2 text-xs text-fg-muted">Loading…</p>
      ) : actions.length === 0 ? (
        <p className="mt-2 text-xs text-fg-muted">
          {actionsFailed
            ? "Couldn’t load changes - check your connection."
            : "No changes yet."}
        </p>
      ) : (
        <>
          <ul className="mt-2 flex flex-col gap-2">
            {actions.map((action) => (
              <li key={action.id} className={rowClass}>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm text-fg">
                    {action.summary}
                  </p>
                  <p className="break-words text-xs text-fg-muted">
                    {action.clientName} · {formatWhen(action.createdAt)}
                  </p>
                  {action.status === "undone" ? (
                    <p className="text-xs text-fg-subtle">
                      Undone
                      {action.undoneAt ? ` ${formatWhen(action.undoneAt)}` : ""}
                    </p>
                  ) : (
                    !action.canUndo && (
                      <p className="text-xs text-fg-subtle">
                        Undo window passed
                      </p>
                    )
                  )}
                  {action.undoReport && action.undoReport.skipped.length > 0 && (
                    <ul className="mt-1 text-xs text-fg-muted">
                      {action.undoReport.skipped.map((s, i) => (
                        <li key={i} className="break-words">
                          Skipped {s.item}: {s.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {action.canUndo && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={undoing === action.id}
                    onClick={() => undo(action)}
                  >
                    {undoing === action.id ? "Undoing…" : "Undo"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {nextCursor && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2 w-full"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
