"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  emailHref,
  formatActivityTime,
  formatDateOnly,
  formatPhone,
  latestVideoSent,
  normalizeRows,
  parseCsv,
  phoneHref,
  simplifyLocation,
  type LeadRecord,
} from "../lib/campaign";
import { sourceConfig } from "../lib/source-config";
import { notesConfig } from "../lib/notes-config";

// Every client dashboard is served from the same github.io origin, so localStorage is
// shared across all of them. Namespacing by Sheet id keeps each client's cached view,
// pins and archive decisions separate instead of bleeding between dashboards.
const STORE_NS = `:${sourceConfig.sheetId}`;
const CACHE_KEY = `lwb-dashboard-last-good-view${STORE_NS}`;
const SEEN_KEY = `lwb-dashboard-seen-action-items${STORE_NS}`;
const ARCHIVE_KEY = `lwb-dashboard-archived-prospects${STORE_NS}`;
const PINNED_KEY = `lwb-dashboard-pinned-prospects${STORE_NS}`;
// Unsaved typing, so a refresh or reload never loses in-progress edits.
const NOTES_DRAFT_KEY = `lwb-dashboard-notes-drafts${STORE_NS}`;
// Notes already written to the Sheet but not yet visible in the CSV export,
// which Google caches for a short while after a write.
const NOTES_PENDING_KEY = `lwb-dashboard-notes-pending${STORE_NS}`;
// How long a pending write keeps winning over the Sheet value.
const PENDING_TTL_MS = 3 * 60 * 1000;

type CachedView = { records: LeadRecord[]; refreshedAt: string };

function repairCachedView(view: CachedView): CachedView {
  return {
    ...view,
    records: view.records.map((record) => {
      const videoBlocked = /^0?1\/0?1\/(?:0?1|2001)$/i.test(record.videoSent);
      const hasWatched = /\[video wat(?:ched|rched)\]/i.test(record.notes);
      return {
        ...record,
        hasVideoSent: !videoBlocked && Boolean(record.videoSent),
        hasWatched,
        watchedAt: record.watchedAt ?? (hasWatched ? record.lastSearched : ""),
      };
    }),
  };
}

function archiveKey(record: LeadRecord) {
  return record.profileUrl || `${record.firstName}-${record.lastName}`.toLowerCase();
}

function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveLocal(key: string, value: unknown) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function WatchedIndicator({ date, complete }: { date: string; complete: boolean }) {
  return (
    <div className={`progress-indicator ${complete ? "complete" : ""}`}>
      <span className="indicator-dot" aria-hidden="true">{complete ? "✓" : ""}</span>
      <span>Video watched{date ? `: ${formatDateOnly(date)}` : complete ? ": date unavailable" : ""}</span>
    </div>
  );
}

function ContactValue({ href, text, fallback }: { href: string; text: string; fallback: string }) {
  if (!text) return <>{fallback}</>;
  if (!href) return <>{text}</>;
  return <a className="contact-link" href={href} onClick={(event) => event.stopPropagation()}>{text}</a>;
}

type PendingNote = { value: string; savedAt: number };
type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Resolve what the textarea should show. Precedence:
 *   1. an unsaved draft the user is still typing
 *   2. a recent successful write the Sheet has not echoed back yet
 *   3. column F itself, which is the source of truth
 */
function effectiveNote(base: string, draft: string | undefined, pending: PendingNote | undefined) {
  if (draft !== undefined) return draft;
  if (pending && Date.now() - pending.savedAt < PENDING_TTL_MS) return pending.value;
  return base;
}

/**
 * POST the note to the Apps Script web app. Content-Type is text/plain on
 * purpose: it keeps the request "simple" so the browser skips the CORS
 * preflight, which Apps Script cannot answer.
 */
async function postNote(record: LeadRecord, value: string) {
  if (!notesConfig.endpoint) throw new Error("The notes endpoint is not configured yet.");

  const response = await fetch(notesConfig.endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      token: notesConfig.token,
      sheetId: sourceConfig.sheetId,
      gid: sourceConfig.sheetGid,
      profileUrl: record.profileUrl,
      fullName: record.fullName,
      notes: value,
    }),
    redirect: "follow",
  });

  if (!response.ok) throw new Error(`The Sheet rejected the write (${response.status}).`);

  const payload = await response.json().catch(() => null);
  if (!payload || payload.ok !== true) {
    throw new Error(payload && payload.error ? String(payload.error) : "The Sheet write failed.");
  }
  return payload;
}

