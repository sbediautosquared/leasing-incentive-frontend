"use client";

import { ChangeEvent, DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { HeaderAccount } from "@/components/header-account";
import { apiFetch } from "@/lib/api";

type Status = "ready" | "needs_parser" | "queued" | "parsing" | "completed" | "failed";
type View = "import" | "review";
type RowSort = "make" | "vehicle_line" | "model_code" | "trim_description" | "term_months" | "residual_percent";
type SortDirection = "asc" | "desc";
type ImportEvent = { at: string; type: string; message: string };
type ImportRecord = {
  id: string;
  filename: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  status: Status;
  error?: string | null;
  events?: ImportEvent[];
  detection: { brand?: string | null; confidence?: number; reason?: string; parser_key?: string | null };
  parse_options: { parser_key: string; extractor: string };
  result?: {
    rows_extracted: number;
    rows_clean: number;
    rows_quarantined: number;
    rows_needing_review: number;
    effective_month?: string | null;
    quality_flags?: Record<string, number>;
  } | null;
};
// POST /api/imports returns an ImportRecord plus dedup markers the backend adds:
// `duplicate`/`duplicate_of` when the exact bytes were already imported, and
// `filename_warning` when a new file reuses a prior import's filename.
type UploadResponse = ImportRecord & {
  duplicate?: boolean;
  duplicate_of?: string;
  filename_warning?: { existing_id: string; filename: string };
  detail?: string;
};
type MessageTone = "info" | "warning" | null;
type RowsResponse = { items: Record<string, unknown>[]; total: number; page: number; page_size: number; makes: string[] };
type QualityReport = {
  input_rows: number;
  duplicates_removed: number;
  clean_rows: number;
  quarantined_rows: number;
  hard_error_breakdown: Record<string, number>;
  soft_flag_breakdown: Record<string, number>;
  non_monotonic_term_rows: number;
  coverage: {
    distinct_model_codes: number;
    distinct_vehicle_lines: number;
    wildcard_codes: number;
    rows_with_mrm: number;
    term_coverage: Record<string, number>;
    makes: Record<string, number>;
  };
};

const STATUS_COPY: Record<Status, string> = {
  ready: "Ready to parse",
  needs_parser: "Needs routing",
  queued: "Queued",
  parsing: "Parsing",
  completed: "Complete",
  failed: "Needs attention",
};
const ROW_COLUMNS: Array<{ key: RowSort; label: string; numeric?: boolean }> = [
  { key: "make", label: "Make" },
  { key: "vehicle_line", label: "Vehicle line" },
  { key: "model_code", label: "Model code" },
  { key: "trim_description", label: "Trim" },
  { key: "term_months", label: "Term", numeric: true },
  { key: "residual_percent", label: "Residual", numeric: true },
];

const RUN_TITLE: Record<Status, string> = {
  ready: "Ready to parse",
  needs_parser: "Needs a supported parser",
  queued: "Queued for parsing",
  parsing: "Parsing in progress",
  completed: "Parsing complete",
  failed: "Import didn’t complete",
};

const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;
const formatDate = (value: string) => new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const formatTime = (value: string) => new Intl.DateTimeFormat("en-CA", { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(value));
const getString = (value: unknown) => String(value ?? "—");

// Plain-English copy for the raw validation keys the parser emits, so the
// quality report reads like sentences instead of snake_case. Unknown/future
// keys fall back to a humanized label (see `humanizeKey`) rather than breaking.
const ISSUE_COPY: Record<string, { label: string; detail: string }> = {
  missing_model_code: { label: "Missing model code", detail: "No model code on the row, so it can’t be matched to a vehicle." },
  missing_trim_description: { label: "Missing trim description", detail: "The trim / description cell was empty." },
  invalid_term: { label: "Invalid lease term", detail: "Term wasn’t one of 24, 36, 48, or 60 months." },
  residual_out_of_range: { label: "Residual out of range", detail: "Residual percent fell outside 0–100%." },
  missing_model_year: { label: "Missing model year", detail: "Model year couldn’t be read. The row was kept." },
  missing_make: { label: "Missing make", detail: "No make on the row. Kept, but harder to group." },
  missing_vehicle_line: { label: "Missing vehicle line", detail: "No vehicle line on the row. Kept, but harder to group." },
  very_low_residual: { label: "Very low residual", detail: "Residual under 10% — unusually low. Verify against the source." },
  very_high_residual: { label: "Very high residual", detail: "Residual above 85% — unusually high. Verify against the source." },
  non_monotonic_term: { label: "Residual rises with term", detail: "Residual increased as the lease term lengthened, which is unexpected." },
};
const humanizeKey = (key: string) => key.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());
const issueCopy = (key: string) => ISSUE_COPY[key] ?? { label: humanizeKey(key), detail: "" };
const sumValues = (record: Record<string, number>) => Object.values(record).reduce((total, value) => total + value, 0);
const pctLabel = (value: number, total: number) => {
  if (total <= 0) return "0%";
  const percent = (value / total) * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
};

export default function Home() {
  const { profile } = useAuth();
  const superadminAccess = profile?.access === "superadmin";
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [parser, setParser] = useState("auto");
  const [extractor, setExtractor] = useState("camelot");
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [selected, setSelected] = useState<ImportRecord | null>(null);
  const [rows, setRows] = useState<RowsResponse>({ items: [], total: 0, page: 1, page_size: 25, makes: [] });
  const [view, setView] = useState<View>("review");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [makeFilter, setMakeFilter] = useState("all");
  const [sort, setSort] = useState<{ key: RowSort; direction: SortDirection }>({ key: "vehicle_line", direction: "asc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [importsLoading, setImportsLoading] = useState(true);
  const [importsError, setImportsError] = useState<string | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<MessageTone>(null);
  const notify = useCallback((text: string | null, tone: MessageTone = null) => {
    setMessage(text);
    setMessageTone(tone);
  }, []);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [qualityError, setQualityError] = useState<string | null>(null);

  const refreshImports = useCallback(async () => {
    setImportsLoading(true);
    setImportsError(null);
    try {
      const response = await apiFetch("/api/imports", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load the import history.");
      const records = (await response.json()) as ImportRecord[];
      setImports(records);
      setSelected((current) => current ? records.find((item) => item.id === current.id) ?? records[0] ?? null : records[0] ?? null);
    } catch (error) {
      setImportsError(error instanceof Error ? error.message : "Could not load the import history.");
    } finally {
      setImportsLoading(false);
    }
  }, []);

  const refreshRows = useCallback(async () => {
    if (!selected || selected.status !== "completed") {
      setRows({ items: [], total: 0, page: 1, page_size: pageSize, makes: [] });
      return;
    }
    setRowsLoading(true);
    setRowsError(null);
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize), sort_by: sort.key, sort_direction: sort.direction });
      if (query.trim()) params.set("query", query.trim());
      if (makeFilter !== "all") params.set("make", makeFilter);
      const response = await apiFetch(`/api/imports/${selected.id}/rows?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load standardized rows.");
      const payload = (await response.json()) as RowsResponse;
      const lastPage = Math.max(1, Math.ceil(payload.total / pageSize));
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setRows(payload);
    } catch (error) {
      setRowsError(error instanceof Error ? error.message : "Could not load standardized rows.");
    } finally {
      setRowsLoading(false);
    }
  }, [makeFilter, page, pageSize, query, selected, sort]);

  // The request starts after mount; the loading state is part of that external synchronization.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refreshImports(); }, [refreshImports]);
  useEffect(() => {
    const active = imports.some((item) => item.status === "queued" || item.status === "parsing");
    if (!active) return;
    const interval = window.setInterval(() => void refreshImports(), 2000);
    return () => window.clearInterval(interval);
  }, [imports, refreshImports]);
  // The selected import and its query controls synchronize with a remote page of rows.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refreshRows(); }, [refreshRows]);

  const chooseFile = (candidate: File | undefined) => {
    if (!candidate) return;
    if (candidate.type !== "application/pdf" && !candidate.name.toLowerCase().endsWith(".pdf")) {
      notify("Choose a PDF file to import.", "warning");
      return;
    }
    setFile(candidate);
    notify(null);
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => chooseFile(event.target.files?.[0]);
  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files?.[0]);
  };
  const resetQuality = () => { setQualityOpen(false); setQuality(null); setQualityError(null); };
  const selectImport = (item: ImportRecord) => {
    setSelected(item);
    setView("review");
    setSourceOpen(false);
    resetQuality();
    setQuery("");
    setMakeFilter("all");
    setPage(1);
  };
  const beginImport = () => {
    setView("import");
    setSourceOpen(false);
    resetQuality();
    notify(null);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) { notify("Choose a PDF before starting an import.", "warning"); return; }
    setBusy(true);
    notify(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("parser_key", parser);
      const uploaded = await apiFetch("/api/imports", { method: "POST", body: form });
      const uploadPayload = (await uploaded.json()) as UploadResponse;
      if (!uploaded.ok) throw new Error(uploadPayload.detail ?? "The upload could not be saved.");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";

      // Exact duplicate: these bytes were already imported. Skip the /run call —
      // re-running would re-queue and re-parse the existing import. Just show it.
      if (uploadPayload.duplicate) {
        await refreshImports();
        setSelected(uploadPayload);
        setView("review");
        const when = formatDate(uploadPayload.created_at);
        const stateHint = uploadPayload.status === "completed" ? "" : ` (${STATUS_COPY[uploadPayload.status]})`;
        notify(`Already imported — this exact file was uploaded on ${when}. Showing the existing import${stateHint}.`, "info");
        return;
      }

      const run = await apiFetch(`/api/imports/${uploadPayload.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parser_key: parser, extractor }) });
      const runPayload = await run.json();
      if (!run.ok) throw new Error(runPayload.detail ?? "The import could not start.");
      setSelected(runPayload);
      setView("review");
      const warning = uploadPayload.filename_warning;
      if (warning) {
        notify(`Saved as a new import. A file named “${warning.filename}” was imported before, but this upload’s content differs.`, "warning");
      } else {
        notify(runPayload.status === "needs_parser" ? "The file is stored. Its brand needs a supported parser before it can run." : "Import queued. The review workspace will update as parsing finishes.", "info");
      }
      await refreshImports();
    } catch (error) {
      notify(error instanceof Error ? error.message : "The import could not be started.", "warning");
    } finally {
      setBusy(false);
    }
  };
  const retryImport = async () => {
    if (!selected) return;
    setRetrying(true);
    notify(null);
    try {
      const response = await apiFetch(`/api/imports/${selected.id}/retry`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "The import could not be retried.");
      setSelected(payload);
      notify("Retry queued. The review workspace will update as parsing finishes.", "info");
      await refreshImports();
    } catch (error) {
      notify(error instanceof Error ? error.message : "The import could not be retried.", "warning");
    } finally {
      setRetrying(false);
    }
  };
  const openQuality = useCallback(async () => {
    if (!selected) return;
    setSourceOpen(false);
    setQualityOpen(true);
    setQualityLoading(true);
    setQualityError(null);
    try {
      const response = await apiFetch(`/api/imports/${selected.id}/artifacts/quality-report`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "This import doesn’t have a quality report yet." : "Could not load the quality report.");
      setQuality((await response.json()) as QualityReport);
    } catch (error) {
      setQuality(null);
      setQualityError(error instanceof Error ? error.message : "Could not load the quality report.");
    } finally {
      setQualityLoading(false);
    }
  }, [selected]);
  const closeQuality = useCallback(() => setQualityOpen(false), []);
  const updateQuery = (value: string) => { setQuery(value); setPage(1); };
  const updateMake = (value: string) => { setMakeFilter(value); setPage(1); };
  const updateSort = (key: RowSort) => {
    setSort((current) => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" });
    setPage(1);
  };
  const isImportView = view === "import" || !selected;

  return (
    <main className="app-frame">
      <a className="skip-link" href="#workspace">Skip to workspace</a>
      <header className="app-header">
        <button className="wordmark" type="button" onClick={() => selected ? setView("review") : beginImport()} aria-label="Lease Ledger home">
          <span className="wordmark-mark" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor"><rect x="4.5" y="5.5" width="11" height="1.75" /><rect x="4.5" y="9.125" width="11" height="1.75" /><rect x="4.5" y="12.75" width="6.5" height="1.75" /></svg>
          </span>
          <span className="wordmark-text">Lease Ledger</span>
        </button>
        <p className="header-context">Residual file workspace</p>
        <HeaderAccount />
      </header>
      <div className="app-shell">
        <aside className="imports-rail" aria-label="Import history">
          <div className="rail-heading"><div><h2>Imports</h2><p>{imports.length} saved file{imports.length === 1 ? "" : "s"}</p></div>{superadminAccess && <button className="new-import" type="button" onClick={beginImport}><span aria-hidden="true">+</span>New import</button>}</div>
          <div className="rail-list">
            {importsLoading ? <RailLoading /> : importsError ? <RailError message={importsError} onRetry={refreshImports} /> : imports.length === 0 ? <p className="rail-empty">Your imported PDFs will appear here. Start with a monthly residual file.</p> : imports.map((item) => <button key={item.id} className={`rail-item ${selected?.id === item.id && !isImportView ? "is-selected" : ""}`} type="button" onClick={() => selectImport(item)}><span className={`status-mark status-${item.status}`} aria-hidden="true" /><span className="rail-item-copy"><strong>{item.filename}</strong><small>{item.detection.brand ?? "Brand pending"} · {formatDate(item.created_at)}</small></span><span className={`rail-item-status status-${item.status}`}>{item.result ? `${item.result.rows_clean.toLocaleString()} rows` : STATUS_COPY[item.status]}</span></button>)}
          </div>
        </aside>
        <section className="workspace" id="workspace">
          {isImportView ? superadminAccess ? <ImportStage file={file} dragging={dragging} parser={parser} extractor={extractor} busy={busy} message={message} messageTone={messageTone} fileInput={fileInput} onSubmit={submit} onChooseFile={handleFileInput} onDrop={handleDrop} onDragChange={setDragging} onParserChange={setParser} onExtractorChange={setExtractor} /> : <ReadOnlyEmptyState /> : selected && <ReviewStage selected={selected} rows={rows} query={query} makeFilter={makeFilter} sort={sort} page={page} pageSize={pageSize} sourceOpen={sourceOpen} message={message} messageTone={messageTone} rowsLoading={rowsLoading} rowsError={rowsError} retrying={retrying} onQueryChange={updateQuery} onMakeChange={updateMake} onSortChange={updateSort} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} onRowsRetry={refreshRows} onImportRetry={retryImport} onSourceToggle={() => { setSourceOpen((open) => !open); setQualityOpen(false); }} onSourceClose={() => setSourceOpen(false)} quality={quality} qualityOpen={qualityOpen} qualityLoading={qualityLoading} qualityError={qualityError} onOpenQuality={openQuality} onCloseQuality={closeQuality} />}
        </section>
      </div>
    </main>
  );
}

