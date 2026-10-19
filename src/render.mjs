import {pad, str, isoDate} from './utils.mjs';
import {blockText} from './plaud.mjs';

export const NOTE_LANGUAGES = {
	en: {
		summary: 'Summary',
		transcript: 'Transcript',
		otherNote: 'Plaud note',
		untitled: 'Plaud recording',
		noSummary: '_No summary available._',
		noTranscript: '_No transcript available._',
		titleKey: 'title',
		durationKey: 'duration_min',
		timeSeparator: '.',
		speakerSeparator: ':',
		duration: (h, m) => `${h}h${pad(m)}`,
		callout: (d, time, duration) => `Plaud recording · ${isoDate(d)} ${time}${duration ? ` · ${duration}` : ''}`
	},
	fr: {
		summary: 'Résumé',
		transcript: 'Transcription',
		otherNote: 'Note Plaud',
		untitled: 'Enregistrement Plaud',
		noSummary: '_Pas de résumé disponible._',
		noTranscript: '_Pas de transcription disponible._',
		titleKey: 'titre',
		durationKey: 'duree_min',
		timeSeparator: 'h',
		speakerSeparator: ' :',
		duration: (h, m) => `${h} h ${pad(m)}`,
		callout: (d, time, duration) =>
			`Enregistrement Plaud du ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${time}${duration ? ` · ${duration}` : ''}`
	}
};

// Plaud prefixes generated titles with the date ("10-01 Meeting…"), which the file name already has.
export const displayTitle = (name, strings) => str(name).replace(/^\d{2}-\d{2}\s+/, '') || strings.untitled;

// --- Rendering ---

// Timestamps without a time zone are UTC (same rule as the official CLI).
export function parseTimestamp(value) {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	const s = str(value);
	if (!s) return null;
	const normalized = /\d{2}:\d{2}/.test(s) && !/(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/.test(s) ? `${s}Z` : s;
	const ms = new Date(normalized).getTime();
	return Number.isNaN(ms) ? null : ms;
}

function clock(ms) {
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function humanDuration(ms, strings) {
	if (!ms || ms < 0) return '';
	const minutes = Math.round(ms / 60000);
	if (minutes < 1) return `${Math.round(ms / 1000)} s`;
	if (minutes < 60) return `${minutes} min`;
	return strings.duration(Math.floor(minutes / 60), minutes % 60);
}

// The summary sits under a level-2 heading: its own headings start at level 3.
function demoteHeadings(markdown) {
	const lines = markdown.split('\n');
	const outsideFences = (fn) => {
		let inFence = false;
		return lines.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
			return inFence ? line : fn(line);
		});
	};

	let top = 7;
	outsideFences((line) => {
		const level = /^(#{1,6})\s/.exec(line)?.[1].length;
		if (level) top = Math.min(top, level);
		return line;
	});
	const shift = Math.max(0, 3 - top);
	if (shift === 0) return markdown;

	return outsideFences((line) => line.replace(/^(#{1,6})(?=\s)/, (hashes) => '#'.repeat(Math.min(6, hashes.length + shift)))).join('\n');
}

function cleanNoteText(raw) {
	let text = raw.trim();
	if (text.startsWith('{') || text.startsWith('"')) {
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed === 'string') {
				text = parsed;
			} else if (parsed && typeof parsed === 'object') {
				text = str(parsed.ai_content) || str(parsed.content) || str(parsed.summary) || text;
			}
		} catch {
			// plain text
		}
	}
	// Summaries start with image links internal to the Plaud app (plaud://…), useless in Obsidian.
	text = text.replace(/!?\[[^\]]*\]\(plaud:\/\/[^)]*\)[ \t]*\n?/g, '');
	// A "---" right under a paragraph would turn it into a heading (Setext syntax): separate them.
	text = text.replace(/([^\n])\n(-{3,}|\*{3,}|_{3,})[ \t]*(?=\n|$)/g, '$1\n\n$2');
	return demoteHeadings(text.trim());
}

