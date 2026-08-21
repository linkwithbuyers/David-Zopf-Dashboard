"use client";

import { useCallback, useMemo, useState } from "react";
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

// The Sheet is the single source of truth. Pin ("P") and Archive ("A") live in
// column W; notes live in column F. Nothing about pins, archives, or the view is
// cached in the browser anymore -- every read comes from the CSV export and every
// write goes straight to the Apps Script endpoint.

type StatusValue = "P" | "A" | "";

function statusKey(record: LeadRecord) {
  return record.profileUrl || (record.firstName + "-" + record.lastName).toLowerCase();
}

// Column W as it currently stands. "P" = pinned, "A" = archived, blank = neither.
function effectiveStatus(record: LeadRecord) {
  const cell = (record.statusCell || "").trim().toUpperCase();
  if (cell === "P") return "P";
  if (cell === "A") return "A";
  return "";
}

function WatchedIndicator({ date, complete }: { date: string; complete: boolean }) {
  return (
    <span className={complete ? "watched-indicator complete" : "watched-indicator"} style={complete ? { color: "#1e7b52", fontWeight: 700 } : undefined}>
      {complete ? "\u2713 " : ""}Video watched{date ? ": " + formatDateOnly(date) : complete ? ": date unavailable" : ""}
    </span>
  );
}

function ContactValue({ href, text, fallback }: { href: string; text: string; fallback: string }) {
  if (!text) return <>{fallback}</>;
  if (!href) return <>{text}</>;
  return <a href={href} onClick={(event) => event.stopPropagation()}>{text}</a>;
}

type PendingNote = { value: string; savedAt: number };
type SaveState = "idle" | "saving" | "saved" | "error";

function effectiveNote(base: string, draft: string | undefined) {
  if (draft !== undefined) return draft;
  return base;
}

// POST to the Apps Script web app. text/plain keeps the request "simple" so the
// browser skips the CORS preflight, which Apps Script cannot answer.
async function postToSheet(record: LeadRecord, payloadExtra: Record<string, unknown>) {
  if (!notesConfig.endpoint) throw new Error("The Sheet endpoint is not configured yet.");
  const response = await fetch(notesConfig.endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      token: notesConfig.token,
      sheetId: sourceConfig.sheetId,
      gid: sourceConfig.sheetGid,
      profileUrl: record.profileUrl,
      fullName: record.fullName,
      ...payloadExtra,
    }),
    redirect: "follow",
  });
  if (!response.ok) throw new Error("The Sheet rejected the write (" + response.status + ").");
  const payload = await response.json().catch(() => null);
  if (!payload || payload.ok !== true) {
    throw new Error(payload && payload.error ? String(payload.error) : "The Sheet write failed.");
  }
  return payload;
}

async function postNote(record: LeadRecord, value: string) {
  return postToSheet(record, { notes: value });
}

async function postStatus(record: LeadRecord, value: StatusValue) {
  return postToSheet(record, { status: value });
}

function NotesEditor({ record, draft, onDraftChange, onSaved }: { record: LeadRecord; draft?: string; onDraftChange: (record: LeadRecord, value: string | undefined) => void; onSaved: (record: LeadRecord, value: string) => void }) {
  const shown = effectiveNote(record.notesCell, draft);
  const [state, setState] = useState<SaveState>("idle");
  const [message, setMessage] = useState("");
  const dirty = draft !== undefined && draft !== record.notesCell;
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
  const statusLabel = state === "saving" ? "Saving to Sheet\u2026" : state === "saved" ? "Saved to Sheet" : state === "error" ? message || "Save failed" : dirty ? "Unsaved" : "";
  return (
    <div className="notes-block" onMouseDown={(event) => event.stopPropagation()}>
      <div className="notes-label">Notes {statusLabel ? <span className="notes-status">{statusLabel}</span> : null}</div>
      <textarea className="notes-inline-editor" value={shown} onChange={(event) => onDraftChange(record, event.target.value)} onBlur={() => { if (dirty) void save(); }} rows={4} placeholder="Add notes for this prospect..." style={{ width: "100%", padding: "8px", fontFamily: "inherit", fontSize: "0.9em", resize: "vertical", boxSizing: "border-box" }} />
      {dirty || state === "error" ? (
        <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
          <button className="card-toggle" onClick={() => void save()} disabled={state === "saving"}>{state === "saving" ? "Saving\u2026" : state === "error" ? "Retry save" : "Save to Sheet"}</button>
          <button className="card-toggle" onClick={() => { onDraftChange(record, undefined); setState("idle"); setMessage(""); }} disabled={state === "saving"}>Discard</button>
        </div>
      ) : null}
    </div>
  );
}

