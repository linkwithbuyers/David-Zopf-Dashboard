export type ActivityKind =
  | "reply-before-video"
  | "reply"
  | "watched"
  | "connection"
  | "video-sent"
  | "watched-complete"
  | "other";

export type LeadRecord = {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  title: string;
  company: string;
  location: string;
  phone: string;
  email: string;
  profileUrl: string;
  notes: string;
  /** Column F verbatim. This is the editable field the dashboard writes back to. */
  notesCell: string;
  /** Column G verbatim (Summary) -- the LinkedIn transcript. Never mixed with F. */
  conversation: string;
  videoSent: string;
  timestamp: string;
  lastSearched: string;
  eventType: string;
  campaign: string;
  senderName: string;
  kind: ActivityKind;
  priority: number;
  hasReply: boolean;
  hasVideoSent: boolean;
  hasWatched: boolean;
  watchedAt: string;
  hasFollowUp: boolean;
  sourceIncomplete: boolean;
};

type RawRow = Record<string, string>;

const displayNameOverrides: Record<string, string> = {
  "https://www.linkedin.com/in/acoaaajlcqgbp1udv-tbzwoq3wfj8oeljywd3z8": "Christopher Block MBA",
};

export function parseCsv(input: string): RawRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (character === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value || row.length) {
    row.push(value);
    if (row.some((cell) => cell.trim())) rows.push(row);
  }

  const [headers = [], ...data] = rows;
  return data.map((cells) =>
    headers.reduce<RawRow>((record, header, index) => {
      record[header.trim()] = cells[index] ?? "";
      record[`__column_${index}`] = cells[index] ?? "";
      return record;
    }, {}),
  );
}

function clean(value: string | undefined) {
  return (value ?? "").trim();
}

function cell(row: RawRow, header: string, index: number) {
  return clean(row[header]) || clean(row[`__column_${index}`]);
}

function senderNames(senderName: string) {
  const fullName = senderName.trim().toLowerCase();
  return new Set([fullName, ...fullName.split(/\s+/).filter(Boolean)]);
}

function hasInboundReply(notes: string, senderName: string) {
  const ownNames = senderNames(senderName || "David Zopf");
  return notes.split(/\r?\n/).some((line) => {
    const speaker = line.match(/^\s*([^:\n]{1,70}):/i)?.[1]?.trim();
    return Boolean(speaker && !ownNames.has(speaker.toLowerCase()));
  });
}

function activityKind(
  notes: string,
  videoSent: string,
  lastSearched: string,
  eventType: string,
  senderName: string,
): Pick<LeadRecord, "kind" | "priority" | "hasReply" | "hasVideoSent" | "hasWatched" | "watchedAt" | "hasFollowUp"> {
  const hasReply = hasInboundReply(notes, senderName);
  const hasWatched = /\[video wat(?:ched|rched)\]/i.test(notes);
  const ownNames = senderNames(senderName || "David Zopf");
  const hasFollowUp = notes.split(/\r?\n/).some((line) => {
    const match = line.match(/^\s*([^:\n]{1,70}):(.*)$/);
    return Boolean(match && ownNames.has(match[1].trim().toLowerCase()) && /(thank you for watching|i.?m curious to hear|i would love to hear)/i.test(match[2]));
  });
  const videoBlocked = /^0?1\/0?1\/(?:0?1|2001)$/i.test(videoSent);
  const hasVideoSent = !videoBlocked && Boolean(videoSent);
  const watchedAt = hasWatched ? lastSearched : "";

  if (hasReply && !hasVideoSent) {
    return { kind: "reply-before-video", priority: 1, hasReply, hasVideoSent, hasWatched, watchedAt, hasFollowUp };
  }
  if (hasReply) return { kind: "reply", priority: 2, hasReply, hasVideoSent, hasWatched, watchedAt, hasFollowUp };
  if (hasWatched && !hasFollowUp) return { kind: "watched", priority: 3, hasReply, hasVideoSent, hasWatched, watchedAt, hasFollowUp };
  if (hasWatched) return { kind: "watched-complete", priority: 6, hasReply, hasVideoSent, hasWatched, watchedAt, hasFollowUp };
  if (hasVideoSent) return { kind: "video-sent", priority: 5, hasReply, hasVideoSent, hasWatched, watchedAt, hasFollowUp };
  if (/connection_request_accepted|connection request/i.test(eventType)) {
    return { kind: "connection", priority: 5, hasReply, hasVideoSent, hasWatched, watchedAt, hasFollowUp };
  }
  return { kind: "other", priority: 7, hasReply, hasVideoSent, hasWatched, watchedAt, hasFollowUp };
}

