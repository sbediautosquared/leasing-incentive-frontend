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
type RowsResponse = { items: Record<string, unknown>[]; total: number; page: number; page_size: number; makes: string[] };

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
      setMessage("Choose a PDF file to import.");
      return;
    }
    setFile(candidate);
    setMessage(null);
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => chooseFile(event.target.files?.[0]);
  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files?.[0]);
  };
  const selectImport = (item: ImportRecord) => {
    setSelected(item);
    setView("review");
    setSourceOpen(false);
    setQuery("");
    setMakeFilter("all");
    setPage(1);
  };
  const beginImport = () => {
    setView("import");
    setSourceOpen(false);
    setMessage(null);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) { setMessage("Choose a PDF before starting an import."); return; }
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("parser_key", parser);
      const uploaded = await apiFetch("/api/imports", { method: "POST", body: form });
      const uploadPayload = await uploaded.json();
      if (!uploaded.ok) throw new Error(uploadPayload.detail ?? "The upload could not be saved.");
      const run = await apiFetch(`/api/imports/${uploadPayload.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parser_key: parser, extractor }) });
      const runPayload = await run.json();
      if (!run.ok) throw new Error(runPayload.detail ?? "The import could not start.");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setSelected(runPayload);
      setView("review");
      setMessage(runPayload.status === "needs_parser" ? "The file is stored. Its brand needs a supported parser before it can run." : "Import queued. The review workspace will update as parsing finishes.");
      await refreshImports();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The import could not be started.");
    } finally {
      setBusy(false);
    }
  };
  const retryImport = async () => {
    if (!selected) return;
    setRetrying(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/imports/${selected.id}/retry`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "The import could not be retried.");
      setSelected(payload);
      setMessage("Retry queued. The review workspace will update as parsing finishes.");
      await refreshImports();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The import could not be retried.");
    } finally {
      setRetrying(false);
    }
  };
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
          {isImportView ? superadminAccess ? <ImportStage file={file} dragging={dragging} parser={parser} extractor={extractor} busy={busy} message={message} fileInput={fileInput} onSubmit={submit} onChooseFile={handleFileInput} onDrop={handleDrop} onDragChange={setDragging} onParserChange={setParser} onExtractorChange={setExtractor} /> : <ReadOnlyEmptyState /> : selected && <ReviewStage selected={selected} rows={rows} query={query} makeFilter={makeFilter} sort={sort} page={page} pageSize={pageSize} sourceOpen={sourceOpen} message={message} rowsLoading={rowsLoading} rowsError={rowsError} retrying={retrying} onQueryChange={updateQuery} onMakeChange={updateMake} onSortChange={updateSort} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} onRowsRetry={refreshRows} onImportRetry={retryImport} onSourceToggle={() => setSourceOpen((open) => !open)} onSourceClose={() => setSourceOpen(false)} />}
        </section>
      </div>
    </main>
  );
}

function ReadOnlyEmptyState() { return <div className="run-state"><span className="status-mark status-failed" aria-hidden="true" /><div><strong>Superadmin access required.</strong><p>Only accounts with superadmin access can use the Lease Ledger workspace.</p></div></div>; }

