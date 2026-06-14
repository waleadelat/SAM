import React, { useState, useRef, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetSamSession,
  getGetSamSessionQueryKey,
  useListSamMessages,
  getListSamMessagesQueryKey,
  useDeleteSamSession,
  useCreateSamSession,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Activity, Send, Upload, Trash2, ChevronLeft,
  CheckCircle2, Terminal, BarChart2, ChevronDown, ChevronUp,
  Database, Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import ReactMarkdown from "react-markdown";

// ── Types ──────────────────────────────────────────────────────────────────

interface ToolStatus {
  id: number;
  status: string;
  done: boolean;
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function Session() {
  const { sessionId } = useParams();
  const [_, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  if (!sessionId) return null;

  const { data: session, isLoading: isSessionLoading, isError: isSessionError } = useGetSamSession(sessionId, {
    query: { enabled: !!sessionId, queryKey: getGetSamSessionQueryKey(sessionId), retry: false },
  });

  const { data: messages } = useListSamMessages(sessionId, {
    query: { enabled: !!sessionId && !isSessionError, queryKey: getListSamMessagesQueryKey(sessionId), retry: false },
  });

  const deleteSession = useDeleteSamSession();
  const createSession = useCreateSamSession();

  useEffect(() => {
    if (!isSessionError) return;
    createSession.mutate(undefined, {
      onSuccess: (data) => setLocation(`/session/${data.sessionId}`),
    });
  }, [isSessionError]);

  const [input, setInput] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");
  const [toolStatuses, setToolStatuses] = useState<ToolStatus[]>([]);
  const [sessionCharts, setSessionCharts] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const statusIdRef = useRef(0);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamedContent, toolStatuses]);

  const uploadFile = async (file: File) => {
    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/sam/sessions/${sessionId}/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("Upload failed");
      await queryClient.invalidateQueries({ queryKey: getGetSamSessionQueryKey(sessionId) });
      toast({ title: "Upload complete", description: `Processed ${file.name}` });
    } catch {
      toast({ title: "Upload error", description: "Failed to upload file", variant: "destructive" });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const ext = "." + file.name.split(".").pop()?.toLowerCase();
    if (![".csv", ".xlsx", ".xls"].includes(ext)) {
      toast({ title: "Unsupported file", description: "Please upload a .csv, .xlsx, or .xls file", variant: "destructive" });
      return;
    }
    await uploadFile(file);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;

    const userMessage = input;
    setInput("");
    setIsStreaming(true);
    setStreamedContent("");
    setToolStatuses([]);

    const prevMessages = queryClient.getQueryData(getListSamMessagesQueryKey(sessionId)) as any[];
    const optimisticMsg = {
      id: Date.now().toString(), role: "user", content: userMessage, createdAt: new Date().toISOString(),
    };
    queryClient.setQueryData(getListSamMessagesQueryKey(sessionId), [...(prevMessages || []), optimisticMsg]);

    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/sam/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: userMessage }),
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: any;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.type === "content") {
            setStreamedContent((prev) => prev + event.delta);

          } else if (event.type === "tool_status") {
            const id = ++statusIdRef.current;
            setToolStatuses((prev) => {
              return [...prev.map((s) => ({ ...s, done: true })), { id, status: event.status, done: false }];
            });

          } else if (event.type === "chart") {
            setSessionCharts((prev) => [...prev, event.data]);

          } else if (event.type === "config") {
            // Session config resolved

          } else if (event.type === "analysis") {
            queryClient.setQueryData(getGetSamSessionQueryKey(sessionId), (old: any) =>
              old ? { ...old, latestAnalysis: event.data } : old
            );
            if (event.data?.allCharts?.length) {
              setSessionCharts(event.data.allCharts);
            }

          } else if (event.type === "done") {
            setToolStatuses((prev) => prev.map((s) => ({ ...s, done: true })));
            await queryClient.invalidateQueries({ queryKey: getListSamMessagesQueryKey(sessionId) });
            await queryClient.invalidateQueries({ queryKey: getGetSamSessionQueryKey(sessionId) });

          } else if (event.type === "error") {
            toast({ title: "Error", description: event.message, variant: "destructive" });
          }
        }
      }
    } catch {
      toast({ title: "Error", description: "Failed to send message", variant: "destructive" });
    } finally {
      setIsStreaming(false);
      setStreamedContent("");
      setToolStatuses([]);
    }
  };

  const handleDelete = () => {
    deleteSession.mutate({ sessionId }, { onSuccess: () => setLocation("/") });
  };

  if (isSessionLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const hasData = session?.upload != null;
  const hasCharts = sessionCharts.length > 0;
  const analysisConfig = (session?.latestAnalysis as any)?.analysisConfig;
  const isDbSource = hasData && (session?.upload as any)?.fileName?.includes("(SQL)");

  return (
    <div className="flex h-screen flex-col bg-background text-foreground font-sans overflow-hidden">
      {/* Header */}
      <header className="h-14 border-b bg-card flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/")} className="h-8 w-8">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            <span className="font-bold">Session {sessionId.slice(0, 8)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {session?.upload && (
            <div className="text-xs bg-muted px-2 py-1 rounded border flex items-center gap-1">
              {isDbSource
                ? <Database className="h-3 w-3 text-blue-500" />
                : <CheckCircle2 className="h-3 w-3 text-green-500" />}
              {session.upload.fileName} ({session.upload.rowCount.toLocaleString()} rows)
            </div>
          )}
          {analysisConfig && (
            <div className="text-xs bg-primary/10 text-primary px-2 py-1 rounded border border-primary/20 flex items-center gap-1">
              <BarChart2 className="h-3 w-3" />
              {analysisConfig.assetType} · {analysisConfig.conditionColumn}
            </div>
          )}
          <input
            type="file"
            className="hidden"
            ref={fileInputRef}
            onChange={handleUpload}
            accept=".csv,.xlsx,.xls"
          />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
            {isUploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
            Upload Data
          </Button>
          <Button variant="ghost" size="icon" onClick={handleDelete} className="text-destructive hover:bg-destructive/10">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden">

        {/* Chat Sidebar */}
        <div className="w-[420px] border-r flex flex-col bg-card/30 shrink-0">
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4 pb-4">
              {messages?.map((msg: any) => (
                <MessageBubble key={msg.id} role={msg.role} content={msg.content} />
              ))}
              {isStreaming && (
                <>
                  {toolStatuses.length > 0 && (
                    <div className="flex flex-col items-start gap-1">
                      {toolStatuses.map((ts) => (
                        <ToolStatusBadge key={ts.id} status={ts.status} done={ts.done} />
                      ))}
                    </div>
                  )}
                  {streamedContent && (
                    <MessageBubble role="assistant" content={streamedContent} streaming />
                  )}
                  {!streamedContent && toolStatuses.length === 0 && (
                    <div className="flex items-center gap-2 text-muted-foreground text-sm">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>SAM is thinking…</span>
                    </div>
                  )}
                </>
              )}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>
          <div className="p-4 border-t bg-card">
            <form onSubmit={handleSendMessage} className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={hasData ? "Ask SAM to analyze…" : "Ask SAM anything…"}
                disabled={isStreaming}
                className="flex-1"
              />
              <Button type="submit" size="icon" disabled={isStreaming || !input.trim()}>
                {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </form>
          </div>
        </div>

        {/* Dashboard / Canvas Area */}
        <div className="flex-1 bg-muted/20 overflow-y-auto">
          {hasCharts ? (
            <ChartDashboard charts={sessionCharts} analysisConfig={analysisConfig} />
          ) : hasData ? (
            <DataReadyPlaceholder fileName={session!.upload!.fileName} rowCount={session!.upload!.rowCount} isDb={isDbSource} />
          ) : (
            <DataSourcePanel
              sessionId={sessionId}
              isDragOver={isDragOver}
              isUploading={isUploading}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onFileClick={() => !isUploading && fileInputRef.current?.click()}
              onDataLoaded={() => queryClient.invalidateQueries({ queryKey: getGetSamSessionQueryKey(sessionId) })}
            />
          )}
        </div>
      </main>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function MessageBubble({ role, content, streaming }: { role: string; content: string; streaming?: boolean }) {
  return (
    <div className={`flex flex-col ${role === "user" ? "items-end" : "items-start"}`}>
      <div className={`max-w-[92%] p-3 rounded-lg text-sm ${role === "user" ? "bg-primary text-primary-foreground" : "bg-muted border"}`}>
        {role === "assistant" ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown>{content}</ReactMarkdown>
            {streaming && <span className="inline-block w-1.5 h-3.5 bg-foreground/60 animate-pulse ml-0.5 align-middle rounded-sm" />}
          </div>
        ) : (
          content
        )}
      </div>
    </div>
  );
}

function ToolStatusBadge({ status, done }: { status: string; done: boolean }) {
  return (
    <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border transition-all duration-300 ${
      done
        ? "bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400"
        : "bg-primary/10 border-primary/20 text-primary animate-pulse"
    }`}>
      {done ? (
        <CheckCircle2 className="h-3 w-3 shrink-0" />
      ) : (
        <Terminal className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate max-w-[300px]">{status}</span>
    </div>
  );
}

function ChartDashboard({ charts, analysisConfig }: { charts: string[]; analysisConfig: any }) {
  const [expanded, setExpanded] = useState<number | null>(charts.length > 0 ? 0 : null);

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <BarChart2 className="h-5 w-5 text-primary" />
          Analysis Results
        </h2>
        {analysisConfig && (
          <div className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full border">
            {analysisConfig.assetType} · {analysisConfig.scale} · column: {analysisConfig.conditionColumn}
          </div>
        )}
      </div>

      {charts.map((chart, i) => (
        <ChartCard key={i} index={i} chart={chart} total={charts.length}
          expanded={expanded === i} onToggle={() => setExpanded(expanded === i ? null : i)}
        />
      ))}
    </div>
  );
}

function ChartCard({
  chart, index, total, expanded, onToggle,
}: {
  chart: string; index: number; total: number; expanded: boolean; onToggle: () => void;
}) {
  return (
    <Card className="overflow-hidden">
      <button
        className="w-full text-left"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <CardHeader className="py-3 px-4 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">
            Chart {index + 1}{total > 1 ? ` of ${total}` : ""}
          </CardTitle>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </CardHeader>
      </button>
      {expanded && (
        <CardContent className="p-0">
          <img
            src={`data:image/png;base64,${chart}`}
            alt={`Analysis chart ${index + 1}`}
            className="w-full h-auto block"
            style={{ maxHeight: "600px", objectFit: "contain" }}
          />
        </CardContent>
      )}
    </Card>
  );
}

function DataReadyPlaceholder({ fileName, rowCount, isDb }: { fileName: string; rowCount: number; isDb?: boolean }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 text-center p-8">
      <div className={`rounded-full p-6 ${isDb ? "bg-blue-500/10" : "bg-green-500/10"}`}>
        {isDb
          ? <Database className="h-12 w-12 text-blue-500" />
          : <CheckCircle2 className="h-12 w-12 text-green-500" />}
      </div>
      <div>
        <p className="text-xl font-semibold">{fileName} loaded</p>
        <p className="text-sm text-muted-foreground mt-1">{rowCount.toLocaleString()} rows ready for analysis</p>
      </div>
      <p className="text-sm text-muted-foreground max-w-sm">
        Ask SAM to analyze the data — charts and results will appear here as SAM runs Python code.
      </p>
      <div className="flex flex-wrap justify-center gap-2 mt-2">
        {[
          "Show condition distribution",
          "Run a Markov deterioration model",
          "Which assets need urgent attention?",
          "Plot a 20-year forecast",
        ].map((prompt) => (
          <span key={prompt} className="text-xs px-3 py-1.5 bg-muted border rounded-full text-muted-foreground">
            {prompt}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── DataSourcePanel — tabbed upload / DB connect ──────────────────────────

type Tab = "file" | "database";

function DataSourcePanel({
  sessionId,
  isDragOver,
  isUploading,
  onDragOver,
  onDragLeave,
  onDrop,
  onFileClick,
  onDataLoaded,
}: {
  sessionId: string;
  isDragOver: boolean;
  isUploading: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onFileClick: () => void;
  onDataLoaded: () => void;
}) {
  const [tab, setTab] = useState<Tab>("file");

  return (
    <div className="h-full flex flex-col items-center justify-center p-8">
      {/* Tab switcher */}
      <div className="flex rounded-xl border bg-muted/40 p-1 gap-1 mb-6">
        <button
          onClick={() => setTab("file")}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            tab === "file"
              ? "bg-background shadow text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Upload className="h-4 w-4" />
          Upload File
        </button>
        <button
          onClick={() => setTab("database")}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            tab === "database"
              ? "bg-background shadow text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Database className="h-4 w-4" />
          Connect to Database
        </button>
      </div>

      {tab === "file" ? (
        <UploadDropZone
          isDragOver={isDragOver}
          isUploading={isUploading}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={onFileClick}
        />
      ) : (
        <DbConnectPanel sessionId={sessionId} onDataLoaded={onDataLoaded} />
      )}
    </div>
  );
}

function UploadDropZone({
  isDragOver, isUploading, onDragOver, onDragLeave, onDrop, onClick,
}: {
  isDragOver: boolean;
  isUploading: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onClick: () => void;
}) {
  return (
    <div className="w-full max-w-xl flex flex-col items-center">
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onClick}
        className={`
          w-full border-2 border-dashed rounded-2xl p-16 flex flex-col items-center gap-5 cursor-pointer
          transition-all duration-150 select-none
          ${isDragOver
            ? "border-primary bg-primary/10 scale-[1.01]"
            : "border-muted-foreground/30 bg-card hover:border-primary/50 hover:bg-primary/5"
          }
          ${isUploading ? "pointer-events-none opacity-60" : ""}
        `}
      >
        {isUploading ? (
          <>
            <Loader2 className="h-14 w-14 text-primary animate-spin" />
            <p className="text-lg font-semibold">Processing your data…</p>
            <p className="text-sm text-muted-foreground">SAM is parsing your file</p>
          </>
        ) : (
          <>
            <div className={`rounded-full p-5 transition-colors ${isDragOver ? "bg-primary/20" : "bg-muted"}`}>
              <Upload className={`h-10 w-10 transition-colors ${isDragOver ? "text-primary" : "text-muted-foreground"}`} />
            </div>
            <div className="text-center space-y-1">
              <p className="text-xl font-semibold">
                {isDragOver ? "Drop to upload" : "Upload your asset data"}
              </p>
              <p className="text-sm text-muted-foreground">
                Drag & drop or click — CSV, XLSX, or XLS
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2 text-xs text-muted-foreground pt-2">
              {["Bridge inventory", "Pavement PCI", "Water mains", "Machinery logs", "Any condition data"].map((label) => (
                <span key={label} className="px-2 py-1 rounded-full bg-muted border">{label}</span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground/60 mt-2">
              SAM auto-detects asset type, condition column, and applicable rating standard
            </p>
          </>
        )}
      </div>
      <p className="mt-6 text-xs text-muted-foreground/50">
        Or just start chatting — SAM can guide you without data first
      </p>
    </div>
  );
}

// ── DB Connect Panel ──────────────────────────────────────────────────────

function DbConnectPanel({
  sessionId,
  onDataLoaded,
}: {
  sessionId: string;
  onDataLoaded: () => void;
}) {
  const { toast } = useToast();
  const [connectionString, setConnectionString] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [tables, setTables] = useState<string[]>([]);
  const [server, setServer] = useState("");
  const [database, setDatabase] = useState("");
  const [connError, setConnError] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState("");
  const [tableSearch, setTableSearch] = useState("");

  const filteredTables = tables.filter((t) =>
    t.toLowerCase().includes(tableSearch.toLowerCase())
  );

  const handleConnect = async () => {
    if (!connectionString.trim()) return;
    setIsConnecting(true);
    setConnError(null);
    setTables([]);
    setSelectedTable("");
    setTableSearch("");
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/sam/sessions/${sessionId}/db-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionString }),
      });
      const data = await res.json();
      if (!res.ok) {
        setConnError(data.error ?? "Connection failed");
        return;
      }
      setTables(data.tables ?? []);
      setServer(data.server ?? "");
      setDatabase(data.database ?? "");
    } catch {
      setConnError("Network error — could not reach the API.");
    } finally {
      setIsConnecting(false);
    }
  };

  const handleLoadTable = async () => {
    if (!selectedTable) return;
    setIsLoading(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/sam/sessions/${sessionId}/db-load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionString, table: selectedTable }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Load failed", description: data.error ?? "Could not load table", variant: "destructive" });
        return;
      }
      toast({ title: "Table loaded", description: `${data.rowCount.toLocaleString()} rows from ${selectedTable}` });
      onDataLoaded();
    } catch {
      toast({ title: "Load error", description: "Network error while loading table", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const connected = tables.length > 0;

  return (
    <div className="w-full max-w-xl flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            SQL Server / Azure SQL
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Connection String (ADO.NET format)</label>
            <Textarea
              value={connectionString}
              onChange={(e) => setConnectionString(e.target.value)}
              placeholder={`Server=tcp:myserver.database.windows.net,1433;Initial Catalog=mydb;User ID=user;Password=pass;Encrypt=True;`}
              rows={3}
              className="font-mono text-xs resize-none"
              disabled={isConnecting}
            />
            <p className="text-xs text-muted-foreground/70">
              SQL auth and Active Directory Password auth are supported.
            </p>
          </div>

          {connError && (
            <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              <span className="shrink-0 mt-0.5">⚠</span>
              <span>{connError}</span>
            </div>
          )}

          <Button
            onClick={handleConnect}
            disabled={isConnecting || !connectionString.trim()}
            className="w-full"
          >
            {isConnecting ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-2" />Connecting…</>
            ) : (
              <><Database className="h-4 w-4 mr-2" />Connect</>
            )}
          </Button>
        </CardContent>
      </Card>

      {connected && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <span className="text-sm font-medium">
                {database ? `${server} / ${database}` : server}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">{tables.length} table{tables.length !== 1 ? "s" : ""} / view{tables.length !== 1 ? "s" : ""} found</p>

            {tables.length > 6 && (
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                  placeholder="Search tables…"
                  className="pl-8 h-8 text-sm"
                />
              </div>
            )}

            <ScrollArea className="h-48 rounded-md border bg-muted/30">
              <div className="p-1 space-y-0.5">
                {filteredTables.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">No tables match your search.</p>
                )}
                {filteredTables.map((t) => (
                  <button
                    key={t}
                    onClick={() => setSelectedTable(t)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                      selectedTable === t
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted text-foreground"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </ScrollArea>

            <Button
              onClick={handleLoadTable}
              disabled={!selectedTable || isLoading}
              className="w-full"
            >
              {isLoading ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Loading {selectedTable}…</>
              ) : (
                <>Load {selectedTable || "selected table"}</>
              )}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