function renderTranscript(raw, strings) {
	const text = raw.trim();
	if (!text) return '';

	let segments;
	try {
		segments = JSON.parse(text);
	} catch {
		return text;
	}
	if (!Array.isArray(segments)) return text;

	// Consecutive segments from the same speaker are merged into one paragraph.
	const paragraphs = [];
	for (const segment of segments) {
		const content = str(segment?.content);
		if (!content) continue;
		const speaker = str(segment?.speaker);
		const previous = paragraphs.at(-1);
		if (previous && speaker && previous.speaker === speaker) {
			previous.text += ` ${content}`;
			continue;
		}
		const time = typeof segment?.start_time === 'number' ? clock(segment.start_time) : '';
		paragraphs.push({speaker, time, text: content});
	}

	return paragraphs
		.map((p) => {
			const label = [p.time && `[${p.time}]`, p.speaker].filter(Boolean).join(' ');
			return label ? `**${label}**${strings.speakerSeparator} ${p.text}` : p.text;
		})
		.join('\n\n');
}

export async function loadContent(detail, ctx, strings) {
	const sources = Array.isArray(detail.source_list) ? detail.source_list : [];
	const notes = Array.isArray(detail.note_list) ? detail.note_list : [];

	const transcriptBlock = sources.find((s) => s?.data_type === 'transaction');
	const transcript = transcriptBlock ? renderTranscript(await blockText(transcriptBlock, ctx), strings) : '';

	const sections = [];
	let hasMainSummary = false;
	for (const note of notes) {
		const text = cleanNoteText(await blockText(note, ctx));
		if (!text) continue;
		const isMainSummary = note.data_type === 'auto_sum_note' && !hasMainSummary;
		if (isMainSummary) hasMainSummary = true;
		const heading = isMainSummary ? strings.summary : str(note.data_tab_name) || str(note.data_title) || strings.otherNote;
		sections[isMainSummary ? 'unshift' : 'push']({heading, text});
	}

	return {transcript, sections};
}

function noteFileName(date, time, title, strings) {
	const sep = strings.timeSeparator;
	const full = title
		.replace(/(\d{2}):(\d{2})(?::\d{2})?/g, `$1${sep}$2`)
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[.\s]+|[.\s]+$/g, '');
	const clean = full.length <= 100 ? full : full.slice(0, 100).replace(/\s+\S*$/, '').replace(/[\s,;:(–—-]+$/, '');
	if (/^\d{4}-\d{2}-\d{2}/.test(clean)) return `${clean}.md`;
	return `${date} ${time.replace(':', sep)} - ${clean || strings.untitled}.md`;
}

export function renderNote(file, content, {includeTranscript, strings}) {
	const title = displayTitle(file.name, strings);
	const startMs = parseTimestamp(file.start_at) ?? parseTimestamp(file.created_at) ?? Date.now();
	const d = new Date(startMs);
	const date = isoDate(d);
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const duration = humanDuration(file.duration, strings);

	const lines = ['---', `plaud_id: ${file.id}`, `${strings.titleKey}: ${JSON.stringify(title)}`, `date: ${date}T${time}`];
	if (file.duration > 0) lines.push(`${strings.durationKey}: ${Math.max(1, Math.round(file.duration / 60000))}`);
	lines.push('source: plaud', 'tags:', '  - plaud', '---', '', `# ${title}`, '', `> [!info] ${strings.callout(d, time, duration)}`, '');

	const sections = content.sections.length > 0 ? content.sections : [{heading: strings.summary, text: strings.noSummary}];
	for (const section of sections) {
		lines.push(`## ${section.heading}`, '', section.text, '');
	}
	// Without a summary the transcript is kept even if not wanted: it is all there is.
	if (includeTranscript || content.sections.length === 0) {
		lines.push(`## ${strings.transcript}`, '', content.transcript || strings.noTranscript, '');
	}

	return {fileName: noteFileName(date, time, title, strings), text: lines.join('\n')};
}

