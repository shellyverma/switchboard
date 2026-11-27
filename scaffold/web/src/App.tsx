import { useEffect, useRef, useState, type FormEvent } from 'react';
import './App.css';

type Membership = {
  id: string;
  role: 'admin' | 'agent';
};

type User = {
  sub: string;
  workspaces: Membership[];
};

type Conversation = {
  contact: string;
  status: 'open' | 'closed';
  assignee: string | null;
  lastActivityAt: string;
};

type Message = {
  key: string;
  direction: 'inbound' | 'outbound';
  text: string;
  occurredAt: string;
  status?: 'queued' | 'sent' | 'delivered' | 'failed';
};

type ConversationPage = {
  conversations: Conversation[];
  nextCursor: string | null;
};

type LiveEvent = {
  seq: number;
  type: string;
  contact?: string;
};

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function App() {
  const [user, setUser] = useState<User | null>();
  const [workspace, setWorkspace] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedContact, setSelectedContact] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshInbox, setRefreshInbox] = useState(0);
  const [refreshThread, setRefreshThread] = useState(0);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>(
    'connecting',
  );
  const [search, setSearch] = useState('');
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [userLoading, setUserLoading] = useState(true);
  const socketCursors = useRef(new Map<string, number>());
  const selectedContactRef = useRef(selectedContact);

  useEffect(() => {
    selectedContactRef.current = selectedContact;
  }, [selectedContact]);

  useEffect(() => {
    let active = true;
    requestJson('/api/me')
      .then(parseUser)
      .then((currentUser) => {
        if (active) setUser(currentUser);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401) {
          setUser(null);
          return;
        }
        setError(messageForError(cause));
      })
      .finally(() => {
        if (active) setUserLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    if (!user.workspaces.some((membership) => membership.id === workspace)) {
      setWorkspace(user.workspaces[0]?.id ?? '');
    }
  }, [user, workspace]);

  useEffect(() => {
    if (!workspace) {
      setConversations([]);
      setSelectedContact('');
      setMessages([]);
      return;
    }
    let active = true;
    setInboxLoading(true);
    requestJson(`/api/conversations?workspace=${encodeURIComponent(workspace)}&limit=30`)
      .then(parseConversationPage)
      .then((page) => {
        if (!active) return;
        setConversations(page.conversations);
        setNextCursor(page.nextCursor);
        setSelectedContact((current) =>
          page.conversations.some((conversation) => conversation.contact === current)
            ? current
            : (page.conversations[0]?.contact ?? ''),
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(messageForError(cause));
      })
      .finally(() => {
        if (active) setInboxLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspace, refreshInbox]);

  useEffect(() => {
    if (!workspace || !selectedContact) {
      setMessages([]);
      return;
    }
    let active = true;
    setThreadLoading(true);
    requestJson(
      `/api/conversations/${encodeURIComponent(selectedContact)}/messages?workspace=${encodeURIComponent(workspace)}`,
    )
      .then(parseConversationThread)
      .then((thread) => {
        if (active) setMessages(thread.messages);
      })
      .catch((cause: unknown) => {
        if (active) setError(messageForError(cause));
      })
      .finally(() => {
        if (active) setThreadLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspace, selectedContact, refreshThread]);

  useEffect(() => {
    if (!workspace || !user) return;
    let stopped = false;
    let retryTimer: number | undefined;
    let attempts = 0;
    let socket: WebSocket | undefined;

    const connect = () => {
      if (stopped) return;
      setConnection(attempts === 0 ? 'connecting' : 'reconnecting');
      const after = socketCursors.current.get(workspace);
      const query = new URLSearchParams({ workspace });
      if (after !== undefined) query.set('after', String(after));
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws?${query}`);
      socket.onopen = () => {
        attempts = 0;
        setConnection('live');
        setRefreshInbox((current) => current + 1);
        if (selectedContactRef.current) {
          setRefreshThread((current) => current + 1);
        }
      };
      socket.onmessage = (frame) => {
        const event = parseLiveEvent(frame.data);
        if (!event) {
          setConnection('reconnecting');
          socket?.close();
          return;
        }
        const previous = socketCursors.current.get(workspace) ?? 0;
        if (event.seq <= previous) return;
        socketCursors.current.set(workspace, event.seq);
        setRefreshInbox((current) => current + 1);
        if (event.contact && event.contact === selectedContactRef.current) {
          setRefreshThread((current) => current + 1);
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnection('reconnecting');
        const delay = Math.min(30_000, 500 * 2 ** Math.min(attempts, 6));
        attempts += 1;
        retryTimer = window.setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [workspace, user]);

  async function loadMore(): Promise<void> {
    if (!workspace || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const page = parseConversationPage(
        await requestJson(
          `/api/conversations?workspace=${encodeURIComponent(workspace)}&limit=30&cursor=${encodeURIComponent(nextCursor)}`,
        ),
      );
      setConversations((current) => [...current, ...page.conversations]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  async function claimConversation(): Promise<void> {
    if (!workspace || !selectedContact) return;
    await runAction(async () => {
      await requestJson(
        `/api/conversations/${encodeURIComponent(selectedContact)}/claim?workspace=${encodeURIComponent(workspace)}`,
        { method: 'POST' },
      );
      refreshCurrentConversation();
    });
  }

  async function changeConversationStatus(status: 'close' | 'reopen'): Promise<void> {
    if (!workspace || !selectedContact) return;
    await runAction(async () => {
      await requestJson(
        `/api/conversations/${encodeURIComponent(selectedContact)}/${status}?workspace=${encodeURIComponent(workspace)}`,
        { method: 'POST' },
      );
      refreshCurrentConversation();
    });
  }

  async function sendReply(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const text = replyText.trim();
    if (!workspace || !selectedContact || !text) return;
    await runAction(async () => {
      await requestJson(
        `/api/conversations/${encodeURIComponent(selectedContact)}/reply?workspace=${encodeURIComponent(workspace)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, client_ref: crypto.randomUUID() }),
        },
      );
      setReplyText('');
      refreshCurrentConversation();
    });
  }

  async function runAction(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      setBusy(false);
    }
  }

  function refreshCurrentConversation(): void {
    setRefreshInbox((current) => current + 1);
    setRefreshThread((current) => current + 1);
  }

  const selected = conversations.find((conversation) => conversation.contact === selectedContact);
  const currentMembership = user?.workspaces.find((membership) => membership.id === workspace);
  const filteredConversations = conversations.filter((conversation) =>
    conversation.contact.toLowerCase().includes(search.trim().toLowerCase()),
  );

  if (userLoading) {
    return <main className="loading-screen">Opening your inbox...</main>;
  }

  if (!user) {
    return (
      <main className="login-screen">
        <section className="login-card">
          <div className="brand-mark">S</div>
          <p className="eyebrow">TEAM MESSAGING</p>
          <h1>Welcome to Switchboard</h1>
          <p className="muted">Sign in with your work account to open your shared inbox.</p>
          {error && <p className="error-banner">{error}</p>}
          <a className="primary-button login-button" href="/auth/login">
            Sign in
          </a>
        </section>
      </main>
    );
  }

  if (user.workspaces.length === 0) {
    return (
      <main className="login-screen">
        <section className="login-card">
          <div className="brand-mark">S</div>
          <h1>No workspace access</h1>
          <p className="muted">Your account is signed in, but it is not assigned to a workspace.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="inbox-sidebar">
        <header className="sidebar-header">
          <div className="brand-mark small">S</div>
          <div>
            <h1>Switchboard</h1>
            <p>Shared inbox</p>
          </div>
          <span className={`connection-dot ${connection}`} title={connection} />
        </header>

        <label className="workspace-label" htmlFor="workspace">
          WORKSPACE
        </label>
        <select
          id="workspace"
          className="workspace-select"
          value={workspace}
          onChange={(event) => {
            setWorkspace(event.target.value);
            setSearch('');
            setError('');
            setConversations([]);
            setNextCursor(null);
            setSelectedContact('');
            setMessages([]);
          }}
        >
          {user.workspaces.map((membership) => (
            <option key={membership.id} value={membership.id}>
              {membership.id.replace(/^ws_/, '')}
            </option>
          ))}
        </select>

        <div className="inbox-heading">
          <div>
            <p className="eyebrow">YOUR QUEUE</p>
            <h2>Conversations</h2>
          </div>
          <span className="conversation-count">{conversations.length}</span>
        </div>
        <label className="search-box">
          <span className="search-icon" aria-hidden="true" />
          <input
            aria-label="Search conversations"
            placeholder="Search contacts"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <div className="conversation-list" aria-label="Conversations">
          {inboxLoading && conversations.length === 0 ? (
            <p className="empty-list">Loading conversations...</p>
          ) : filteredConversations.length === 0 ? (
            <p className="empty-list">
              {search ? 'No matching contacts.' : 'No conversations yet. New messages will appear here.'}
            </p>
          ) : (
            filteredConversations.map((conversation) => (
              <button
                className={`conversation-row ${selectedContact === conversation.contact ? 'selected' : ''}`}
                key={conversation.contact}
                onClick={() => setSelectedContact(conversation.contact)}
              >
                <span className="avatar">{initials(conversation.contact)}</span>
                <span className="conversation-copy">
                  <span className="conversation-topline">
                    <strong>{conversation.contact}</strong>
                    <time>{formatTime(conversation.lastActivityAt)}</time>
                  </span>
                  <span className="conversation-preview">
                    {conversation.assignee ? `Assigned to ${conversation.assignee}` : 'Unassigned'}
                  </span>
                </span>
                <span className={`status-pip ${conversation.status}`} />
              </button>
            ))
          )}
          {nextCursor && (
            <button className="load-more" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : 'Load older conversations'}
            </button>
          )}
        </div>

        <footer className="sidebar-footer">
          <span className="avatar user-avatar">{initials(user.sub)}</span>
          <span className="profile-copy">
            <strong>{user.sub}</strong>
            <span>{currentMembership?.role ?? 'Agent'}</span>
          </span>
          <a className="sign-out" href="/auth/login" title="Switch account">
            Switch
          </a>
        </footer>
      </aside>

      <section className="conversation-panel">
        {selected ? (
          <>
            <header className="thread-header">
              <div className="contact-heading">
                <span className="avatar large">{initials(selected.contact)}</span>
                <div>
                  <h2>{selected.contact}</h2>
                  <p>
                    {selected.status === 'open' ? 'Open conversation' : 'Closed conversation'}
                    {selected.assignee ? ` / Assigned to ${selected.assignee}` : ' / Unassigned'}
                  </p>
                </div>
              </div>
              <div className="thread-actions">
                {selected.assignee === user.sub ? (
                  <span className="assigned-tag">Assigned to you</span>
                ) : (
                  <button
                    className="secondary-button"
                    onClick={() => void claimConversation()}
                    disabled={busy || Boolean(selected.assignee)}
                  >
                    {selected.assignee ? `Claimed by ${selected.assignee}` : 'Claim conversation'}
                  </button>
                )}
                {selected.status === 'open' ? (
                  <button
                    className="quiet-button"
                    onClick={() => void changeConversationStatus('close')}
                    disabled={busy}
                  >
                    Close
                  </button>
                ) : (
                  <button
                    className="quiet-button"
                    onClick={() => void changeConversationStatus('reopen')}
                    disabled={busy}
                  >
                    Reopen
                  </button>
                )}
              </div>
            </header>

            {error && <p className="inline-error">{error}</p>}

            <div className="message-list" aria-live="polite">
              {threadLoading ? (
                <p className="thread-empty">Loading messages...</p>
              ) : messages.length === 0 ? (
                <p className="thread-empty">No messages in this conversation yet.</p>
              ) : (
                messages.map((message) => (
                  <article
                    className={`message ${message.direction}`}
                    key={message.key}
                    aria-label={`${message.direction === 'inbound' ? 'Customer' : 'Agent'} message`}
                  >
                    {message.direction === 'inbound' && (
                      <span className="message-author">Customer</span>
                    )}
                    <div className="message-bubble">{message.text}</div>
                    <div className="message-meta">
                      <time>{formatDateTime(message.occurredAt)}</time>
                      {message.status && (
                        <span className={`reply-status ${message.status}`}>{message.status}</span>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>

            <form className="reply-composer" onSubmit={(event) => void sendReply(event)}>
              <textarea
                aria-label="Write a reply"
                placeholder={
                  selected.status === 'closed'
                    ? 'Reopen this conversation to reply'
                    : 'Write a reply...'
                }
                value={replyText}
                onChange={(event) => setReplyText(event.target.value)}
                disabled={selected.status === 'closed' || busy}
                rows={3}
              />
              <div className="composer-footer">
                <span>Replies are sent securely through Pigeon.</span>
                <button
                  className="primary-button send-button"
                  type="submit"
                  disabled={selected.status === 'closed' || busy || !replyText.trim()}
                >
                  {busy ? 'Working...' : 'Send reply'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="welcome-panel">
            <div className="welcome-icon">S</div>
            <p className="eyebrow">TEAM INBOX</p>
            <h2>{inboxLoading ? 'Loading your inbox' : 'Every conversation, together.'}</h2>
            <p>
              {inboxLoading
                ? 'Your latest conversations are on their way.'
                : 'Choose a conversation from the list, or wait for a new customer message.'}
            </p>
            {error && <p className="inline-error">{error}</p>}
          </div>
        )}
      </section>
    </main>
  );
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' });
  if (!response.ok) {
    throw new ApiError(`Request failed (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined;
  return response.json();
}

function parseUser(value: unknown): User {
  if (!isRecord(value) || typeof value.sub !== 'string' || !Array.isArray(value.workspaces)) {
    throw new Error('The server returned an invalid user profile.');
  }
  const workspaces = value.workspaces.map((membership): Membership => {
    if (
      !isRecord(membership) ||
      typeof membership.id !== 'string' ||
      (membership.role !== 'admin' && membership.role !== 'agent')
    ) {
      throw new Error('The server returned an invalid workspace membership.');
    }
    return { id: membership.id, role: membership.role };
  });
  return { sub: value.sub, workspaces };
}

function parseConversationPage(value: unknown): ConversationPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.conversations) ||
    (value.next_cursor !== null && typeof value.next_cursor !== 'string')
  ) {
    throw new Error('The server returned an invalid conversation page.');
  }
  return {
    conversations: value.conversations.map(parseConversation),
    nextCursor: value.next_cursor,
  };
}

function parseConversation(value: unknown): Conversation {
  if (
    !isRecord(value) ||
    typeof value.contact !== 'string' ||
    (value.status !== 'open' && value.status !== 'closed') ||
    (typeof value.assignee !== 'string' && value.assignee !== null) ||
    typeof value.lastActivityAt !== 'string'
  ) {
    throw new Error('The server returned an invalid conversation.');
  }
  return {
    contact: value.contact,
    status: value.status,
    assignee: value.assignee,
    lastActivityAt: value.lastActivityAt,
  };
}

function parseConversationThread(value: unknown): { messages: Message[] } {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error('The server returned an invalid conversation thread.');
  }
  const messages = value.messages.map((message): Message => {
    if (
      !isRecord(message) ||
      (message.direction !== 'inbound' && message.direction !== 'outbound') ||
      typeof message.text !== 'string' ||
      typeof message.occurredAt !== 'string'
    ) {
      throw new Error('The server returned an invalid message.');
    }
    const identifier =
      typeof message.messageId === 'string'
        ? message.messageId
        : typeof message.clientRef === 'string'
          ? message.clientRef
          : '';
    if (!identifier) throw new Error('The server returned a message without an identifier.');
    const status =
      message.status === 'queued' ||
      message.status === 'sent' ||
      message.status === 'delivered' ||
      message.status === 'failed'
        ? message.status
        : undefined;
    return {
      key: `${message.direction}:${identifier}`,
      direction: message.direction,
      text: message.text,
      occurredAt: message.occurredAt,
      ...(status ? { status } : {}),
    };
  });
  messages.sort(
    (first, second) =>
      new Date(first.occurredAt).getTime() - new Date(second.occurredAt).getTime(),
  );
  return { messages };
}

function parseLiveEvent(value: unknown): LiveEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (
      isRecord(parsed) &&
      Number.isSafeInteger(parsed.seq) &&
      typeof parsed.seq === 'number' &&
      typeof parsed.type === 'string' &&
      (parsed.contact === undefined || typeof parsed.contact === 'string')
    ) {
      return {
        seq: parsed.seq,
        type: parsed.type,
        ...(typeof parsed.contact === 'string' ? { contact: parsed.contact } : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function initials(value: string): string {
  const cleaned = value.replace(/[^\da-z]/gi, '');
  return cleaned.slice(-2).toUpperCase() || '??';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
}

function messageForError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 409) return 'Another agent currently owns this conversation.';
    if (cause.status === 401) return 'Your session has expired. Please sign in again.';
    if (cause.status === 403) return 'You do not have access to this workspace.';
    return cause.message;
  }
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}
