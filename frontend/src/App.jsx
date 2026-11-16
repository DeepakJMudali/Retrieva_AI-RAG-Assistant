import { useEffect, useRef, useState } from "react";
import {
  Bot, Plus, Send, Trash2, FileText, Sparkles, Menu, X,
  Copy, Check, ChevronDown, UploadCloud, LoaderCircle
} from "lucide-react";

const API = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const makeId = () => crypto.randomUUID();

export default function App() {
  const [sessionId, setSessionId] = useState(() => {
    let id = sessionStorage.getItem("nova_session_id");
    if (!id) {
      id = makeId();
      sessionStorage.setItem("nova_session_id", id);
    }
    return id;
  });

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("checking");
  const [sidebar, setSidebar] = useState(true);
  const [mobile, setMobile] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState({});
  const [copied, setCopied] = useState(-1);
  const [documents, setDocuments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState("");

  const bottom = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);

  async function refreshDocuments() {
    try {
      const response = await fetch(`${API}/api/documents`);
      if (!response.ok) throw new Error("Could not load document list");
      const data = await response.json();
      setDocuments(data.documents || []);
    } catch (error) {
      console.error("Document list failed:", error);
    }
  }

  useEffect(() => {
    async function initialize() {
      try {
        const response = await fetch(`${API}/api/health`);
        if (!response.ok) throw new Error("Backend is not responding");
        await response.json();
        setStatus("online");
        await refreshDocuments();
      } catch (error) {
        console.error("Backend health check failed:", error);
        setStatus("offline");
      }
    }
    initialize();
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function handleUpload(event) {
    const selectedFiles = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selectedFiles.length) return;

    const invalid = selectedFiles.find(file => !file.name.toLowerCase().endsWith(".pdf"));
    if (invalid) {
      setUploadError(`${invalid.name} is not a PDF. Please select PDF files only.`);
      setUploadMessage("");
      return;
    }

    setUploading(true);
    setUploadError("");
    setUploadMessage(`Uploading ${selectedFiles.length} PDF file(s)...`);

    try {
      const formData = new FormData();
      selectedFiles.forEach(file => formData.append("files", file));

      const response = await fetch(`${API}/api/upload`, {
        method: "POST",
        body: formData
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(typeof data.detail === "string" ? data.detail : "PDF upload failed.");
      }

      setUploadMessage(data.message || "PDF upload completed successfully.");
      await refreshDocuments();
      setMessages(prev => [
        ...prev,
        {
          role: "assistant",
          content: `${data.message || "Your PDF files are ready."}\n\nYou can now ask questions about your uploaded documents.`,
          sources: []
        }
      ]);
    } catch (error) {
      console.error("PDF upload failed:", error);
      setUploadError(error.message || "Could not upload PDF files.");
      setUploadMessage("");
    } finally {
      setUploading(false);
    }
  }

  async function send(text = input) {
    const question = text.trim();
    if (!question || loading) return;

    setInput("");
    setMessages(prev => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, question })
      });

      const data = await response.json();
      if (!response.ok) {
        if (typeof data.detail === "string" && data.detail.toLowerCase().includes("knowledge base is empty")) {
          setMessages(prev => [...prev, {
            role: "assistant",
            content: "Your PDF knowledge base is currently empty. 📄\n\nUse the Upload PDFs button in the sidebar to add documents. Once they are processed, I'll be ready to answer your questions!",
            sources: []
          }]);
          return;
        }
        throw new Error(typeof data.detail === "string" ? data.detail : "Request failed");
      }

      setMessages(prev => [...prev, {
        role: "assistant",
        content: data.answer,
        sources: data.sources || [],
        query: data.standalone_question
      }]);
    } catch (error) {
      console.error("Chat request failed:", error);
      setMessages(prev => [...prev, {
        role: "error",
        content: error.message || "Could not reach the API."
      }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  async function clearChat() {
    try {
      await fetch(`${API}/api/clear_chat/${sessionId}`, { method: "DELETE" });
    } catch (error) {
      console.error("Could not clear backend history:", error);
    }
    const id = makeId();
    sessionStorage.setItem("nova_session_id", id);
    setSessionId(id);
    setMessages([]);
    setSourcesOpen({});
    setMobile(false);
  }

  async function copy(text, index) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      setTimeout(() => setCopied(-1), 1200);
    } catch (error) {
      console.error("Copy failed:", error);
    }
  }

  const starters = [
    ["Summarize my PDFs", "Summarize the main topics covered in my PDF documents."],
    ["Explain a concept", "Explain the most important concept in my documents simply."],
    ["Find key information", "What are the key findings in my documents?"]
  ];

  return (
    <div className="shell">
      {mobile && <div className="scrim" onClick={() => setMobile(false)} />}

      <aside className={`sidebar ${sidebar ? "" : "collapsed"} ${mobile ? "mobile-open" : ""}`}>
        <div className="brand">
          <div className="brand-icon"><Bot size={21} /></div>
          {sidebar && <div className="brand-name">Retrieva_AI<span>.</span><small>RAG ASSISTANT</small></div>}
          <button className="icon-btn collapse-btn" onClick={() => setSidebar(!sidebar)} title="Toggle sidebar">☰</button>
          <button className="icon-btn mobile-close" onClick={() => setMobile(false)}><X size={18} /></button>
        </div>

        

        {sidebar && <>
          <div className="section-label">WORKSPACE</div>
          <div className="knowledge-card">
            <div className="file-icon"><FileText size={17} /></div>
            <div><b>PDF knowledge base</b><small>{documents.length} document(s) · FAISS</small></div>
            <i />
          </div>

          <div className="upload-card">
            <input
              ref={fileInputRef}
              className="file-input-hidden"
              type="file"
              accept="application/pdf,.pdf"
              multiple
              onChange={handleUpload}
            />
            <button className="upload-button" onClick={() => fileInputRef.current?.click()} disabled={uploading || status !== "online"}>
              {uploading ? <LoaderCircle size={16} className="spin" /> : <UploadCloud size={16} />}
              {uploading ? "Processing PDFs..." : "Upload PDFs"}
            </button>
            <small className="upload-caption">PDF files only · up to 25 MB each</small>
            {uploadMessage && <div className="upload-success">{uploadMessage}</div>}
            {uploadError && <div className="upload-error">{uploadError}</div>}
          </div>

          {documents.length > 0 && <div className="document-list">
            <div className="section-label">UPLOADED DOCUMENTS</div>
            {documents.map(doc => (
              <div className="document-item" key={doc.name} title={doc.name}>
                <FileText size={14} />
                <span>{doc.name}</span>
              </div>
            ))}
          </div>}

          <div className="section-label">SESSION</div>
          <div className="session-row"><Bot size={15} />Current conversation</div>
          <div className="side-bottom">
            <div className="model-card"><Sparkles size={17} /><div><b>Mistral Large</b><small>AWS Bedrock</small></div></div>
            <button className="clear-btn" onClick={clearChat}><Trash2 size={15} /> Clear conversation</button>
            <div className="side-foot">RETRIEVA_AI · PRIVATE WORKSPACE</div>
          </div>
        </>}
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="crumb"><button className="icon-btn mobile-menu" onClick={() => setMobile(true)}><Menu size={19} /></button>Workspace <span>/</span> <b>Assistant</b></div>
          <div className="top-actions"><div className={`api-status ${status}`}><i />{status === "online" ? "API connected" : status === "offline" ? "API offline" : "Connecting"}</div><div className="avatar">U</div></div>
        </header>

        <section className={`chat ${messages.length ? "" : "welcome-chat"}`}>
          {!messages.length ? <div className="welcome">
            <div className="hero-icon"><Bot size={31} /><Sparkles className="spark" size={15} /></div>
            <div className="eyebrow">YOUR DOCUMENT INTELLIGENCE ASSISTANT</div>
            <h1>Ask your documents<br /><em>anything.</em></h1>
            <p>Explore your PDF knowledge base with grounded answers powered by retrieval-augmented generation.</p>
            <div className="starter-grid">{starters.map(([label, prompt]) => <button key={label} onClick={() => send(prompt)}><span><Sparkles size={16} /></span>{label}<Send size={14} /></button>)}</div>
            <small className="welcome-foot">✦ Upload PDF documents from the sidebar to get started.</small>
          </div> : <div className="messages">
            {messages.map((m, i) => <div className={`message ${m.role}`} key={i}>
              <div className={`message-icon ${m.role}`}>{m.role === "user" ? "U" : <Bot size={18} />}</div>
              <div className="message-body">
                <b>{m.role === "user" ? "You" : m.role === "error" ? "Error" : "Retrieva_AI assistant"}</b>
                <div className="message-text">{m.content}</div>
                {m.role === "assistant" && <div className="message-actions">
                  <button onClick={() => copy(m.content, i)}>{copied === i ? <Check size={13} /> : <Copy size={13} />}{copied === i ? "Copied" : "Copy"}</button>
                  {!!m.sources?.length && <button onClick={() => setSourcesOpen(prev => ({ ...prev, [i]: !prev[i] }))}><FileText size={13} />{m.sources.length} sources<ChevronDown size={13} /></button>}
                </div>}
                {m.role === "assistant" && sourcesOpen[i] && <div className="source-panel">
                  <strong>RETRIEVED SOURCES</strong>
                  {m.sources.map((source, n) => <div className="source" key={n}><FileText size={14} />{source.file}{source.page ? <small>Page {source.page}</small> : null}</div>)}
                  {m.query && <small className="query">Retrieval query: {m.query}</small>}
                </div>}
              </div>
            </div>)}
            {loading && <div className="message assistant"><div className="message-icon assistant"><Bot size={18} /></div><div className="message-body"><b>Retrieva_AI assistant</b><div className="typing"><i /><i /><i /> Searching documents and composing answer</div></div></div>}
            <div ref={bottom} />
          </div>}
        </section>

        <div className="composer-wrap">
          <form className="composer" onSubmit={event => { event.preventDefault(); send(); }}>
            <textarea ref={inputRef} rows="1" value={input} disabled={loading} placeholder="Ask a question about your documents..." onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} />
            <button disabled={!input.trim() || loading} aria-label="Send"><Send size={17} /></button>
          </form>
          <div className="composer-hint"><span><i /> {documents.length ? `${documents.length} PDF document(s) available` : "Upload PDFs to build your knowledge base"}</span><span>Enter to send · Shift + Enter for new line</span></div>
        </div>
        <footer className="footer">Retrieva_AI can make mistakes. Verify important information against your source documents.</footer>
      </main>
    </div>
  );
}
