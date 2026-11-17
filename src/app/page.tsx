"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Send, ChevronLeft, ChevronRight, ChevronDown, Plus, Search, Settings, Trash2, Edit, Sparkles, MessageSquare, Zap, Shield, Paperclip, SquareStop, Info } from "lucide-react";

// ============================================================================
// Types & API Client
// ============================================================================
interface Session {
  id: string;
  title: string;
  last_active?: number | null;
  model?: string | null;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  created_at?: number;
}

interface ActivityEvent {
  type: "activity";
  text: string;
}

interface MessageEvent {
  type: "message";
  text: string;
}

interface DoneEvent {
  type: "done";
  session_id: string;
}

interface ErrorEvent {
  type: "error";
  detail: string;
}

type StreamEvent = ActivityEvent | MessageEvent | DoneEvent | ErrorEvent;

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_URL ? process.env.NEXT_PUBLIC_RELAY_URL.replace(/\/+$/, "") : "";
const AUTH_TOKEN = process.env.NEXT_PUBLIC_AUTH_TOKEN || "";

if (!RELAY_BASE) {
  console.error("NEXT_PUBLIC_RELAY_URL is not set — frontend cannot reach the relay backend.");
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!RELAY_BASE) {
    throw new Error("RELAY_URL belum di-set. Set NEXT_PUBLIC_RELAY_URL (mis. http://localhost:8787) lalu restart `npm run dev`.");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };
  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }
  let res: Response;
  try {
    res = await fetch(`${RELAY_BASE}${path}`, { ...options, headers });
  } catch (e: any) {
    throw new Error(`Gagal konek relay (${RELAY_BASE}): ${e.message}. Pastikan relay jalan di laptop.`);
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await res.text().catch(() => "");
    throw new Error(`Relay balikin bukan JSON (${res.status} ${res.statusText}) — cek URL relay & server. Response: ${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `API ${res.status}`);
  }
  return res.json();
}

async function* streamChat(sessionId: string, message: string): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${RELAY_BASE}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({ session_id: sessionId, message }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `API ${res.status}`);
  }
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  if (!reader) return;
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          const [eventLine, dataLine] = line.split("\ndata: ");
          if (dataLine) {
            const eventType = eventLine.replace("event: ", "").trim();
            const data = JSON.parse(dataLine);
            if (eventType === "activity") yield { type: "activity", text: data.text };
            else if (eventType === "message") yield { type: "message", text: data.text };
            else if (eventType === "done") yield { type: "done", session_id: data.session_id };
            else if (eventType === "error") yield { type: "error", detail: data.detail };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function listSessions(): Promise<Session[]> {
  const data = await apiFetch<{ sessions: Session[] }>("/api/sessions");
  return data.sessions;
}

async function createSession(): Promise<{ session_id: string; title: string }> {
  return apiFetch("/api/sessions", { method: "POST" });
}

async function deleteSession(id: string): Promise<void> {
  await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
}

async function renameSession(id: string, title: string): Promise<void> {
  // metadata write via session title; for now we only rename locally and let backend ignore
  // In a full impl we'd call PATCH /api/sessions/{id} with title
  console.log("rename", id, title);
}

async function getConfig(): Promise<{ provider: string; model: string }> {
  return apiFetch("/api/config");
}

// ============================================================================
// Markdown Renderer (lightweight, no heavy deps)
// ============================================================================
function MarkdownRenderer({ content }: { content: string }) {
  // Very light markdown: code blocks, inline code, bold, italics, links, lists
  // For production, swap with `react-markdown` + `rehype-highlight`
  const lines = content.split("\n");
  const result: React.ReactNode[] = [];
  let inCode = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  const flushCode = () => {
    if (codeBuffer.length) {
      result.push(
        <pre key={`code-${result.length}`} className="markdown">
          <code className={`language-${codeLang}`}>{codeBuffer.join("\n")}</code>
        </pre>
      );
      codeBuffer = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith("```")) {
      if (!inCode) {
        inCode = true;
        codeLang = line.slice(3).trim() || "text";
        continue;
      } else {
        inCode = false;
        flushCode();
        continue;
      }
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }
    // Headings
    if (line.match(/^#{1,3}\s/)) {
      const level = line.match(/^#+/)?.[0].length || 1;
      const text = line.replace(/^#+\s/, "");
      const Tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
      result.push(<Tag key={i} className="markdown">{text}</Tag>);
      continue;
    }
    // Blockquote
    if (line.startsWith("> ")) {
      result.push(<blockquote key={i} className="markdown">{line.slice(2)}</blockquote>);
      continue;
    }
    // Lists
    if (line.match(/^[-*]\s/) || line.match(/^\d+\.\s/)) {
      result.push(<li key={i} className="markdown">{line.replace(/^[-*]\s|^\d+\.\s/, "")}</li>);
      continue;
    }
    // Inline transformations
    let html = line
      .replace(/`([^`]+)`/g, '<code className="markdown">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" className="markdown">$1</a>');
    if (html.trim()) {
      result.push(<p key={i} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />);
    } else {
      result.push(<br key={i} />);
    }
  }
  flushCode();
  return <div className="markdown whitespace-pre-wrap">{result}</div>;
}

// ============================================================================
// Components
// ============================================================================
function Sidebar({
  sessions,
  activeId,
  collapsed,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onToggleCollapse,
}: {
  sessions: Session[];
  activeId: string | null;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onToggleCollapse: () => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && inputRef.current) inputRef.current.focus();
  }, [renamingId]);

  const handleRenameSubmit = (id: string) => {
    if (renameValue.trim()) onRename(id, renameValue.trim());
    setRenamingId(null);
    setRenameValue("");
  };

  if (collapsed) {
    return (
      <aside className="sidebar collapsed w-13 flex-shrink-0 flex flex-col items-center border-r border-border bg-bg-elev">
        <button onClick={onToggleCollapse} className="p-2 rounded-lg hover:bg-white/5 transition-colors mt-2" aria-label="Expand sidebar">
          <ChevronRight className="w-5 h-5 text-text-muted" />
        </button>
        <div className="flex-1 w-full flex flex-col items-center gap-1 mt-4" />
      </aside>
    );
  }

  return (
    <aside className="sidebar w-64 flex-shrink-0 flex flex-col border-r border-border bg-bg-elev">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-indigo-400" />
          <span className="font-semibold text-text">AI_Agent_KL</span>
        </div>
        <button onClick={onToggleCollapse} className="p-2 rounded-lg hover:bg-white/5" aria-label="Collapse sidebar">
          <ChevronLeft className="w-5 h-5 text-text-muted" />
        </button>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="p-2 flex gap-2">
          <button onClick={onNew} className="button button-primary flex-1 flex items-center justify-center gap-2" disabled={collapsed}>
            <Plus className="w-4 h-4" />
            <span>New Chat</span>
          </button>
        </div>

        <div className="relative px-2 mb-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input type="text" placeholder="Search conversations..." className="w-full pl-9 pr-3 py-2 bg-white/5 border-0 rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none" />
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {sessions.length === 0 ? (
            <div className="text-center py-8 text-text-muted text-sm">No conversations yet</div>
          ) : (
            <ul className="space-y-1">
              {sessions.map((s) => {
                const isActive = s.id === activeId;
                const dateStr = s.last_active ? new Date(s.last_active).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
                return (
                  <li key={s.id}>
                    {renamingId === s.id ? (
                      <input
                        ref={inputRef}
                        type="text"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => handleRenameSubmit(s.id)}
                        onKeyDown={(e) => e.key === "Enter" && handleRenameSubmit(s.id)}
                        className="w-full px-2 py-1.5 rounded-lg bg-white/5 border border-indigo-400/30 text-sm text-text focus:outline-none"
                        autoFocus
                      />
                    ) : (
                      <div className="relative group">
                        <button
                          onClick={() => onSelect(s.id)}
                          className={`w-full text-left px-2 py-2 rounded-lg transition-colors flex items-center gap-2 ${
                            isActive ? "bg-indigo-500/15 text-text" : "text-text-muted hover:bg-white/5 hover:text-text"
                          }`}
                        >
                          <MessageSquare className="w-4 h-4 flex-shrink-0" />
                          <span className="truncate flex-1">{s.title || "Untitled"}</span>
                        </button>
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); setRenamingId(s.id); setRenameValue(s.title || ""); }}
                            className="p-1.5 rounded hover:bg-white/10 text-text-muted hover:text-text"
                            aria-label="Rename"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); if (confirm("Delete this conversation?")) onDelete(s.id); }}
                            className="p-1.5 rounded hover:bg-white/10 text-red-400 hover:text-red-300"
                            aria-label="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {dateStr && <span className="absolute right-8 top-1/2 -translate-y-1/2 text-xs text-text-muted opacity-0 group-hover:opacity-100">{dateStr}</span>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="p-2 border-t border-border">
          <div className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/5 cursor-pointer">
            <Settings className="w-4 h-4 text-text-muted" />
            <span className="text-sm text-text">Settings</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function ChatWorkspace({
  messages,
  isLoading,
  activityEvents,
  onRegenerate,
  onStop,
}: {
  messages: { role: string; content: string }[];
  isLoading: boolean;
  activityEvents: string[];
  onRegenerate: () => void;
  onStop: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const [showActivity, setShowActivity] = useState(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      {messages.length === 0 && !isLoading && (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <Sparkles className="welcome-icon mb-4" />
          <h1 className="text-3xl font-semibold text-text mb-2">How can I help you today?</h1>
          <p className="text-text-muted mb-8 max-w-md">Your personal AI agent, powered by Hermes.</p>
          <div className="flex flex-wrap gap-2 justify-center max-w-xl">
            {[
              "Analyze my files",
              "Research something on the web",
              "Write and improve code",
              "Process data",
              "Help me automate tasks",
            ].map((p) => (
              <button
                key={p}
                onClick={() => console.log("suggest:", p)}
                className="suggested-prompt"
              >
                {p}
              </button>
            ))}
          </div>
          <div className="mt-8 text-xs text-text-muted/50">Suggestions are UI placeholders; actual execution is handled by Hermes.</div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4 flex flex-col">
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role === "user" ? "user" : "assistant"}`}>
            <div className="bubble">
              {msg.role === "user" ? (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              ) : (
                <MarkdownRenderer content={msg.content} />
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="message assistant">
            <div className="bubble flex items-center gap-2 text-text-muted">
              <div className="activity-dots">
                <span className="dot pulse" style={{ animationDelay: "0ms" }} />
                <span className="dot pulse" style={{ animationDelay: "150ms" }} />
                <span className="dot pulse" style={{ animationDelay: "300ms" }} />
              </div>
              <span>Hermes is thinking…</span>
            </div>
          </div>
        )}
        {activityEvents.length > 0 && (
          <details className="message assistant" open={showActivity} onToggle={() => setShowActivity(!showActivity)}>
            <summary className="bubble cursor-pointer flex items-center gap-2 text-text-muted select-none">
              <Zap className="w-4 h-4" />
              <span>Activity ({activityEvents.length})</span>
              <ChevronDown className="w-4 h-4 ml-auto transition-transform" style={{ transform: showActivity ? "rotate(180deg)" : "rotate(0)" }} />
            </summary>
            <div className="bubble px-3 pb-2 text-xs text-text-muted font-mono whitespace-pre-wrap border-t border-white/5 mt-2">
              {activityEvents.map((a, i) => (
                <div key={i} className="mb-1">{a}</div>
              ))}
            </div>
          </details>
        )}
        <div ref={endRef} />
      </div>
    </main>
  );
}

