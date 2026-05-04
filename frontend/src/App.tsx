import { useEffect, useRef, useState } from "react";
import {
  checkHealth,
  CitationItem,
  deleteUploadedKnowledgeFile,
  listUploadedKnowledgeFiles,
  UploadFileItem,
  queryBrain,
  QueryFilters,
  QueryResponse,
  uploadKnowledgeFile,
} from "./api";
import "./App.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: CitationItem[];
  retrieval?: any;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string }) {
  const parts = source.split("/");
  const filename = parts[parts.length - 1];
  return (
    <span className="source-badge" title={source}>
      📄 {filename}
    </span>
  );
}

function CitationCard({ citation, index }: { citation: CitationItem; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const preview = citation.text.slice(0, 160);
  return (
    <div className="citation-card">
      <div className="citation-header">
        <span className="citation-index">[{index + 1}]</span>
        <SourceBadge source={citation.source} />
        {citation.page && citation.page > 0 && (
          <span className="citation-page">p.{citation.page}</span>
        )}
      </div>
      <p className="citation-text">
        {expanded ? citation.text : preview}
        {citation.text.length > 160 && (
          <button className="expand-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? " show less" : "… show more"}
          </button>
        )}
      </p>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [topK, setTopK] = useState(5);
  const [debugMode, setDebugMode] = useState(false);
  const [filterDocType, setFilterDocType] = useState<"" | "md" | "pdf">("");
  const [filterPrefix, setFilterPrefix] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState<UploadFileItem[]>([]);
  const [uploadsLoading, setUploadsLoading] = useState(false);
  const [deletingFilename, setDeletingFilename] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function refreshUploads() {
    setUploadsLoading(true);
    try {
      const res = await listUploadedKnowledgeFiles();
      setUploadedFiles(res.files);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setUploadStatus(`List uploads error: ${msg}`);
    } finally {
      setUploadsLoading(false);
    }
  }

  useEffect(() => {
    checkHealth().then(setHealthy);
    refreshUploads();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function handleSend() {
    const q = input.trim();
    if (!q || loading) return;

    const userMsg: Message = { role: "user", content: q };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    const filters: QueryFilters = {};
    if (filterPrefix) filters.source_prefix = filterPrefix;
    if (filterDocType) filters.doc_type = filterDocType;

    try {
      const res: QueryResponse = await queryBrain(
        q,
        topK,
        Object.keys(filters).length ? filters : undefined,
        debugMode
      );
      const assistantMsg: Message = {
        role: "assistant",
        content: res.answer,
        citations: res.citations,
        retrieval: res.retrieval,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ Error: ${msg}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleUploadChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || uploading) return;

    setUploading(true);
    setUploadStatus("Uploading and syncing...");

    try {
      const res = await uploadKnowledgeFile(file);
      setUploadStatus(`Uploaded: ${res.action}, chunks: ${res.chunks}`);
      setFilterPrefix("knowledge/uploads/");
      await refreshUploads();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setUploadStatus(`Upload error: ${msg}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleDeleteUpload(file: UploadFileItem) {
    if (deletingFilename || uploading) return;
    const confirmed = window.confirm(`Delete ${file.name}? This will remove synced chunks too.`);
    if (!confirmed) return;

    setDeletingFilename(file.name);
    setUploadStatus(`Deleting ${file.name} and syncing...`);

    try {
      const res = await deleteUploadedKnowledgeFile(file.name);
      setUploadStatus(`Deleted: ${res.action}`);
      await refreshUploads();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setUploadStatus(`Delete error: ${msg}`);
    } finally {
      setDeletingFilename(null);
    }
  }

  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-icon">🧠</span>
          <span className="logo-text">Synced Brain</span>
        </div>

        <div className="sidebar-status">
          <span className={`status-dot ${healthy === null ? "checking" : healthy ? "ok" : "err"}`} />
          {healthy === null ? "Connecting…" : healthy ? "Backend online" : "Backend offline"}
        </div>

        <section className="sidebar-section">
          <label className="sidebar-label">Results (top-k)</label>
          <input
            type="number"
            min={1}
            max={20}
            value={topK}
            onChange={(e) => setTopK(Number(e.target.value))}
            className="sidebar-input"
          />
        </section>

        <section className="sidebar-section">
          <label className="sidebar-label">Filter: doc type</label>
          <select
            value={filterDocType}
            onChange={(e) => setFilterDocType(e.target.value as "" | "md" | "pdf")}
            className="sidebar-input"
          >
            <option value="">All</option>
            <option value="md">Markdown</option>
            <option value="pdf">PDF</option>
          </select>
        </section>

        <section className="sidebar-section">
          <label className="sidebar-label">Filter: path prefix</label>
          <input
            type="text"
            placeholder="knowledge/ops/"
            value={filterPrefix}
            onChange={(e) => setFilterPrefix(e.target.value)}
            className="sidebar-input"
          />
        </section>

        <section className="sidebar-section">
          <label className="sidebar-toggle">
            <input
              type="checkbox"
              checked={debugMode}
              onChange={(e) => setDebugMode(e.target.checked)}
            />
            <span>Debug scores</span>
          </label>
        </section>

        <section className="sidebar-section">
          <label className="sidebar-label">Upload to knowledge</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt,.pdf"
            onChange={handleUploadChange}
            className="hidden-file-input"
          />
          <button
            className="sidebar-upload-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "Uploading..." : "Upload File"}
          </button>

          <div className="upload-files-block">
            <div className="upload-files-header">
              <span>Uploaded Files</span>
              <button
                className="upload-files-refresh"
                onClick={refreshUploads}
                disabled={uploadsLoading || uploading || !!deletingFilename}
              >
                {uploadsLoading ? "Loading..." : "Refresh"}
              </button>
            </div>

            {uploadsLoading ? (
              <p className="upload-files-empty">Loading files...</p>
            ) : uploadedFiles.length === 0 ? (
              <p className="upload-files-empty">No uploaded files yet.</p>
            ) : (
              <ul className="upload-files-list">
                {uploadedFiles.map((f) => (
                  <li key={f.name} className="upload-file-item">
                    <div className="upload-file-meta">
                      <span className="upload-file-name" title={f.name}>{f.name}</span>
                      <span className="upload-file-size">{Math.max(1, Math.round(f.size_bytes / 1024))} KB</span>
                    </div>
                    <button
                      className="upload-file-delete-btn"
                      onClick={() => handleDeleteUpload(f)}
                      disabled={uploading || !!deletingFilename}
                    >
                      {deletingFilename === f.name ? "Deleting..." : "Delete"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {uploadStatus && <p className="upload-status">{uploadStatus}</p>}
        </section>

        <div className="sidebar-footer">
          <p>Uploads are saved as markdown in <code>knowledge/uploads/</code> and synced immediately.</p>
        </div>
      </aside>

      {/* ── Chat area ── */}
      <main className="chat-area">
        <div className="messages">
          {messages.length === 0 && (
            <div className="empty-state">
              <span className="empty-icon">🧠</span>
              <h2>Your Synced Brain</h2>
              <p>Ask anything about your knowledge base. Files are synced automatically via git push.</p>
            </div>
          )}

{messages.map((msg, i) => (
  <div key={i} className={`message ${msg.role}`}>
    <div className="message-bubble">
      <span className="message-role">{msg.role === "user" ? "You" : "Brain"}</span>
      <p className="message-content">{msg.content}</p>
    </div>

    {msg.role === "assistant" && msg.citations && msg.citations.length > 0 && (
      <div className="citations-block">
        <p className="citations-label">
          Sources ({msg.citations.length})
        </p>
        <div className="citations-list">
          {msg.citations.map((c, ci) => (
            <CitationCard key={ci} citation={c} index={ci} />
          ))}
        </div>
      </div>
    )}

    {/* 🔥 ADD THIS BLOCK BELOW */}
    {msg.role === "assistant" && msg.retrieval?.raw_chunks && (
      <div style={{ marginTop: "6px" }}>
        <details>
          <summary style={{ cursor: "pointer", fontSize: "12px", opacity: 0.7 }}>
            🔍 Retrieved Chunks (Vector DB)
          </summary>

          <pre
            style={{
              fontSize: "10px",
              opacity: 0.6,
              background: "#111",
              padding: "6px",
              borderRadius: "6px",
              marginTop: "5px",
              overflowX: "auto"
            }}
          >
            {JSON.stringify(msg.retrieval.raw_chunks, null, 2)}
          </pre>
        </details>
      </div>
    )}
    {/* 🔥 END */}
  </div>
))}

          {loading && (
            <div className="message assistant">
              <div className="message-bubble">
                <span className="message-role">Brain</span>
                <p className="message-content thinking">
                  <span />
                  <span />
                  <span />
                </p>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* ── Input bar ── */}
        <div className="input-bar">
          <textarea
            className="input-field"
            rows={1}
            placeholder="Ask your brain anything… (Enter to send, Shift+Enter for newline)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          <button className="send-btn" onClick={handleSend} disabled={loading || !input.trim()}>
            {loading ? "…" : "Ask"}
          </button>
        </div>
      </main>
    </div>
  );
}