function RailLoading() { return <div className="rail-loading" aria-label="Loading imports"><span /><span /><span /></div>; }
function RailError({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) { return <div className="rail-error"><strong>Imports unavailable</strong><p>{message}</p><button type="button" onClick={() => void onRetry()}>Try again</button></div>; }

type ImportStageProps = { file: File | null; dragging: boolean; parser: string; extractor: string; busy: boolean; message: string | null; fileInput: React.RefObject<HTMLInputElement | null>; onSubmit: (event: FormEvent) => void; onChooseFile: (event: ChangeEvent<HTMLInputElement>) => void; onDrop: (event: DragEvent<HTMLButtonElement>) => void; onDragChange: (value: boolean) => void; onParserChange: (value: string) => void; onExtractorChange: (value: string) => void; };
function ImportStage({ file, dragging, parser, extractor, busy, message, fileInput, onSubmit, onChooseFile, onDrop, onDragChange, onParserChange, onExtractorChange }: ImportStageProps) {
  return <div className="import-stage"><div className="stage-heading"><div><h1>Upload a residual PDF.</h1><p>We’ll route and parse it, then keep the source and review artifacts together.</p></div></div><form className="import-form" onSubmit={onSubmit}><button type="button" className={`dropzone ${dragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`} onClick={() => fileInput.current?.click()} onDrop={onDrop} onDragOver={(event) => { event.preventDefault(); onDragChange(true); }} onDragLeave={() => onDragChange(false)}><span className="dropzone-icon" aria-hidden="true">↓</span>{file ? <><strong>{file.name}</strong><small>{formatBytes(file.size)} · ready to parse</small></> : <><strong>Drop a residual PDF here</strong><small>or choose a file from your computer</small></>}</button><input ref={fileInput} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={onChooseFile} /><div className="import-controls"><label><span>Document routing</span><select value={parser} onChange={(event) => onParserChange(event.target.value)}><option value="auto">Auto-detect brand</option><option value="gm_financial">GM Financial</option></select></label><label><span>Table extraction</span><select value={extractor} onChange={(event) => onExtractorChange(event.target.value)}><option value="camelot">Camelot — recommended</option><option value="pdfplumber">pdfplumber — diagnostic</option></select></label><button className="primary-action" type="submit" disabled={busy}>{busy ? "Starting import…" : "Start import"}<span aria-hidden="true">→</span></button></div>{message && <p className="notice" role="status">{message}</p>}</form></div>;
}

type ReviewStageProps = { selected: ImportRecord; rows: RowsResponse; query: string; makeFilter: string; sort: { key: RowSort; direction: SortDirection }; page: number; pageSize: number; sourceOpen: boolean; message: string | null; rowsLoading: boolean; rowsError: string | null; retrying: boolean; onQueryChange: (value: string) => void; onMakeChange: (value: string) => void; onSortChange: (key: RowSort) => void; onPageChange: (page: number) => void; onPageSizeChange: (size: number) => void; onRowsRetry: () => Promise<void>; onImportRetry: () => Promise<void>; onSourceToggle: () => void; onSourceClose: () => void; };
function ReviewStage({ selected, rows, query, makeFilter, sort, page, pageSize, sourceOpen, message, rowsLoading, rowsError, retrying, onQueryChange, onMakeChange, onSortChange, onPageChange, onPageSizeChange, onRowsRetry, onImportRetry, onSourceToggle, onSourceClose }: ReviewStageProps) {
  const result = selected.result;
  const sourceUrl = `/api/imports/${selected.id}/artifacts/source`;
  const totalPages = Math.max(1, Math.ceil(rows.total / pageSize));
  const firstRow = rows.total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, rows.total);
  return <div className="review-stage"><header className="review-header"><div><h1>{selected.filename}</h1><p className="review-reason">{selected.detection.reason}</p></div><div className="review-header-actions"><span className={`status-badge status-${selected.status}`}><span aria-hidden="true">●</span>{STATUS_COPY[selected.status]}</span>{selected.status === "completed" && <button type="button" className={`source-toggle ${sourceOpen ? "is-active" : ""}`} onClick={onSourceToggle} aria-pressed={sourceOpen}>Source PDF <span aria-hidden="true">{sourceOpen ? "×" : "↗"}</span></button>}</div></header>{message && <p className="notice review-notice" role="status">{message}</p>}{selected.status === "completed" && result ? <div className={`review-grid ${sourceOpen ? "is-source-open" : ""}`}><div className="data-workspace"><div className="result-line"><span className="result-clean"><i aria-hidden="true" />{result.rows_clean.toLocaleString()} clean rows</span><span className="result-review"><i aria-hidden="true" />{result.rows_needing_review.toLocaleString()} need review</span><span>{result.rows_extracted.toLocaleString()} extracted</span><span>Effective {result.effective_month ?? "month unavailable"}</span></div><div className="table-toolbar"><label className="search-field"><span className="sr-only">Search all standardized rows</span><input type="search" placeholder="Search all rows" value={query} onChange={(event) => onQueryChange(event.target.value)} /></label><label className="filter-field"><span className="sr-only">Filter by make</span><select value={makeFilter} onChange={(event) => onMakeChange(event.target.value)}><option value="all">All makes</option>{rows.makes.map((make) => <option key={make} value={make}>{make}</option>)}</select></label><div className="toolbar-links"><a href={`/api/imports/${selected.id}/artifacts/quality-report`}>Quality report</a><a href={`/api/imports/${selected.id}/artifacts/standardized-csv`}>Export CSV</a></div></div><div className="table-shell"><div className="table-caption"><span>{rowsLoading ? "Refreshing rows…" : `Showing ${firstRow}–${lastRow} of ${rows.total.toLocaleString()} standardized rows`}</span><span>Local review copy</span></div><table><thead><tr>{ROW_COLUMNS.map((column) => <th key={column.key} className={column.numeric ? "numeric" : undefined} aria-sort={sort.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}><button type="button" className="sort-button" onClick={() => onSortChange(column.key)}>{column.label}<span aria-hidden="true">{sort.key === column.key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</span></button></th>)}</tr></thead><tbody>{rowsLoading ? <TableSkeleton /> : rowsError ? <tr><td colSpan={6} className="table-error"><strong>Rows unavailable</strong><span>{rowsError}</span><button type="button" onClick={() => void onRowsRetry()}>Try again</button></td></tr> : rows.items.length === 0 ? <tr><td colSpan={6} className="empty-table">No rows match this search.</td></tr> : rows.items.map((row, index) => <tr key={`${row.row_id ?? "row"}-${index}`}><td>{getString(row.make)}</td><td>{getString(row.vehicle_line)}</td><td className="mono">{getString(row.model_code)}</td><td>{getString(row.trim_description)}</td><td className="numeric">{getString(row.term_months)} mo</td><td className="numeric">{getString(row.residual_percent)}%</td></tr>)}</tbody></table></div><div className="pagination" aria-label="Row pagination"><label><span>Rows per page</span><select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><span>{rows.total === 0 ? "No rows" : `${firstRow}–${lastRow} of ${rows.total.toLocaleString()}`}</span><div><button type="button" onClick={() => onPageChange(page - 1)} disabled={page === 1}>Previous</button><span>Page {page} of {totalPages}</span><button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>Next</button></div></div></div>{sourceOpen && <aside className="source-panel" aria-label="Source PDF"><div className="source-panel-header"><div><strong>Source PDF</strong><span>{selected.filename}</span></div><div><a href={sourceUrl} target="_blank" rel="noreferrer">Open</a><button type="button" onClick={onSourceClose} aria-label="Close source PDF">×</button></div></div><iframe title={`Source PDF: ${selected.filename}`} src={sourceUrl} /></aside>}</div> : <RunState selected={selected} retrying={retrying} onRetry={onImportRetry} />}</div>;
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