function LeadCard({ record, archived, pinned, busy, draft, onViewConversation, onArchive, onPin, onDraftChange, onSaved }: { record: LeadRecord; archived?: boolean; pinned?: boolean; busy?: boolean; draft?: string; onViewConversation: (record: LeadRecord) => void; onArchive: (record: LeadRecord) => void; onPin: (record: LeadRecord) => void; onDraftChange: (record: LeadRecord, value: string | undefined) => void; onSaved: (record: LeadRecord, value: string) => void }) {
  return (
    <article className="lead-card">
      <div className="lead-heading">
        <div>
          <h3>{record.fullName}</h3>
          <p className="lead-title">{[record.title, record.company].filter(Boolean).join(" at ") || "Profile details unavailable"}</p>
          <p className="contact-line"><span className="contact-label">email:</span> <ContactValue href={emailHref(record.email)} text={record.email} fallback="Email unavailable" /></p>
          <p className="contact-line"><span className="contact-label">tel:</span> <ContactValue href={phoneHref(record.phone)} text={formatPhone(record.phone)} fallback="Phone unavailable" /></p>
        </div>
        {record.location ? <span className="location">{simplifyLocation(record.location)}</span> : null}
      </div>
      <div className="progress-indicators" aria-label="Video progress">
        <span className="video-sent-text">Video sent{record.videoSent ? ": " + formatDateOnly(record.videoSent) : ""}</span>
        <WatchedIndicator date={record.watchedAt} complete={record.hasWatched} />
      </div>
      {record.kind === "reply-before-video" ? <p className="manual-note">Stop video manually in the Sheet if needed.</p> : null}
      {record.sourceIncomplete ? <p className="data-note">Some source details are incomplete.</p> : null}
      <NotesEditor record={record} draft={draft} onDraftChange={onDraftChange} onSaved={onSaved} />
      <div className="card-footer">
        <div className="card-actions card-toggle-actions">
          <button className={"card-toggle archive-button " + (archived ? "restore-button" : "")} onClick={() => onArchive(record)} disabled={busy}>{archived ? "Restore" : "Archive"}</button>
          <button className={"card-toggle pin-button " + (pinned ? "pinned" : "")} onClick={() => onPin(record)} disabled={busy}>{pinned ? "Unpin" : "Pin"}</button>
          <button className="card-toggle conversation-button" onClick={() => onViewConversation(record)}>Initial Outreach</button>
          {record.profileUrl ? (
            <a className="card-toggle linkedin-link" href={record.profileUrl} target="_blank" rel="noreferrer">Open LinkedIn</a>
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
          <p className="message-line" key={index + "-" + line.slice(0, 20)}>
            {match && isKnownSpeaker ? <><strong>{speaker}:</strong>{message}</> : line}
          </p>
        );
      })}
    </div>
  );
}