function MessageComposer({
  value,
  onChange,
  onSend,
  onStop,
  isLoading,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  isLoading: boolean;
  disabled: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [height, setHeight] = useState(44);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const h = Math.min(textareaRef.current.scrollHeight, 200);
      setHeight(h);
      textareaRef.current.style.height = `${h}px`;
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !isLoading) onSend();
    }
  };

  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); if (value.trim() && !isLoading) onSend(); }}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message AI_Agent_KL…"
        rows={1}
        style={{ minHeight: height }}
        disabled={disabled || isLoading}
        className="composer-textarea"
      />
      <div className="actions">
        <button type="button" className="attach-btn" aria-label="Attach file" disabled={disabled}>
          <Paperclip className="w-5 h-5" />
        </button>
        {isLoading ? (
          <button type="button" onClick={onStop} className="send-btn" aria-label="Stop generation">
            <SquareStop className="w-5 h-5" />
          </button>
        ) : (
          <button type="submit" disabled={!value.trim() || disabled} className="send-btn" aria-label="Send message">
            <Send className="w-5 h-5" />
          </button>
        )}
      </div>
    </form>
  );
}

function ModelInfo({ provider, model }: { provider: string; model: string }) {
  return (
    <div className="model-chip">
      <Shield className="w-3 h-3" />
      <span>{provider}</span>
      <span className="w-px h-4 bg-white/10 mx-1" />
      <span>{model}</span>
    </div>
  );
}