function timestampValue(value: string) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

export function normalizeRows(rows: RawRow[]): LeadRecord[] {
  return rows
    .map((row) => {
      // The current feed stores messages in Summary, while some older rows use Notes.
      // Treat either field as the conversation source so every searchable lead is readable.
      const noteText = cell(row, "Notes", 5);
      const summaryText = cell(row, "Summary", 6);
      const notes = noteText || summaryText;
      const timestamp = cell(row, "Timestamp", 12);
      const profileUrl = cell(row, "Lead Profile URL", 8);
      const firstName = cell(row, "Lead First Name", 0);
      const lastName = cell(row, "Lead Last Name", 1);
      const videoSent = cell(row, "Video Sent", 2);
      const lastSearched = cell(row, "Last Searched", 7);
      const senderName = cell(row, "Sender Name", 15) || "David Zopf";
      const details = activityKind([noteText, summaryText].filter(Boolean).join("\n"), videoSent, lastSearched, cell(row, "Event Type", 13), senderName);
      const id = [profileUrl || `${firstName}-${lastName}`, timestamp, notes]
        .join("|")
        .toLowerCase();

      return {
        id,
        firstName,
        lastName,
        fullName: displayNameOverrides[profileUrl.toLowerCase()] || [firstName, lastName].filter(Boolean).join(" ") || "Unnamed prospect",
        title: cell(row, "Lead Title", 9),
        company: cell(row, "Lead Company Name", 11),
        location: cell(row, "Lead Location", 10),
        phone: cell(row, "Lead Phone", 3),
        email: cell(row, "Lead Email", 4),
        profileUrl,
        notes,
        notesCell: noteText,
        conversation: summaryText,
        videoSent,
        timestamp,
        lastSearched,
        eventType: cell(row, "Event Type", 13),
        campaign: cell(row, "Campaign Name", 14),
        senderName,
        ...details,
        sourceIncomplete: !profileUrl || !timestamp || !notes,
      };
    })
    .filter((record, index, all) => all.findIndex((candidate) => candidate.id === record.id) === index)
    .sort((left, right) => timestampValue(right.timestamp) - timestampValue(left.timestamp));
}

export function formatActivityTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value || "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatPhone(value: string) {
  const original = value.trim();
  if (!original) return "";

  const digits = original.replace(/\D/g, "");
  const localNumber = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (localNumber.length !== 10) return original;

  return `(${localNumber.slice(0, 3)}) ${localNumber.slice(3, 6)}-${localNumber.slice(6)}`;
}

export function phoneHref(value: string) {
  const digits = value.replace(/\D/g, "");
  const localNumber = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return localNumber.length === 10 ? `tel:+1${localNumber}` : "";
}

export function emailHref(value: string) {
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `mailto:${email}` : "";
}

export function latestActivity(records: LeadRecord[]) {
  return records.reduce<string>((latest, record) =>
    timestampValue(record.timestamp) > timestampValue(latest) ? record.timestamp : latest,
  "");
}

export function formatDateOnly(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value || "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function latestVideoSent(records: LeadRecord[]) {
  return records.reduce<string>((latest, record) => {
    if (!record.videoSent || /^0?1\/0?1\/(?:0?1|2001)$/i.test(record.videoSent)) return latest;
    return timestampValue(record.videoSent) > timestampValue(latest) ? record.videoSent : latest;
  }, "");
}

export function simplifyLocation(location: string) {
  return location
    .replace(/,?\s*United States(?: of America)?\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