export default function Home() {
  const [records, setRecords] = useState<LeadRecord[]>([]);
  const [refreshedAt, setRefreshedAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedRecord, setSelectedRecord] = useState<LeadRecord | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  // Cards mid-write to column W. Their buttons disable so a second click cannot
  // race the Sheet, and the optimistic status shows immediately.
  const [statusBusy, setStatusBusy] = useState<Record<string, boolean>>({});
  const [optimisticStatus, setOptimisticStatus] = useState<Record<string, StatusValue>>({});

  // The stored column W value unless an in-flight write has set something newer.
  const currentStatus = useCallback((record: LeadRecord): StatusValue => {
    const key = statusKey(record);
    return key in optimisticStatus ? optimisticStatus[key] : effectiveStatus(record);
  }, [optimisticStatus]);

  const writeStatus = useCallback(async (record: LeadRecord, next: StatusValue) => {
    const key = statusKey(record);
    const previous = currentStatus(record);
    setStatusBusy((current) => ({ ...current, [key]: true }));
    setOptimisticStatus((current) => ({ ...current, [key]: next }));
    try {
      await postStatus(record, next);
    } catch (caught) {
      setOptimisticStatus((current) => ({ ...current, [key]: previous }));
      setError(caught instanceof Error ? caught.message : "The status could not be saved.");
    } finally {
      setStatusBusy((current) => ({ ...current, [key]: false }));
    }
  }, [currentStatus]);

  const togglePin = (record: LeadRecord) => {
    const next: StatusValue = currentStatus(record) === "P" ? "" : "P";
    void writeStatus(record, next);
  };

  const toggleArchive = (record: LeadRecord) => {
    const next: StatusValue = currentStatus(record) === "A" ? "" : "A";
    void writeStatus(record, next);
  };

  const changeDraft = (record: LeadRecord, value: string | undefined) => {
    const key = statusKey(record);
    setNoteDrafts((current) => {
      const nextDrafts = { ...current };
      if (value === undefined) delete nextDrafts[key];
      else nextDrafts[key] = value;
      return nextDrafts;
    });
  };

  const markSaved = (record: LeadRecord, _value: string) => {
    const key = statusKey(record);
    setNoteDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[key];
      return nextDrafts;
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
      const endpoint = "https://docs.google.com/spreadsheets/d/" + sheetId + "/export?format=csv&gid=" + sheetGid;
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("The Sheet could not be read right now.");
      const nextRecords = normalizeRows(parseCsv(await response.text()));
      if (!nextRecords.length) throw new Error("The Sheet returned no usable activity records.");
      // The Sheet is authoritative: drop optimistic status so column W shows through.
      setOptimisticStatus({});
      setRecords(nextRecords);
      setRefreshedAt(new Date().toISOString());
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

  const activeRecords = searchedRecords.filter((record) => currentStatus(record) !== "A");
  const archivedRecords = searchedRecords.filter((record) => currentStatus(record) === "A");
  // Only prospects who have watched the video are surfaced as action cards.
  const actionRecords = activeRecords.filter((record) => record.priority <= 3 && record.hasWatched);

  const byRecency = (left: LeadRecord, right: LeadRecord) => {
    const leftWatchTime = left.hasWatched ? Date.parse(left.watchedAt) || 0 : 0;
    const rightWatchTime = right.hasWatched ? Date.parse(right.watchedAt) || 0 : 0;
    const leftSentTime = Date.parse(left.videoSent) || 0;
    const rightSentTime = Date.parse(right.videoSent) || 0;
    return rightWatchTime - leftWatchTime || rightSentTime - leftSentTime || Date.parse(right.timestamp) - Date.parse(left.timestamp);
  };

  const actions = [...actionRecords].sort(byRecency);
  const pinned = actions.filter((record) => currentStatus(record) === "P");
  const unpinnedActions = actions.filter((record) => currentStatus(record) !== "P");
  const archived = [...archivedRecords].sort(byRecency);

  const latestVideoDate = latestVideoSent(records);
  const isFirstLoad = !refreshedAt && !records.length;
  const busyFor = (record: LeadRecord) => Boolean(statusBusy[statusKey(record)]);

  return (
    <main className="dashboard-shell">
      <header className="masthead">
        <div className="brand-lockup">
          <div className="brand-mark"><img src="./link-with-buyers-rabbit.png" alt="Link With Buyers rabbit logo" /></div>
          <div>
            <p className="eyebrow">Link With Buyers</p>
            <h1>Campaign Activity</h1>
          </div>
        </div>
        <div className="refresh-block">
          <button className="refresh-button" onClick={refresh} disabled={loading}>{loading ? "Refreshing\u2026" : records.length ? "Refresh Dashboard" : "Load Dashboard"}</button>
          <p>{latestVideoDate ? "Latest Refresh: " + formatDateOnly(latestVideoDate) : "Latest Refresh will appear after loading the Sheet."}</p>
        </div>
      </header>
      {error ? <div className="notice error-notice">{error}</div> : null}
      {isFirstLoad ? (
        <section className="empty-state">
          <p className="eyebrow">Ready when you are</p>
          <h2>Load the current campaign activity.</h2>
          <p>The dashboard shows prospects who have watched the video. Pins and archives are saved straight to the Sheet.</p>
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
                {pinned.map((record) => <LeadCard key={record.id} record={record} pinned archived={currentStatus(record) === "A"} busy={busyFor(record)} draft={noteDrafts[statusKey(record)]} onViewConversation={setSelectedRecord} onArchive={toggleArchive} onPin={togglePin} onDraftChange={changeDraft} onSaved={markSaved} />)}
              </div>
            </section>
          ) : null}

          <section className="all-cards-section" aria-live="polite">
            <div className="subsection-heading">
              <h3>Prospects</h3>
              <p>Most recent video watch first, then most recent video sent.</p>
            </div>
            <div className="lead-grid">
              {unpinnedActions.length ? unpinnedActions.map((record) => <LeadCard key={record.id} record={record} pinned={currentStatus(record) === "P"} archived={currentStatus(record) === "A"} busy={busyFor(record)} draft={noteDrafts[statusKey(record)]} onViewConversation={setSelectedRecord} onArchive={toggleArchive} onPin={togglePin} onDraftChange={changeDraft} onSaved={markSaved} />) : <p className="queue-empty">No prospects match this view.</p>}
            </div>
          </section>

          <section className="all-cards-section archive-section" aria-live="polite">
            <div className="subsection-heading">
              <h3>Archive</h3>
              <p>Most recent video watch first.</p>
            </div>
            <div className="lead-grid">
              {archived.length ? archived.map((record) => <LeadCard key={record.id} record={record} pinned={currentStatus(record) === "P"} archived busy={busyFor(record)} draft={noteDrafts[statusKey(record)]} onViewConversation={setSelectedRecord} onArchive={toggleArchive} onPin={togglePin} onDraftChange={changeDraft} onSaved={markSaved} />) : <p className="queue-empty">No archived prospects.</p>}
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
                <p>{[selectedRecord.title, selectedRecord.company, selectedRecord.location].filter(Boolean).join(" \u00b7 ") || "Profile details unavailable"}</p>
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