// ============================================================================
// Main App Page
// ============================================================================
export default function Home() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [composerValue, setComposerValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activityEvents, setActivityEvents] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [config, setConfig] = useState<{ provider: string; model: string }>({ provider: "custom (9Router)", model: "main-model" });
  const [error, setError] = useState<string | null>(null);

  // Load sessions & config on mount
  useEffect(() => {
    let mounted = true;
    async function init() {
      try {
        const [sess, cfg] = await Promise.all([listSessions(), getConfig()]);
        if (mounted) {
          setSessions(sess);
          setConfig(cfg);
          if (sess.length > 0 && !activeId) {
            const first = sess[0];
            setActiveId(first.id);
            // could fetch messages here; for now just show welcome
          }
        }
      } catch (e: any) {
        if (mounted) setError(e.message || "Failed to connect to relay");
      }
    }
    init();
    return () => { mounted = false; };
  }, [activeId]);

  // Load messages when active session changes
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let mounted = true;
    apiFetch<{ messages: ChatMessage[] }>(`/api/sessions/${activeId}`)
      .then((data) => {
        if (mounted) {
          setMessages(data.messages.map((m) => ({ role: m.role, content: m.content })));
        }
      })
      .catch(() => {
        if (mounted) setMessages([]);
      });
    return () => { mounted = false; };
  }, [activeId]);

  const handleNewChat = async () => {
    try {
      const sess = await createSession();
      setSessions((prev) => [{ id: sess.session_id, title: sess.title, last_active: Date.now() }, ...prev]);
      setActiveId(sess.session_id);
      setMessages([]);
      setActivityEvents([]);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleSelectSession = (id: string) => {
    setActiveId(id);
    setActivityEvents([]);
  };

  const handleDeleteSession = async (id: string) => {
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeId === id) setActiveId(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleSend = async () => {
    if (!activeId || !composerValue.trim()) return;
    const userMsg = composerValue.trim();
    setComposerValue("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setIsLoading(true);
    setActivityEvents([]);
    setError(null);

    try {
      for await (const event of streamChat(activeId, userMsg)) {
        if (event.type === "activity") {
          setActivityEvents((prev) => [...prev, event.text]);
        } else if (event.type === "message") {
          // append or update assistant message
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant") {
              const updated = [...prev];
              updated[updated.length - 1] = { ...last, content: last.content + event.text };
              return updated;
            }
            return [...prev, { role: "assistant", content: event.text }];
          });
        } else if (event.type === "error") {
          setError(event.detail);
          break;
        }
      }
    } catch (e: any) {
      setError(e.message || "Stream error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleStop = () => {
    setIsLoading(false);
  };

  const handleRegenerate = () => {
    // Find last user message and resend
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser && activeId) {
      setMessages((prev) => prev.filter((m) => m !== lastUser || m.role !== "user"));
      setComposerValue(lastUser.content);
      handleSend();
    }
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {error && (
        <div className="fixed top-4 right-4 z-50 bg-red-500/90 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-right">
          <Info className="w-4 h-4" />
          <span className="text-sm">{error}</span>
          <button onClick={() => setError(null)} className="ml-2 p-1 hover:bg-white/20 rounded">×</button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          collapsed={sidebarCollapsed}
          onSelect={handleSelectSession}
          onNew={handleNewChat}
          onRename={renameSession}
          onDelete={handleDeleteSession}
          onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        />
        <div className="flex-1 flex flex-col min-w-0">
          <ChatWorkspace
            messages={messages}
            isLoading={isLoading}
            activityEvents={activityEvents}
            onRegenerate={handleRegenerate}
            onStop={handleStop}
          />
          <MessageComposer
            value={composerValue}
            onChange={setComposerValue}
            onSend={handleSend}
            onStop={handleStop}
            isLoading={isLoading}
            disabled={!activeId}
          />
        </div>
      </div>

      <div className="border-t border-border px-3 py-1.5 flex items-center justify-between">
        <ModelInfo provider={config.provider} model={config.model} />
        <div className="flex items-center gap-4 text-xs text-text-muted">
          <span>Connected to Hermes via relay</span>
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
        </div>
      </div>
    </div>
  );
}