function NotesEditor({ record, draft, pending, onDraftChange, onSaved }: { record: LeadRecord; draft?: string; pending?: PendingNote; onDraftChange: (record: LeadRecord, value: string | undefined) => void; onSaved: (record: LeadRecord, value: string) => void }) {
  const shown = effectiveNote(record.notesCell, draft, pending);
  const [state, setState] = useState<SaveState>("idle");
  const [message, setMessage] = useState("");
  const dirty = draft !== undefined && draft !== effectiveNote(record.notesCell, undefined, pending);

  const save = useCallback(async () => {
    if (draft === undefined) return;
    const value = draft;
    setState("saving");
    setMessage("");
    try {
      await postNote(record, value);
      onSaved(record, value);
      setState("saved");
      window.setTimeout(() => setState((current) => (current === "saved" ? "idle" : current)), 2000);
    } catch (caught) {
      setState("error");
      setMessage(caught instanceof Error ? caught.message : "The note could not be saved.");
    }
  }, [draft, record, onSaved]);

  const statusLabel =
    state === "saving" ? "Saving to Sheet\u2026" :
    state === "saved" ? "Saved to Sheet" :
    state === "error" ? message || "Save failed" :
    dirty ? "Unsaved" : "";

  return (
    <div className="notes-inline" onClick={(event) => event.stopPropagation()}>
      <div className="notes-inline-header" style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
        <span className="contact-label">Notes</span>
        {statusLabel ? (
          <span className="notes-status" style={{ fontSize: "0.75em", opacity: 0.75, color: state === "error" ? "#b3261e" : "inherit" }}>{statusLabel}</span>
        ) : null}
      </div>
      <textarea
        className="notes-inline-editor"
        value={shown}
        onChange={(event) => onDraftChange(record, event.target.value)}
        onBlur={() => { if (dirty) void save(); }}
        rows={4}
        placeholder="Add notes for this prospect..."
        style={{ width: "100%", padding: "8px", fontFamily: "inherit", fontSize: "0.9em", resize: "vertical", boxSizing: "border-box" }}
      />
      {dirty || state === "error" ? (
        <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
          <button className="card-toggle" onClick={() => void save()} disabled={state === "saving"}>
            {state === "saving" ? "Saving\u2026" : state === "error" ? "Retry save" : "Save to Sheet"}
          </button>
          <button className="card-toggle" onClick={() => { onDraftChange(record, undefined); setState("idle"); setMessage(""); }} disabled={state === "saving"}>
            Discard
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LeadCard({ record, archived, pinned, draft, pending, onViewConversation, onArchive, onPin, onDraftChange, onSaved }: { record: LeadRecord; archived?: boolean; pinned?: boolean; draft?: string; pending?: PendingNote; onViewConversation: (record: LeadRecord) => void; onArchive: (record: LeadRecord) => void; onPin: (record: LeadRecord) => void; onDraftChange: (record: LeadRecord, value: string | undefined) => void; onSaved: (record: LeadRecord, value: string) => void }) {
  return (
    <article className="lead-card">
      <div className="lead-heading">
        <div>
          <h3>{record.fullName}</h3>
          <p className="lead-title">
            {[record.title, record.company].filter(Boolean).join(" at ") || "Profile details unavailable"}
          </p>
          <p className="contact-line"><span className="contact-label">email:</span> <ContactValue href={emailHref(record.email)} text={record.email} fallback="Email unavailable" /></p>
          <p className="contact-line"><span className="contact-label">tel:</span> <ContactValue href={phoneHref(record.phone)} text={formatPhone(record.phone)} fallback="Phone unavailable" /></p>
        </div>
        {record.location ? <span className="location">{simplifyLocation(record.location)}</span> : null}
      </div>
      <div className="progress-indicators" aria-label="Video progress">
        <span className="video-sent-text">Video sent{record.videoSent ? `: ${formatDateOnly(record.videoSent)}` : ""}</span>
        <WatchedIndicator date={record.watchedAt} complete={record.hasWatched} />
      </div>
      {record.kind === "reply-before-video" ? <p className="manual-note">Stop video manually in the Sheet if needed.</p> : null}
      {record.sourceIncomplete ? <p className="data-note">Some source details are incomplete.</p> : null}
      <NotesEditor record={record} draft={draft} pending={pending} onDraftChange={onDraftChange} onSaved={onSaved} />
      <div className="card-footer">
        <div className="card-actions card-toggle-actions">
          <button className={`card-toggle archive-button ${archived ? "restore-button" : ""}`} onClick={() => onArchive(record)}>{archived ? "Restore" : "Archive"}</button>
          <button className={`card-toggle pin-button ${pinned ? "pinned" : ""}`} onClick={() => onPin(record)}>{pinned ? "Unpin" : "Pin"}</button>
          <button className="card-toggle conversation-button" onClick={() => onViewConversation(record)}>Initial Outreach</button>
          {record.profileUrl ? (
            <a className="card-toggle linkedin-link" href={record.profileUrl} target="_blank" rel="noreferrer">
              Open LinkedIn
            </a>
          ) : <span className="card-toggle unavailable-toggle">LinkedIn unavailable</span>}
        </div>
      </div>
    </article>
  );
}

function ConversationText({ record }: { record: LeadRecord }) {
  const allowedSpeakers = new Set([
    ...record.senderName.toLowerCase().split(/\s+/),
    record.senderName.toLowerCase(),
    record.firstName.toLowerCase(),
    record.fullName.toLowerCase(),
  ]);

  return (
    <div className="conversation-full">
      {(record.conversation || "No conversation was included in this spreadsheet row.").split(/\r?\n/).map((line, index) => {
        const match = line.match(/^\s*([^:\n]{1,70}):(.*)$/);
        const speaker = match?.[1]?.trim() ?? "";
        const message = match?.[2] ?? line;
        const isKnownSpeaker = allowedSpeakers.has(speaker.toLowerCase()) || /^[A-Z]\.$/.test(speaker);

        return (
          <p className="message-line" key={`${index}-${line.slice(0, 20)}`}>
            {match && isKnownSpeaker ? <><strong>{speaker}:</strong>{message}</> : line}
          </p>
        );
      })}
    </div>
  );
}

export default function Home() {
  const [cached] = useState<CachedView>(() => repairCachedView(readLocal<CachedView>(CACHE_KEY, { records: [], refreshedAt: "" })));
  const [records, setRecords] = useState<LeadRecord[]>(cached.records);
  const [refreshedAt, setRefreshedAt] = useState(cached.refreshedAt);
  const [newIds, setNewIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedRecord, setSelectedRecord] = useState<LeadRecord | null>(null);
  const [archivedKeys, setArchivedKeys] = useState<string[]>(() => readLocal<string[]>(ARCHIVE_KEY, []));
  const [pinnedKeys, setPinnedKeys] = useState<string[]>(() => readLocal<string[]>(PINNED_KEY, []));
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>(() => readLocal<Record<string, string>>(NOTES_DRAFT_KEY, {}));
  const [notePending, setNotePending] = useState<Record<string, PendingNote>>(() => readLocal<Record<string, PendingNote>>(NOTES_PENDING_KEY, {}));

  const toggleArchive = (record: LeadRecord) => {
    const key = archiveKey(record);
    setArchivedKeys((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      saveLocal(ARCHIVE_KEY, next);
      return next;
    });
  };

  const togglePin = (record: LeadRecord) => {
    const key = archiveKey(record);
    setPinnedKeys((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      saveLocal(PINNED_KEY, next);
      return next;
    });
  };

  // Track in-progress typing. Passing undefined discards the draft and falls
  // back to the Sheet value.
  const changeDraft = (record: LeadRecord, value: string | undefined) => {
    const key = archiveKey(record);
    setNoteDrafts((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      saveLocal(NOTES_DRAFT_KEY, next);
      return next;
    });
  };

  // A write succeeded: drop the draft and hold the value until the Sheet echoes it.
  const markSaved = (record: LeadRecord, value: string) => {
    const key = archiveKey(record);
    setNoteDrafts((current) => {
      const next = { ...current };
      delete next[key];
      saveLocal(NOTES_DRAFT_KEY, next);
      return next;
    });
    setNotePending((current) => {
      const next = { ...current, [key]: { value, savedAt: Date.now() } };
      saveLocal(NOTES_PENDING_KEY, next);
      return next;
    });
  };

  const refresh = async () => {
    const { sheetId, sheetGid } = sourceConfig;
    if (!sheetId || !sheetGid) {
      setError("The dashboard Sheet connection is not configured yet.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const endpoint = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${sheetGid}`;
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("The Sheet could not be read right now.");
      const nextRecords = normalizeRows(parseCsv(await response.text()));
      if (!nextRecords.length) throw new Error("The Sheet returned no usable activity records.");

      const knownIds = readLocal<string[]>(SEEN_KEY, []);
      const actions = nextRecords.filter((record) => record.priority <= 3);
      const firstLoad = knownIds.length === 0;
      setNewIds(firstLoad ? [] : actions.filter((record) => !knownIds.includes(record.id)).map((record) => record.id));
      saveLocal(SEEN_KEY, Array.from(new Set([...knownIds, ...actions.map((record) => record.id)])));

      // The Sheet is authoritative. Any pending write it now reflects (or that
      // has outlived its TTL) is dropped so the Sheet value shows through.
      setNotePending((current) => {
        const next: Record<string, PendingNote> = {};
        const byKey = new Map(nextRecords.map((record) => [archiveKey(record), record]));
        Object.keys(current).forEach((key) => {
          const entry = current[key];
          const record = byKey.get(key);
          const echoed = record ? record.notesCell === entry.value : false;
          const expired = Date.now() - entry.savedAt >= PENDING_TTL_MS;
          if (!echoed && !expired) next[key] = entry;
        });
        saveLocal(NOTES_PENDING_KEY, next);
        return next;
      });

      const now = new Date().toISOString();
      setRecords(nextRecords);
      setRefreshedAt(now);
      saveLocal(CACHE_KEY, { records: nextRecords, refreshedAt: now });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The Sheet could not be read right now.");
    } finally {
      setLoading(false);
    }
  };

  const searchedRecords = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return records;
    return records.filter((record) =>
      [record.fullName, record.title, record.company, record.location, record.notes]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [query, records]);

  const activeRecords = searchedRecords.filter((record) => !archivedKeys.includes(archiveKey(record)));
  const archivedRecords = searchedRecords.filter((record) => archivedKeys.includes(archiveKey(record)));
  const actionRecords = activeRecords.filter((record) => record.priority <= 3);
  const actions = actionRecords
    .sort((left, right) => {
      const leftWatchTime = left.hasWatched ? Date.parse(left.watchedAt) || 0 : 0;
      const rightWatchTime = right.hasWatched ? Date.parse(right.watchedAt) || 0 : 0;
      const leftSentTime = Date.parse(left.videoSent) || 0;
      const rightSentTime = Date.parse(right.videoSent) || 0;
      return rightWatchTime - leftWatchTime || rightSentTime - leftSentTime || left.priority - right.priority || Date.parse(right.timestamp) - Date.parse(left.timestamp);
    });
  const pinned = activeRecords.filter((record) => pinnedKeys.includes(archiveKey(record)));
  const unpinnedActions = actions.filter((record) => !pinnedKeys.includes(archiveKey(record)));
  const archived = [...archivedRecords].sort((left, right) => {
    const leftWatchTime = left.hasWatched ? Date.parse(left.watchedAt) || 0 : 0;
    const rightWatchTime = right.hasWatched ? Date.parse(right.watchedAt) || 0 : 0;
    const leftSentTime = Date.parse(left.videoSent) || 0;
    const rightSentTime = Date.parse(right.videoSent) || 0;
    return rightWatchTime - leftWatchTime || rightSentTime - leftSentTime || Date.parse(right.timestamp) - Date.parse(left.timestamp);
  });

  const latestVideoDate = latestVideoSent(records);
  const isFirstLoad = !refreshedAt && !records.length;

  return (
    <main className="dashboard-shell">
      <header className="masthead">
        <div className="brand-lockup">
          <div className="brand-mark">
            <img src="./link-with-buyers-rabbit.png" alt="Link With Buyers rabbit logo" />
          </div>
          <div>
            <p className="eyebrow">Link With Buyers</p>
            <h1>Campaign Activity</h1>
          </div>
        </div>
        <div className="refresh-block">
          <button className="refresh-button" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing…" : records.length ? "Refresh Dashboard" : "Load Dashboard"}
          </button>
          <p>{latestVideoDate ? `Latest Refresh: ${formatDateOnly(latestVideoDate)}` : "Latest Refresh will appear after loading the Sheet."}</p>
        </div>
      </header>

      {error ? <div className="notice error-notice">{error} {records.length ? "Your last saved view is still shown below." : ""}</div> : null}

      {isFirstLoad ? (
        <section className="empty-state">
          <p className="eyebrow">Ready when you are</p>
          <h2>Load the current campaign activity.</h2>
          <p>The first refresh shows the full backlog of people who need attention. Later refreshes identify newly watched videos and new replies.</p>
        </section>
      ) : (
        <>
          <section className="section-heading action-heading action-controls-only">
            <div className="controls">
              <label className="search-field"><span className="sr-only">Search activity</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people or companies" /></label>
            </div>
          </section>
          {pinned.length ? (
            <section className="active-section" aria-live="polite">
              <div className="subsection-heading">
                <h3>Pinned Cards</h3>
                <p>Prospects you have pinned for closer attention.</p>
              </div>
              <div className="lead-grid active-grid">
                {pinned.map((record) => <LeadCard key={record.id} record={record} pinned archived={archivedKeys.includes(archiveKey(record))} draft={noteDrafts[archiveKey(record)]} pending={notePending[archiveKey(record)]} onViewConversation={setSelectedRecord} onArchive={toggleArchive} onPin={togglePin} onDraftChange={changeDraft} onSaved={markSaved} />)}
              </div>
            </section>
          ) : null}
          <section className="all-cards-section" aria-live="polite">
            <div className="subsection-heading">
              <h3>Prospects</h3>
              <p>Most recent video watch first, then most recent video sent.</p>
            </div>
            <div className="lead-grid">
              {unpinnedActions.length ? unpinnedActions.map((record) => <LeadCard key={record.id} record={record} pinned={pinnedKeys.includes(archiveKey(record))} archived={archivedKeys.includes(archiveKey(record))} draft={noteDrafts[archiveKey(record)]} pending={notePending[archiveKey(record)]} onViewConversation={setSelectedRecord} onArchive={toggleArchive} onPin={togglePin} onDraftChange={changeDraft} onSaved={markSaved} />) : <p className="queue-empty">No prospects match this view.</p>}
            </div>
          </section>

          <section className="all-cards-section archive-section" aria-live="polite">
            <div className="subsection-heading">
              <h3>Archive</h3>
              <p>Most recent video watch first.</p>
            </div>
            <div className="lead-grid">
              {archived.length ? archived.map((record) => <LeadCard key={record.id} record={record} pinned={pinnedKeys.includes(archiveKey(record))} archived draft={noteDrafts[archiveKey(record)]} pending={notePending[archiveKey(record)]} onViewConversation={setSelectedRecord} onArchive={toggleArchive} onPin={togglePin} onDraftChange={changeDraft} onSaved={markSaved} />) : <p className="queue-empty">No archived prospects.</p>}
            </div>
          </section>

        </>
      )}
      {selectedRecord ? (
        <div className="conversation-overlay" role="presentation" onMouseDown={() => setSelectedRecord(null)}>
          <section className="conversation-panel" role="dialog" aria-modal="true" aria-labelledby="conversation-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">Initial Conversation</p>
                <h2 id="conversation-title">{selectedRecord.fullName}</h2>
                <p>{[selectedRecord.title, selectedRecord.company, selectedRecord.location].filter(Boolean).join(" · ") || "Profile details unavailable"}</p>
              </div>
              <button className="close-button" onClick={() => setSelectedRecord(null)} aria-label="Close conversation">Close</button>
            </div>
            <ConversationText record={selectedRecord} />
            <div className="panel-footer">
              <span>{formatActivityTime(selectedRecord.timestamp)}</span>
              <div className="card-actions">
                {selectedRecord.profileUrl ? <a className="linkedin-link" href={selectedRecord.profileUrl} target="_blank" rel="noreferrer">Open LinkedIn</a> : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
