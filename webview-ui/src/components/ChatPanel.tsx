import React, { useState, useRef, useEffect, useCallback } from 'react';
import { postMessage } from '../vscode';
import type { ChatMessage } from '../types';
import { Icon } from './Icons';

interface ChatPanelProps {
    isOpen: boolean;
    onToggle: () => void;
}

export function ChatPanel({ isOpen, onToggle }: ChatPanelProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [isThinking, setIsThinking] = useState(false);
    const [thinkingText, setThinkingText] = useState('');
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const autoSpeakOnNextReplyRef = useRef(false);
    const isAtBottomRef = useRef(true);

    // Auto-scroll only when the user is at/near the bottom.
    // Use instant scrollTop (not smooth) so rapid streaming chunks don't
    // spawn competing animations that fight the user's manual scroll.
    useEffect(() => {
        if (isAtBottomRef.current) {
            const container = messagesContainerRef.current;
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }, [messages]);

    const handleMessagesScroll = useCallback(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        isAtBottomRef.current =
            container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    }, []);

    const speakNow = useCallback((text: string) => {
        if (!text.trim()) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.onend = () => setIsSpeaking(false);
        utterance.onerror = () => setIsSpeaking(false);
        setIsSpeaking(true);
        window.speechSynthesis.speak(utterance);
    }, []);

    // Listen for chat responses
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data;
            switch (msg.type) {
                case 'chatChunk': {
                    const chunk = msg.payload as { content: string };
                    setIsThinking(false);
                    setThinkingText('');
                    setMessages((prev) => {
                        const last = prev[prev.length - 1];
                        if (last && last.role === 'assistant' && last.isStreaming) {
                            return [
                                ...prev.slice(0, -1),
                                { ...last, content: last.content + chunk.content },
                            ];
                        }
                        return [
                            ...prev,
                            {
                                role: 'assistant',
                                content: chunk.content,
                                timestamp: Date.now(),
                                isStreaming: true,
                            },
                        ];
                    });
                    break;
                }
                case 'chatResponse': {
                    const response = msg.payload as { content: string; error?: string };
                    setIsThinking(false);
                    setThinkingText('');
                    if (response.error) {
                        autoSpeakOnNextReplyRef.current = false;
                        setError(response.error);
                        setIsStreaming(false);
                        return;
                    }
                    setMessages((prev) => {
                        const last = prev[prev.length - 1];
                        if (last && last.role === 'assistant' && last.isStreaming) {
                            return [
                                ...prev.slice(0, -1),
                                { ...last, content: response.content, isStreaming: false },
                            ];
                        }
                        return [
                            ...prev,
                            {
                                role: 'assistant',
                                content: response.content,
                                timestamp: Date.now(),
                                isStreaming: false,
                            },
                        ];
                    });
                    setIsStreaming(false);
                    if (autoSpeakOnNextReplyRef.current) {
                        autoSpeakOnNextReplyRef.current = false;
                        speakNow(response.content);
                    }
                    break;
                }
                case 'chatThinking': {
                    const think = msg.payload as { content: string };
                    setThinkingText((prev) => prev + think.content);
                    break;
                }
                case 'error': {
                    const errPayload = msg.payload as { message: string };
                    setError(errPayload.message);
                    setIsStreaming(false);
                    setIsThinking(false);
                    setThinkingText('');
                    break;
                }
                case 'voiceTranscript': {
                    const vt = msg.payload as { transcript?: string; error?: string };
                    setIsTranscribing(false);
                    if (vt.error) {
                        setError(vt.error);
                    } else if (vt.transcript?.trim()) {
                        const transcript = vt.transcript.trim();
                        autoSpeakOnNextReplyRef.current = true;

                        const userMsg: ChatMessage = {
                            role: 'user',
                            content: transcript,
                            timestamp: Date.now(),
                        };
                        setMessages((prev) => [...prev, userMsg]);
                        setInput('');
                        setIsStreaming(true);
                        setIsThinking(true);
                        setThinkingText('');
                        setError(null);
                        isAtBottomRef.current = true;

                        postMessage('chatMessage', { content: transcript });
                    } else {
                        setError('No speech detected. Please try again.');
                    }
                    break;
                }
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [speakNow]);

    const sendMessage = useCallback(
        (text: string) => {
            if (!text.trim() || isStreaming) return;

            const userMsg: ChatMessage = {
                role: 'user',
                content: text.trim(),
                timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, userMsg]);
            setInput('');
            setIsStreaming(true);
            setIsThinking(true);
            setThinkingText('');
            setError(null);
            isAtBottomRef.current = true;

            postMessage('chatMessage', { content: text.trim() });
        },
        [isStreaming]
    );

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(input);
        }
    };

    const clearChat = () => {
        setMessages([]);
        setError(null);
        postMessage('clearChat');
    };

    // --- Audio: Voice Input via Webview Browser Audio API ---
    // Browser permission prompt comes from getUserMedia() in this webview.
    const toggleRecording = useCallback(async () => {
        if (isRecording) {
            mediaRecorderRef.current?.stop();
            setIsRecording(false);
            return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            setError('Microphone access is not available in this environment.');
            return;
        }

        try {
            if (navigator.permissions?.query) {
                const micPermission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
                if (micPermission.state === 'denied') {
                    setError('Microphone permission is denied. Please allow microphone access and try again.');
                    return;
                }
            }
        } catch {
            // Some webview environments do not expose the permissions API.
        }

        let stream: MediaStream;
        try {
            // Triggers browser/OS permission popup on first access.
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });
        } catch (err) {
            const name = (err as DOMException)?.name || '';
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                setError('Microphone permission was denied. Please allow access and try again.');
            } else if (name === 'NotFoundError') {
                setError('No microphone was found on this device.');
            } else if (name === 'NotReadableError') {
                setError('Microphone is in use by another application.');
            } else {
                setError(`Could not access microphone: ${(err as Error)?.message || name || 'unknown error'}`);
            }
            return;
        }

        const chunks: BlobPart[] = [];
        const recorder = new MediaRecorder(stream);

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
            setIsRecording(false);
            stream.getTracks().forEach((t) => t.stop());
            if (chunks.length === 0) {
                setError('No audio was captured. Please try again.');
                return;
            }

            setIsTranscribing(true);
            const blob = new Blob(chunks, { type: recorder.mimeType });
            const reader = new FileReader();
            reader.onloadend = () => {
                const dataUrl = reader.result as string;
                const base64 = dataUrl.split(',')[1];
                postMessage('voiceInputAudio', { audio: base64, mimeType: recorder.mimeType });
            };
            reader.readAsDataURL(blob);
        };

        recorder.onerror = () => {
            stream.getTracks().forEach((t) => t.stop());
            setIsRecording(false);
            setError('Recording failed. Please try again.');
        };

        mediaRecorderRef.current = recorder;
        recorder.start();
        setIsRecording(true);
        setError(null);
    }, [isRecording]);

    // --- Audio: Text-to-Speech ---
    const speakText = useCallback(
        (text: string) => {
            if (isSpeaking) {
                window.speechSynthesis.cancel();
                setIsSpeaking(false);
                return;
            }

            speakNow(text);
        },
        [isSpeaking, speakNow]
    );

    if (!isOpen) {
        return (
            <button className="chat-fab" onClick={onToggle} title="Open Architecture Chat">
                <Icon name="chatFab" size="lg" />
            </button>
        );
    }

    return (
        <div className={`chat-panel${isExpanded ? ' chat-panel-expanded' : ''}`}>
            <div className="chat-header">
                <div className="chat-header-left">
                    <Icon name="systemView" className="chat-header-icon" />
                    <h3>Architecture Assistant</h3>
                </div>
                <div className="chat-header-actions">
                    <button className="chat-action-btn" onClick={clearChat} title="Clear conversation">
                        <Icon name="clearChat" />
                    </button>
                    <button
                        className="chat-action-btn"
                        onClick={() => setIsExpanded((v) => !v)}
                        title={isExpanded ? 'Collapse panel' : 'Expand panel'}
                    >
                        <Icon name={isExpanded ? 'collapsePanel' : 'expandPanel'} />
                    </button>
                    <button className="chat-action-btn" onClick={onToggle} title="Minimize">
                        <Icon name="minimize" />
                    </button>
                </div>
            </div>

            <div className="chat-messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
                {messages.length === 0 && (
                    <div className="chat-welcome">
                        <div className="chat-welcome-icon">
                            <Icon name="systemView" size="2x" />
                        </div>
                        <h4>Architecture Assistant</h4>
                        <p>Ask questions about your codebase architecture, subsystems, dependencies, and design patterns.</p>
                        <div className="chat-suggestions">
                            <button
                                className="chat-suggestion"
                                onClick={() => sendMessage('What is the overall architecture of this codebase?')}
                            >
                                What is the overall architecture?
                            </button>
                            <button
                                className="chat-suggestion"
                                onClick={() => sendMessage('Explain the main subsystems and their responsibilities.')}
                            >
                                Explain the main subsystems
                            </button>
                            <button
                                className="chat-suggestion"
                                onClick={() => sendMessage('What are the key dependencies between components?')}
                            >
                                Key dependencies between components
                            </button>
                        </div>
                    </div>
                )}

                {messages.map((msg, i) => (
                    <div key={i} className={`chat-message chat-message-${msg.role}`}>
                        <div className="chat-message-avatar">
                            {msg.role === 'user' ? (
                                <Icon name="userAvatar" />
                            ) : (
                                window.CODEARCY_ICON_URI
                                    ? <img src={window.CODEARCY_ICON_URI} alt="CodeArchy" className="chat-avatar-icon" />
                                    : <Icon name="botAvatar" />
                            )}
                        </div>
                        <div className="chat-message-content">
                            <div className="chat-message-text">
                                {formatMessage(msg.content)}
                                {msg.isStreaming && <span className="chat-cursor">▊</span>}
                            </div>
                            {msg.role === 'assistant' && !msg.isStreaming && (
                                <button
                                    className="chat-speak-btn"
                                    onClick={() => speakText(msg.content)}
                                    title={isSpeaking ? 'Stop speaking' : 'Read aloud'}
                                >
                                    <Icon name={isSpeaking ? 'stopAction' : 'speakAloud'} />
                                </button>
                            )}
                        </div>
                    </div>
                ))}

                {isThinking && (
                    <div className="chat-message chat-message-assistant">
                        <div className="chat-message-avatar">
                            {window.CODEARCY_ICON_URI
                                ? <img src={window.CODEARCY_ICON_URI} alt="CodeArchy" className="chat-avatar-icon" />
                                : <Icon name="botAvatar" />}
                        </div>
                        <div className="chat-message-content">
                            <div className="chat-message-text chat-thinking-bubble">
                                <ThinkingBubble text={thinkingText} />
                            </div>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="chat-error">
                        <Icon name="warning" className="chat-error-icon" />
                        <span>{error}</span>
                        <button className="chat-error-dismiss" onClick={() => setError(null)}>
                            <Icon name="close" />
                        </button>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-area">
                <textarea
                    ref={inputRef}
                    className="chat-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isStreaming ? 'Waiting for response...' : 'Ask about the architecture...'}
                    disabled={isStreaming}
                    rows={1}
                />
                <div className="chat-input-actions">
                    <button
                        className={`chat-voice-btn ${isRecording ? 'recording' : ''} ${isTranscribing ? 'transcribing' : ''}`}
                        onClick={toggleRecording}
                        title={isRecording ? 'Stop recording' : isTranscribing ? 'Transcribing…' : 'Voice input'}
                        disabled={isStreaming || isTranscribing}
                    >
                        {isTranscribing
                            ? <Icon name="spinner" spin />
                            : <Icon name={isRecording ? 'stopAction' : 'voiceInput'} />
                        }
                    </button>
                    <button
                        className="chat-send-btn"
                        onClick={() => sendMessage(input)}
                        disabled={!input.trim() || isStreaming}
                        title="Send message"
                    >
                        {isStreaming ? (
                            <Icon name="spinner" spin />
                        ) : (
                            <Icon name="send" />
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}

/** Thinking indicator.
 * - When the model streams thinking tokens, displays them verbatim with a cursor.
 * - When no thinking tokens have arrived yet, shows a single animated "Thinking…" fallback.
 */
function ThinkingBubble({ text }: { text: string }) {
    if (text) {
        // Real reasoning streamed from the model — apply full markdown formatting
        return (
            <div className="chat-thinking-text">
                <span className="chat-thinking-label">Reasoning</span>
                <div className="chat-thinking-stream">
                    {formatMessage(text)}<span className="chat-cursor">▊</span>
                </div>
            </div>
        );
    }

    // Fallback: single animated label — no cycling phrases
    return (
        <span className="chat-thinking-text">
            <span className="chat-thinking-label">Thinking</span>
        </span>
    );
}

/** Full markdown formatter: headers, lists, tables, code blocks, bold, italic, inline code */
function formatMessage(text: string): React.ReactNode {
    const lines = text.split('\n');
    const nodes: React.ReactNode[] = [];
    let i = 0;
    let k = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Code fence
        if (line.trimStart().startsWith('```')) {
            const lang = line.trimStart().slice(3).trim();
            const codeLines: string[] = [];
            i++;
            while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            nodes.push(
                <pre key={k++} className="chat-code-block">
                    {lang && <span className="chat-code-lang">{lang}</span>}
                    <code>{codeLines.join('\n')}</code>
                </pre>
            );
            i++; // skip closing fence (or advance past end if unclosed)
            continue;
        }

        // Headings
        const hMatch = line.match(/^(#{1,6})\s+(.+)/);
        if (hMatch) {
            const level = Math.min(hMatch[1].length, 3);
            const content = inlineFormat(hMatch[2]);
            const key = k++;
            if (level === 1) nodes.push(<h4 key={key} className="chat-md-h1">{content}</h4>);
            else if (level === 2) nodes.push(<h5 key={key} className="chat-md-h2">{content}</h5>);
            else nodes.push(<h6 key={key} className="chat-md-h3">{content}</h6>);
            i++;
            continue;
        }

        // Table (lines starting with |)
        if (line.startsWith('|')) {
            const tableLines: string[] = [];
            while (i < lines.length && lines[i].startsWith('|')) {
                tableLines.push(lines[i]);
                i++;
            }
            nodes.push(<MdTable key={k++} lines={tableLines} />);
            continue;
        }

        // Unordered list (- item, * item, + item)
        if (/^(\s*)[-*+] /.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^(\s*)[-*+] /.test(lines[i])) {
                items.push(lines[i].replace(/^(\s*)[-*+] /, ''));
                i++;
            }
            nodes.push(
                <ul key={k++} className="chat-md-ul">
                    {items.map((item, j) => <li key={j}>{inlineFormat(item)}</li>)}
                </ul>
            );
            continue;
        }

        // Ordered list (1. item)
        if (/^\s*\d+\.\s/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*\d+\.\s/, ''));
                i++;
            }
            nodes.push(
                <ol key={k++} className="chat-md-ol">
                    {items.map((item, j) => <li key={j}>{inlineFormat(item)}</li>)}
                </ol>
            );
            continue;
        }

        // Blockquote (> text)
        if (line.startsWith('> ')) {
            const bqLines: string[] = [];
            while (i < lines.length && lines[i].startsWith('> ')) {
                bqLines.push(lines[i].slice(2));
                i++;
            }
            nodes.push(
                <blockquote key={k++} className="chat-md-bq">
                    {bqLines.map((bLine, j) => <p key={j}>{inlineFormat(bLine)}</p>)}
                </blockquote>
            );
            continue;
        }

        // Horizontal rule
        if (/^[-_*]{3,}\s*$/.test(line) && line.trim() !== '') {
            nodes.push(<hr key={k++} className="chat-md-hr" />);
            i++;
            continue;
        }

        // Empty line — paragraph separator, skip
        if (line.trim() === '') {
            i++;
            continue;
        }

        // Default paragraph
        nodes.push(<p key={k++} className="chat-md-p">{inlineFormat(line)}</p>);
        i++;
    }

    return <div className="chat-markdown">{nodes}</div>;
}

/** Render inline markdown: bold, italic, inline code */
function inlineFormat(text: string): React.ReactNode {
    const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g);
    return (
        <>
            {parts.map((part, i) => {
                if (!part) return null;
                if (part.startsWith('`') && part.endsWith('`') && part.length >= 3) {
                    return <code key={i} className="chat-inline-code">{part.slice(1, -1)}</code>;
                }
                if (part.startsWith('**') && part.endsWith('**') && part.length >= 5) {
                    return <strong key={i}>{part.slice(2, -2)}</strong>;
                }
                if (part.startsWith('*') && part.endsWith('*') && part.length >= 3) {
                    return <em key={i}>{part.slice(1, -1)}</em>;
                }
                return <React.Fragment key={i}>{part}</React.Fragment>;
            })}
        </>
    );
}

/** Render a markdown table */
function MdTable({ lines }: { lines: string[] }) {
    const parseRow = (row: string): string[] =>
        row.split('|').slice(1, -1).map((c) => c.trim());

    const isSeparator = (row: string) => /^\|[\s|:-]+\|$/.test(row.trim());

    const headerRow = lines[0] ? parseRow(lines[0]) : [];
    const dataLines = lines.filter((_, idx) => idx > 0 && !isSeparator(lines[idx]));

    return (
        <div className="chat-md-table-wrap">
            <table className="chat-md-table">
                {headerRow.length > 0 && (
                    <thead>
                        <tr>{headerRow.map((cell, i) => <th key={i}>{inlineFormat(cell)}</th>)}</tr>
                    </thead>
                )}
                <tbody>
                    {dataLines.map((row, ri) => (
                        <tr key={ri}>
                            {parseRow(row).map((cell, ci) => <td key={ci}>{inlineFormat(cell)}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