function ReadOnlyEmptyState() { return <div className="run-state"><span className="status-mark status-failed" aria-hidden="true" /><div><strong>Superadmin access required.</strong><p>Only accounts with superadmin access can use the Lease Ledger workspace.</p></div></div>; }

function RailLoading() { return <div className="rail-loading" aria-label="Loading imports"><span /><span /><span /></div>; }
function RailError({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) { return <div className="rail-error"><strong>Imports unavailable</strong><p>{message}</p><button type="button" onClick={() => void onRetry()}>Try again</button></div>; }
// A status message with an optional tone: `info` for neutral confirmations (e.g.
// a re-upload resolving to an existing import), `warning` for advisories (e.g. a
// reused filename or a soft validation problem). No tone renders the plain note.
function Notice({ message, tone, className }: { message: string; tone: MessageTone; className?: string }) {
  return (
    <p className={`notice${tone ? ` is-${tone}` : ""}${className ? ` ${className}` : ""}`} role="status">
      {tone && <span className="notice-dot" aria-hidden="true" />}
      <span>{message}</span>
    </p>
  );
}

type ImportStageProps = { file: File | null; dragging: boolean; parser: string; extractor: string; busy: boolean; message: string | null; messageTone: MessageTone; fileInput: React.RefObject<HTMLInputElement | null>; onSubmit: (event: FormEvent) => void; onChooseFile: (event: ChangeEvent<HTMLInputElement>) => void; onDrop: (event: DragEvent<HTMLButtonElement>) => void; onDragChange: (value: boolean) => void; onParserChange: (value: string) => void; onExtractorChange: (value: string) => void; };
function ImportStage({ file, dragging, parser, extractor, busy, message, messageTone, fileInput, onSubmit, onChooseFile, onDrop, onDragChange, onParserChange, onExtractorChange }: ImportStageProps) {
  return <div className="import-stage"><div className="stage-heading"><div><h1>Upload a residual PDF.</h1><p>We’ll route and parse it, then keep the source and review artifacts together.</p></div></div><form className="import-form" onSubmit={onSubmit}><button type="button" className={`dropzone ${dragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`} onClick={() => fileInput.current?.click()} onDrop={onDrop} onDragOver={(event) => { event.preventDefault(); onDragChange(true); }} onDragLeave={() => onDragChange(false)}><span className="dropzone-icon" aria-hidden="true">↓</span>{file ? <><strong>{file.name}</strong><small>{formatBytes(file.size)} · ready to parse</small></> : <><strong>Drop a residual PDF here</strong><small>or choose a file from your computer</small></>}</button><input ref={fileInput} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={onChooseFile} /><div className="import-controls"><label><span>Document routing</span><select value={parser} onChange={(event) => onParserChange(event.target.value)}><option value="auto">Auto-detect brand</option><option value="gm_financial">GM Financial</option></select></label><label><span>Table extraction</span><select value={extractor} onChange={(event) => onExtractorChange(event.target.value)}><option value="camelot">Camelot — recommended</option><option value="pdfplumber">pdfplumber — diagnostic</option></select></label><button className="primary-action" type="submit" disabled={busy}>{busy ? "Starting import…" : "Start import"}<span aria-hidden="true">→</span></button></div>{message && <Notice message={message} tone={messageTone} />}</form></div>;
}

type ReviewStageProps = { selected: ImportRecord; rows: RowsResponse; query: string; makeFilter: string; sort: { key: RowSort; direction: SortDirection }; page: number; pageSize: number; sourceOpen: boolean; message: string | null; messageTone: MessageTone; rowsLoading: boolean; rowsError: string | null; retrying: boolean; quality: QualityReport | null; qualityOpen: boolean; qualityLoading: boolean; qualityError: string | null; onQueryChange: (value: string) => void; onMakeChange: (value: string) => void; onSortChange: (key: RowSort) => void; onPageChange: (page: number) => void; onPageSizeChange: (size: number) => void; onRowsRetry: () => Promise<void>; onImportRetry: () => Promise<void>; onSourceToggle: () => void; onSourceClose: () => void; onOpenQuality: () => void; onCloseQuality: () => void; };
function ReviewStage({ selected, rows, query, makeFilter, sort, page, pageSize, sourceOpen, message, messageTone, rowsLoading, rowsError, retrying, quality, qualityOpen, qualityLoading, qualityError, onQueryChange, onMakeChange, onSortChange, onPageChange, onPageSizeChange, onRowsRetry, onImportRetry, onSourceToggle, onSourceClose, onOpenQuality, onCloseQuality }: ReviewStageProps) {
  const result = selected.result;
  const sourceUrl = `/api/imports/${selected.id}/artifacts/source`;
  const totalPages = Math.max(1, Math.ceil(rows.total / pageSize));
  const firstRow = rows.total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, rows.total);
  return <div className="review-stage"><header className="review-header"><div><h1>{selected.filename}</h1><p className="review-reason">{selected.detection.reason}</p></div><div className="review-header-actions">{selected.status === "completed" && <><span className="status-badge status-completed"><span aria-hidden="true">●</span>{STATUS_COPY.completed}</span><button type="button" className={`source-toggle ${sourceOpen ? "is-active" : ""}`} onClick={onSourceToggle} aria-pressed={sourceOpen}>Source PDF <span aria-hidden="true">{sourceOpen ? "×" : "↗"}</span></button></>}</div></header>{message && <Notice message={message} tone={messageTone} className="review-notice" />}{selected.status === "completed" && result ? <div className={`review-grid ${sourceOpen ? "is-source-open" : ""} ${qualityOpen ? "is-quality-open" : ""}`}><div className="data-workspace"><div className="result-line"><span className="result-clean"><i aria-hidden="true" />{result.rows_clean.toLocaleString()} clean rows</span><span className="result-review"><i aria-hidden="true" />{result.rows_needing_review.toLocaleString()} need review</span><span>{result.rows_extracted.toLocaleString()} extracted</span><span>Effective {result.effective_month ?? "month unavailable"}</span></div><div className="table-toolbar"><label className="search-field"><span className="sr-only">Search all standardized rows</span><input type="search" placeholder="Search all rows" value={query} onChange={(event) => onQueryChange(event.target.value)} /></label><label className="filter-field"><span className="sr-only">Filter by make</span><select value={makeFilter} onChange={(event) => onMakeChange(event.target.value)}><option value="all">All makes</option>{rows.makes.map((make) => <option key={make} value={make}>{make}</option>)}</select></label><div className="toolbar-links"><button type="button" className="toolbar-link" onClick={onOpenQuality} aria-expanded={qualityOpen}>Quality report</button><a href={`/api/imports/${selected.id}/artifacts/standardized-csv`}>Export CSV</a></div></div><div className="table-shell"><div className="table-caption"><span>{rowsLoading ? "Refreshing rows…" : `Showing ${firstRow}–${lastRow} of ${rows.total.toLocaleString()} standardized rows`}</span><span>Local review copy</span></div><table><thead><tr>{ROW_COLUMNS.map((column) => <th key={column.key} className={column.numeric ? "numeric" : undefined} aria-sort={sort.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}><button type="button" className="sort-button" onClick={() => onSortChange(column.key)}>{column.label}<span aria-hidden="true">{sort.key === column.key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</span></button></th>)}</tr></thead><tbody>{rowsLoading ? <TableSkeleton /> : rowsError ? <tr><td colSpan={6} className="table-error"><strong>Rows unavailable</strong><span>{rowsError}</span><button type="button" onClick={() => void onRowsRetry()}>Try again</button></td></tr> : rows.items.length === 0 ? <tr><td colSpan={6} className="empty-table">No rows match this search.</td></tr> : rows.items.map((row, index) => <tr key={`${row.row_id ?? "row"}-${index}`}><td>{getString(row.make)}</td><td>{getString(row.vehicle_line)}</td><td className="mono">{getString(row.model_code)}</td><td>{getString(row.trim_description)}</td><td className="numeric">{getString(row.term_months)} mo</td><td className="numeric">{getString(row.residual_percent)}%</td></tr>)}</tbody></table></div><div className="pagination" aria-label="Row pagination"><label><span>Rows per page</span><select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><span>{rows.total === 0 ? "No rows" : `${firstRow}–${lastRow} of ${rows.total.toLocaleString()}`}</span><div><button type="button" onClick={() => onPageChange(page - 1)} disabled={page === 1}>Previous</button><span>Page {page} of {totalPages}</span><button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>Next</button></div></div></div>{sourceOpen && <aside className="source-panel" aria-label="Source PDF"><div className="source-panel-header"><div><strong>Source PDF</strong><span>{selected.filename}</span></div><div><a href={sourceUrl} target="_blank" rel="noreferrer">Open</a><button type="button" onClick={onSourceClose} aria-label="Close source PDF">×</button></div></div><iframe title={`Source PDF: ${selected.filename}`} src={sourceUrl} /></aside>}{qualityOpen && <QualityReportPanel report={quality} loading={qualityLoading} error={qualityError} record={selected} onClose={onCloseQuality} onRetry={onOpenQuality} />}</div> : <RunState selected={selected} retrying={retrying} onRetry={onImportRetry} />}</div>;
}

function TableSkeleton() { return <>{Array.from({ length: 6 }, (_, index) => <tr key={index} className="table-skeleton"><td colSpan={6}><span /></td></tr>)}</>; }
function RunState({ selected, retrying, onRetry }: { selected: ImportRecord; retrying: boolean; onRetry: () => Promise<void> }) {
  const active = selected.status === "queued" || selected.status === "parsing";
  const canRetry = selected.status === "failed" || selected.status === "needs_parser";
  const events = selected.events ?? [];
  const latest = events.at(-1)?.message;
  const summary =
    selected.error ??
    (active
      ? selected.status === "queued"
        ? "Your file is queued. Parsing begins automatically."
        : "Reading the PDF and standardizing rows. This can take a moment."
      : selected.status === "needs_parser"
        ? "The file is stored, but its brand isn’t routed to a supported parser yet."
        : latest ?? "The run stopped before it finished. Retry it to pick up where it left off.");
  return (
    <section className={`run-panel run-panel-${selected.status}`} aria-busy={active}>
      <span className={`run-progress ${active ? "is-active" : ""}`} aria-hidden="true" />
      <div className="run-panel-body">
        <header className="run-lead" aria-live="polite">
          <span className={`run-beacon status-${selected.status} ${active ? "is-live" : ""}`} aria-hidden="true" />
          <div className="run-lead-copy">
            <strong key={selected.status} className="run-title">{RUN_TITLE[selected.status]}</strong>
            <p className="run-summary">{summary}</p>
          </div>
        </header>
        {events.length > 0 && (
          <ol className="run-timeline">
            {events.map((event, index) => {
              const isLast = index === events.length - 1;
              const state = active && isLast ? "is-active" : canRetry && isLast ? "is-error" : "is-done";
              return (
                <li key={`${event.at}-${index}`} className={`run-step ${state}`}>
                  <span className="run-step-message">{event.message}</span>
                  <time className="run-step-time" dateTime={event.at}>{formatTime(event.at)}</time>
                </li>
              );
            })}
          </ol>
        )}
        {canRetry && (
          <button type="button" className="secondary-action" disabled={retrying} onClick={() => void onRetry()}>
            {retrying ? "Queueing retry…" : "Retry import"}
          </button>
        )}
      </div>
    </section>
  );
}

type QualityReportPanelProps = { report: QualityReport | null; loading: boolean; error: string | null; record: ImportRecord; onClose: () => void; onRetry: () => void };
// Inline workspace panel (not a full-viewport modal): it shares the review grid
// with the table, so it stays the size of the table instead of covering the whole
// page, matching the Source PDF inspect panel.
function QualityReportPanel({ report, loading, error, record, onClose, onRetry }: QualityReportPanelProps) {
  const effectiveMonth = record.result?.effective_month;
  return (
    <aside className="quality-aside" aria-label={`Quality report for ${record.filename}`}>
      <header className="quality-head">
        <div className="quality-head-copy">
          <strong className="quality-title">Quality report</strong>
          <span className="quality-sub">{[record.detection.brand, effectiveMonth ? `Effective ${effectiveMonth}` : null].filter(Boolean).join(" · ") || "Data quality summary"}</span>
        </div>
        <button type="button" className="quality-close" onClick={onClose} aria-label="Close quality report">×</button>
      </header>
      <div className="quality-body">
        {loading ? <QualityLoading /> : error ? <QualityStateMessage message={error} onRetry={onRetry} /> : report ? <QualityContent report={report} importId={record.id} /> : null}
      </div>
    </aside>
  );
}

function QualityContent({ report, importId }: { report: QualityReport; importId: string }) {
  const { input_rows, duplicates_removed, clean_rows, quarantined_rows, coverage } = report;
  const advisoryFlags = sumValues(report.soft_flag_breakdown) + report.non_monotonic_term_rows;
  const hardErrors = sumValues(report.hard_error_breakdown);
  const tone = quarantined_rows > 0 ? "quarantine" : advisoryFlags > 0 ? "advisory" : "clean";
  const verdict = {
    clean: { title: "Clean import", detail: `All ${clean_rows.toLocaleString()} rows passed validation. No quarantines, no advisories.` },
    advisory: { title: "Kept with advisories", detail: `All ${clean_rows.toLocaleString()} rows were kept. ${advisoryFlags.toLocaleString()} advisory ${advisoryFlags === 1 ? "flag" : "flags"} raised for review.` },
    quarantine: { title: "Needs attention", detail: `${quarantined_rows.toLocaleString()} of ${input_rows.toLocaleString()} rows were quarantined and left out of the clean set.` },
  }[tone];
  const denominator = Math.max(1, input_rows);

  const quarantineIssues = Object.entries(report.hard_error_breakdown);
  const advisoryIssues: Array<[string, number]> = [
    ...Object.entries(report.soft_flag_breakdown),
    ...(report.non_monotonic_term_rows > 0 ? [["non_monotonic_term", report.non_monotonic_term_rows] as [string, number]] : []),
  ];

  const makes = Object.entries(coverage.makes).sort((a, b) => b[1] - a[1]);
  const terms = Object.entries(coverage.term_coverage).sort((a, b) => Number(a[0]) - Number(b[0]));
  const makesTotal = sumValues(coverage.makes);
  const termsTotal = sumValues(coverage.term_coverage);

  return (
    <>
      <div className={`quality-verdict tone-${tone}`}>
        <span className="quality-verdict-mark" aria-hidden="true" />
        <div className="quality-verdict-copy">
          <strong>{verdict.title}</strong>
          <p>{verdict.detail}</p>
        </div>
      </div>

      <section className="quality-section">
        <h3>Pipeline</h3>
        <p className="quality-section-note">{input_rows.toLocaleString()} rows extracted from the source PDF.</p>
        <div className="pipeline-bar" role="img" aria-label={`${clean_rows.toLocaleString()} clean, ${quarantined_rows.toLocaleString()} quarantined, ${duplicates_removed.toLocaleString()} duplicates removed`}>
          {clean_rows > 0 && <span className="pipeline-seg is-clean" style={{ width: `${(clean_rows / denominator) * 100}%` }} />}
          {quarantined_rows > 0 && <span className="pipeline-seg is-quarantine" style={{ width: `${(quarantined_rows / denominator) * 100}%` }} />}
          {duplicates_removed > 0 && <span className="pipeline-seg is-dupe" style={{ width: `${(duplicates_removed / denominator) * 100}%` }} />}
        </div>
        <ul className="pipeline-legend">
          <li><span className="dot is-clean" aria-hidden="true" /><span className="pipeline-legend-label">Clean</span><span className="pipeline-legend-value"><b>{clean_rows.toLocaleString()}</b><small>{pctLabel(clean_rows, input_rows)}</small></span></li>
          <li><span className="dot is-quarantine" aria-hidden="true" /><span className="pipeline-legend-label">Quarantined</span><span className="pipeline-legend-value"><b>{quarantined_rows.toLocaleString()}</b><small>{pctLabel(quarantined_rows, input_rows)}</small></span></li>
          {duplicates_removed > 0 && <li><span className="dot is-dupe" aria-hidden="true" /><span className="pipeline-legend-label">Duplicates removed</span><span className="pipeline-legend-value"><b>{duplicates_removed.toLocaleString()}</b><small>{pctLabel(duplicates_removed, input_rows)}</small></span></li>}
        </ul>
      </section>

      <section className="quality-section">
        <h3>Issues to review</h3>
        {quarantineIssues.length === 0 && advisoryIssues.length === 0 ? (
          <div className="quality-empty"><span className="quality-empty-mark" aria-hidden="true">✓</span><p>No validation issues. Every row passed cleanly.</p></div>
        ) : (
          <div className="issue-groups">
            {quarantineIssues.length > 0 && (
              <div className="issue-group">
                <p className="issue-group-label">Quarantined <span>{hardErrors.toLocaleString()}</span></p>
                {quarantineIssues.map(([key, count]) => <IssueRow key={key} flag={key} count={count} severity="hard" />)}
              </div>
            )}
            {advisoryIssues.length > 0 && (
              <div className="issue-group">
                <p className="issue-group-label">Advisories <span>{advisoryFlags.toLocaleString()}</span></p>
                {advisoryIssues.map(([key, count]) => <IssueRow key={key} flag={key} count={count} severity="soft" />)}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="quality-section">
        <h3>Coverage</h3>
        <div className="quality-stats">
          <div className="quality-stat"><b>{coverage.distinct_vehicle_lines.toLocaleString()}</b><span>Vehicle lines</span></div>
          <div className="quality-stat"><b>{coverage.distinct_model_codes.toLocaleString()}</b><span>Model codes</span></div>
          <div className="quality-stat"><b>{coverage.wildcard_codes.toLocaleString()}</b><span>Wildcard codes</span></div>
          <div className="quality-stat"><b>{coverage.rows_with_mrm.toLocaleString()}</b><span>Rows with MRM</span></div>
        </div>
        {makes.length > 0 && (
          <div className="cov-block">
            <p className="cov-block-label">By make</p>
            {makes.map(([make, count]) => <BarRow key={make} label={make} count={count} total={makesTotal} />)}
          </div>
        )}
        {terms.length > 0 && (
          <div className="cov-block">
            <p className="cov-block-label">By lease term</p>
            {terms.map(([term, count]) => <BarRow key={term} label={`${term} mo`} count={count} total={termsTotal} />)}
          </div>
        )}
      </section>

      <a className="quality-download" href={`/api/imports/${importId}/artifacts/quality-report`}>Download raw JSON<span aria-hidden="true">↓</span></a>
    </>
  );
}

function IssueRow({ flag, count, severity }: { flag: string; count: number; severity: "hard" | "soft" }) {
  const copy = issueCopy(flag);
  return (
    <div className="issue-row">
      <span className={`issue-dot is-${severity}`} aria-hidden="true" />
      <div className="issue-copy">
        <strong>{copy.label}</strong>
        {copy.detail && <span>{copy.detail}</span>}
      </div>
      <b className="issue-count">{count.toLocaleString()}</b>
    </div>
  );
}

function BarRow({ label, count, total }: { label: string; count: number; total: number }) {
  const share = total > 0 ? count / total : 0;
  return (
    <div className="cov-row">
      <span className="cov-label" title={label}>{label}</span>
      <span className="cov-track" aria-hidden="true"><span className="cov-fill" style={{ width: `${Math.max(3, share * 100)}%` }} /></span>
      <span className="cov-value"><b>{count.toLocaleString()}</b><small>{pctLabel(count, total)}</small></span>
    </div>
  );
}

function QualityLoading() {
  return <div className="quality-loading" aria-label="Loading quality report">{Array.from({ length: 5 }, (_, index) => <span key={index} />)}</div>;
}
function QualityStateMessage({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="quality-state"><strong>Report unavailable</strong><p>{message}</p><button type="button" className="secondary-action" onClick={onRetry}>Try again</button></div>;
}
