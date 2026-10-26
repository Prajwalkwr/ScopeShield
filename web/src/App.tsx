import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Bell,
  Brain,
  BookOpenCheck,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileCheck2,
  FilePlus2,
  FileText,
  FolderKanban,
  Gauge,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  MoreVertical,
  Plus,
  Play,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  SlidersHorizontal,
  Users,
  X,
  XCircle,
} from 'lucide-react';

const API = '/api/v1';

type ApiOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  orgId?: string;
  body?: unknown;
  retryAuth?: boolean;
};

type ApiError = Error & { status?: number };

function csrfCookie(): string {
  const cookie = document.cookie.split('; ').find((part) => part.startsWith('ss_csrf='));
  return cookie ? decodeURIComponent(cookie.slice('ss_csrf='.length)) : '';
}

async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  const isFormData = options.body instanceof FormData;
  if (options.body !== undefined && !isFormData) headers.set('Content-Type', 'application/json');
  if (options.orgId) headers.set('X-Org-Id', options.orgId);
  if (!['GET', 'HEAD'].includes(method)) {
    const csrf = csrfCookie();
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }

  const response = await fetch(`${API}${path}`, {
    method,
    credentials: 'include',
    headers,
    body: options.body === undefined ? undefined : isFormData ? options.body as FormData : JSON.stringify(options.body),
  });

  if (response.status === 401 && options.retryAuth !== false && !path.startsWith('/auth/')) {
    const refreshed = await fetch(`${API}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (refreshed.ok) return api<T>(path, { ...options, retryAuth: false });
  }

  const responseText = await response.text();
  let payload: unknown;
  if (responseText.trim()) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      if (response.ok) throw new Error(`Invalid JSON response from ${path}.`);
    }
  }
  if (!response.ok) {
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'object' &&
      payload.error !== null &&
      'message' in payload.error &&
      typeof payload.error.message === 'string'
        ? payload.error.message
        : `Request failed (${response.status}).`;
    const error = new Error(message) as ApiError;
    error.status = response.status;
    throw error;
  }
  if (response.status === 204 || response.status === 205) return undefined as T;
  if (!responseText.trim()) throw new Error(`Empty response from ${path}.`);
  return payload as T;
}

type OrgMembership = {
  membershipId: string;
  role: string;
  permissions: string[];
  organization: { id: string; name: string; slug: string; currency: string; plan: string; isDemo: boolean };
};
type User = { id: string; name: string; email: string; jobTitle?: string };
type Me = { user: User; memberships: OrgMembership[] };
type ProjectSummary = {
  id: string; code: string; name: string; status: string; client: { id: string; name: string };
  currency: string; contractAmountMinor: number; targetEndDate: string | null;
  currentBaseline: string | null; baselineVersionCount: number; healthScore: number; healthBand: string;
  requests: { open: number; awaitingClient: number; approved: number };
};
type ProjectDetail = {
  _id: string; code: string; name: string; description: string; status: string; targetEndDate: string | null;
  contractAmountMinor: number; currency: string; currentBaseline: string | null; baselineVersionCount: number;
  estimatedHours: number; startDate: string | null;
};
type ProjectResponse = {
  project: ProjectDetail;
  client: { name: string; company: string; contactName: string; contactEmail: string } | null;
  manager: { name: string; email: string } | null;
  currentBaseline: { id: string; version: number; status: string; snapshotHash: string; approvedAt: string | null; requirementCount: number; exclusionCount: number } | null;
  counts: { total: number; open: number; awaitingClient: number; unapprovedHours: number };
};
type Requirement = { key: string; kind: 'requirement' | 'exclusion'; title: string; description?: string; category?: string; priority?: string; estimatedHours?: number; acceptanceCriteria?: string[] };
type BaselineVersion = { id: string; version: number; status: string; label: string; reason: string; snapshotHash: string; approvedAt: string | null; createdAt: string; isCurrent: boolean };
type BaselineDetail = { version: { _id: string; version: number; status: string; label: string; reason: string; approvedAt: string | null; snapshotHash: string; snapshot: { requirements: Requirement[] } } };
type Client = { id: string; name: string; company: string; contactName: string; contactEmail: string; status: string; projects: number; activeProjects: number };
type RequestRow = { id: string; ref: string; title: string; project: string; status: string; classification: string | null; priority: string; source: string; requesterName: string; createdAt: string };
type DocumentRow = { _id: string; originalName: string; kind: string; sizeBytes: number; createdAt: string; extraction?: { status?: string }; extractionReview?: { reviewedAt?: string | null } };
type AuditRow = { id: string; action: string; actor: { name?: string }; entity: { label?: string; type?: string }; createdAt: string };
type Page<T> = { items: T[]; total: number };
type View = 'Overview' | 'Projects' | 'Change Requests' | 'Scope Baselines' | 'Clients' | 'Reports' | 'Team' | 'Settings' | 'Profile';
type ProjectTab = 'Overview' | 'Scope Baseline' | 'Change Requests' | 'Timeline' | 'Activity';
type ModalKind = 'client' | 'project' | 'request' | 'requirement' | null;

const mainNavigation: { label: View; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Projects', icon: FolderKanban },
  { label: 'Change Requests', icon: SlidersHorizontal },
  { label: 'Scope Baselines', icon: FileCheck2 },
  { label: 'Clients', icon: Users },
  { label: 'Reports', icon: Gauge },
  { label: 'Team', icon: BriefcaseBusiness },
  { label: 'Settings', icon: Settings },
];

function dateLabel(value?: string | null): string {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Not set'
    : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function money(minor: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('');
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [activeOrg, setActiveOrg] = useState<OrgMembership | null>(null);
  const [view, setView] = useState<View>('Overview');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectTab, setProjectTab] = useState<ProjectTab>('Scope Baseline');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [pageError, setPageError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<ModalKind>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectResponse | null>(null);
  const [versions, setVersions] = useState<BaselineVersion[]>([]);
  const [baseline, setBaseline] = useState<BaselineDetail | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [activity, setActivity] = useState<AuditRow[]>([]);
  const [report, setReport] = useState<{ total?: number; rows?: { ref: string; title: string; status: string; hours: number; currency: string }[] } | null>(null);
  const [requestSummary, setRequestSummary] = useState<{ open: number; awaitingClientDecision: number; unapprovedHours: number } | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [needsOrganization, setNeedsOrganization] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const orgId = activeOrg?.organization.id;

  useEffect(() => {
    document.title = me ? 'ScopeShield — project workspace' : 'MindFlow — Plan smarter. Achieve more.';
  }, [me]);

  const refreshProjects = useCallback(async () => {
    if (!orgId) return;
    const result = await api<Page<ProjectSummary>>('/projects?pageSize=100', { orgId });
    setProjects(result.items);
  }, [orgId]);

  const refreshClients = useCallback(async () => {
    if (!orgId) return;
    const result = await api<Page<Client>>('/clients?pageSize=100', { orgId });
    setClients(result.items);
  }, [orgId]);

  const refreshRequests = useCallback(async () => {
    if (!orgId) return;
    const [list, summary] = await Promise.all([
      api<Page<RequestRow>>('/requests?pageSize=100', { orgId }),
      api<{ open: number; awaitingClientDecision: number; unapprovedHours: number }>('/requests/summary', { orgId }),
    ]);
    setRequests(list.items);
    setRequestSummary(summary);
  }, [orgId]);

  const refreshProjectDetail = useCallback(async (id: string) => {
    if (!orgId) return;
    const result = await api<ProjectResponse>(`/projects/${id}`, { orgId });
    setSelectedProject(result);
    const [history, sourceDocs] = await Promise.all([
      api<{ currentBaselineId: string | null; versions: BaselineVersion[] }>(`/projects/${id}/baselines`, { orgId }),
      api<{ documents: DocumentRow[] }>(`/projects/${id}/documents`, { orgId }),
    ]);
    setVersions(history.versions);
    setDocuments(sourceDocs.documents);
    try {
      const timeline = await api<{ items: AuditRow[] }>(`/audit-events?entityType=Project&entityId=${encodeURIComponent(id)}&pageSize=50`, { orgId });
      setActivity(timeline.items);
    } catch (error) {
      setActivity([]);
      setPageError(`Project loaded, but its audit activity is unavailable: ${error instanceof Error ? error.message : 'access denied'}`);
    }
    const current = history.versions.find((version) => version.status === 'draft')
      ?? history.versions.find((version) => version.id === history.currentBaselineId);
    if (current) {
      const detail = await api<BaselineDetail>(`/projects/${id}/baselines/${current.id}`, { orgId });
      setBaseline(detail);
    } else {
      setBaseline(null);
    }
  }, [orgId]);

  useEffect(() => {
    let alive = true;
    document.title = 'MindFlow — Plan smarter. Achieve more.';
    api<Me>('/auth/me')
      .then((result) => {
        if (!alive) return;
        setMe(result);
        setActiveOrg(result.memberships[0] ?? null);
        setNeedsOrganization(result.memberships.length === 0);
      })
      .catch(() => {
        if (alive) setMe(null);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!orgId) return;
    setBusy(true);
    setPageError('');
    Promise.all([refreshProjects(), refreshClients(), refreshRequests()])
      .catch((error: Error) => setPageError(error.message))
      .finally(() => setBusy(false));
  }, [orgId, refreshProjects, refreshClients, refreshRequests]);

  useEffect(() => {
    if (!orgId || !projectId) {
      setSelectedProject(null);
      setBaseline(null);
      return;
    }
    setBusy(true);
    setPageError('');
    refreshProjectDetail(projectId)
      .catch((error: Error) => setPageError(error.message))
      .finally(() => setBusy(false));
  }, [orgId, projectId, refreshProjectDetail]);

  useEffect(() => {
    if (!orgId || !projectId || projectTab !== 'Change Requests') return;
    api<Page<RequestRow>>(`/requests?projectId=${encodeURIComponent(projectId)}&pageSize=100`, { orgId })
      .then((result) => setRequests(result.items))
      .catch((error: Error) => setPageError(error.message));
  }, [orgId, projectId, projectTab]);

  const filteredProjects = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return projects.filter((project) => !needle || `${project.name} ${project.code} ${project.client.name}`.toLowerCase().includes(needle));
  }, [projects, search]);

  const loadIdentity = async () => {
    const result = await api<Me>('/auth/me');
    setMe(result);
    setActiveOrg(result.memberships[0] ?? null);
    setNeedsOrganization(result.memberships.length === 0);
    setProjectId(null);
    return result;
  };

  const handleAuth = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError('');
    setAuthBusy(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    try {
      if (authMode === 'register') {
        await api('/auth/register', {
          method: 'POST',
          body: { name: String(form.get('name') ?? '').trim(), email, password },
          retryAuth: false,
        });
      }
      await api('/auth/login', { method: 'POST', body: { email, password }, retryAuth: false });
      await loadIdentity();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to sign in.');
    } finally {
      setAuthBusy(false);
    }
  };

  const createOrganization = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError('');
    setAuthBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await api('/organizations', {
        method: 'POST',
        body: {
          name: String(form.get('organization') ?? '').trim(),
          currency: String(form.get('currency') ?? 'USD'),
        },
      });
      await loadIdentity();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Unable to create your organization.');
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setMe(null);
      setActiveOrg(null);
      setProjectId(null);
      setView('Overview');
    }
  };

  const runAction = async (action: () => Promise<void>, success?: string) => {
    setPageError('');
    setNotice('');
    try {
      await action();
      if (success) setNotice(success);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'The action could not be completed.');
    }
  };

  const createBaselineVersion = async () => {
    if (!orgId || !projectId) return;
    await runAction(async () => {
      await api(`/projects/${projectId}/baselines`, {
        method: 'POST', orgId, body: { label: 'Scope revision', reason: 'Update to the agreed project scope.', sourceType: 'manual' },
      });
      await refreshProjectDetail(projectId);
    }, 'Draft baseline created. You can now edit its requirements.');
  };

  const addRequirement = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!orgId || !projectId || !baseline) return;
    const form = new FormData(event.currentTarget);
    const version = baseline.version;
    const draft = versions.find((item) => item.version === version.version);
    if (!draft) return;
    await runAction(async () => {
      await api(`/projects/${projectId}/baselines/${draft.id}/requirements`, {
        method: 'POST', orgId, body: {
          kind: String(form.get('kind')),
          title: String(form.get('title')).trim(),
          description: String(form.get('description') ?? '').trim(),
          category: String(form.get('category') ?? 'functional'),
          priority: String(form.get('priority') ?? 'must'),
          estimatedHours: Number(form.get('hours') ?? 0),
        },
      });
      setModal(null);
      await refreshProjectDetail(projectId);
    }, 'Scope item added to the draft baseline.');
  };

  const approveBaseline = async () => {
    if (!orgId || !projectId || !baseline || !me) return;
    const draft = versions.find((item) => item.version === baseline.version.version);
    if (!draft || !window.confirm('Approve and lock this baseline? Approved baselines cannot be edited.')) return;
    await runAction(async () => {
      await api(`/projects/${projectId}/baselines/${draft.id}/approve`, {
        method: 'POST', orgId, body: { method: 'internal', actorName: me.user.name, actorEmail: me.user.email, confirm: true },
      });
      await refreshProjectDetail(projectId);
      await refreshProjects();
    }, 'Baseline approved and locked.');
  };

  const uploadDocument = async (file: File) => {
    if (!orgId || !projectId) return;
    const form = new FormData();
    form.append('file', file);
    form.append('kind', 'requirement_source');
    await runAction(async () => {
      await api(`/projects/${projectId}/documents`, { method: 'POST', orgId, body: form });
      await refreshProjectDetail(projectId);
    }, 'Source document uploaded. Extracted scope suggestions still need review.');
  };

  const submitClient = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!orgId) return;
    const form = new FormData(event.currentTarget);
    await runAction(async () => {
      await api('/clients', {
        method: 'POST', orgId, body: {
          name: String(form.get('name')).trim(),
          company: String(form.get('company') ?? '').trim(),
          contactName: String(form.get('contactName') ?? '').trim(),
          contactEmail: String(form.get('email') ?? '').trim(),
        },
      });
      setModal(null);
      await refreshClients();
    }, 'Client added.');
  };

  const submitProject = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!orgId) return;
    const form = new FormData(event.currentTarget);
    await runAction(async () => {
      const result = await api<{ project: { _id: string } }>('/projects', {
        method: 'POST', orgId, body: {
          name: String(form.get('name')).trim(),
          code: String(form.get('code')).trim().toUpperCase(),
          clientId: String(form.get('clientId')),
          description: String(form.get('description') ?? '').trim(),
          status: 'active',
          contractType: 'fixed_price',
          currency: activeOrg?.organization.currency ?? 'USD',
        },
      });
      setModal(null);
      await refreshProjects();
      setProjectTab('Overview');
      setProjectId(result.project._id);
    }, 'Project created.');
  };

  const submitRequest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!orgId) return;
    const form = new FormData(event.currentTarget);
    const targetProjectId = projectId ?? String(form.get('projectId') ?? '');
    await runAction(async () => {
      await api('/requests', {
        method: 'POST', orgId, body: {
          projectId: targetProjectId,
          title: String(form.get('title')).trim(),
          description: String(form.get('description')).trim(),
          requesterName: String(form.get('requester') ?? me?.user.name ?? ''),
          source: String(form.get('source') ?? 'email'),
          priority: String(form.get('priority') ?? 'normal'),
          submit: true,
        },
      });
      setModal(null);
      await refreshRequests();
      if (projectId) await refreshProjectDetail(projectId);
    }, 'Change request submitted.');
  };

  const setNavigation = (next: View) => {
    setView(next);
    setProjectId(null);
    setMobileSidebarOpen(false);
    setPageError('');
    if (next === 'Reports' && orgId) {
      api<typeof report>('/reports/unapproved-work', { orgId }).then(setReport).catch((error: Error) => setPageError(error.message));
    }
  };

  if (busy && !me) return <div className="boot-screen"><span className="boot-mark"><Brain size={24} /></span><span>Opening MindFlow…</span></div>;
  if (!me) {
    return (
      <AuthScreen
        mode={authMode}
        error={authError}
        busy={authBusy}
        onModeChange={(mode) => { setAuthMode(mode); setAuthError(''); }}
        onSubmit={handleAuth}
      />
    );
  }
  if (needsOrganization) {
    return <OrganizationSetup error={authError} busy={authBusy} onSubmit={createOrganization} onLogout={logout} />;
  }

  const projectDetail = selectedProject;

  return (
    <div className="app-shell">
      {mobileSidebarOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileSidebarOpen(false)} />}
      <aside className={`sidebar ${mobileSidebarOpen ? 'sidebar-open' : ''}`}>
        <a className="product-brand" href="#" onClick={(event) => { event.preventDefault(); setNavigation('Overview'); }}>
          <span className="product-mark"><Shield size={23} fill="currentColor" /></span>
          <span>Scope<span>Shield</span></span>
        </a>
        <nav className="side-navigation" aria-label="Workspace">
          {mainNavigation.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={`side-link ${view === label && !projectId ? 'side-link-active' : ''}`}
              onClick={() => setNavigation(label)}
            >
              <Icon size={17} strokeWidth={2} /><span>{label}</span>
              {label === 'Change Requests' && requestSummary?.open ? <span className="side-count">{requestSummary.open}</span> : null}
            </button>
          ))}
        </nav>
        <button className="org-switcher" onClick={() => setNotice('You are viewing ' + (activeOrg?.organization.name ?? 'your organization'))}>
          <span className="org-icon"><BriefcaseBusiness size={17} /></span>
          <span className="org-text"><strong>{activeOrg?.organization.name}</strong><small>{activeOrg?.organization.plan ?? 'Organization'}</small></span>
          <ChevronDown size={14} />
        </button>
        <button className="profile-switcher" onClick={() => setNavigation('Profile')}>
          <span className="user-avatar">{initials(me.user.name)}</span>
          <span className="profile-text"><strong>{me.user.name}</strong><small>{me.user.jobTitle || me.user.email}</small></span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <button className="sidebar-toggle" aria-label="Open navigation" onClick={() => setMobileSidebarOpen(true)}><Menu size={19} /></button>
          <label className="global-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects, requests, or clients..." /><kbd>⌘ K</kbd></label>
          <div className="topbar-actions">
            <button className="icon-button notification-button" aria-label="Notifications" onClick={() => setView('Change Requests')}><Bell size={17} />{requestSummary?.open ? <i /> : null}</button>
            <button className="icon-button" aria-label="Help" onClick={() => setNotice('ScopeShield keeps approved scope immutable and every change traceable.')}><CircleHelp size={17} /></button>
            <button className="topbar-user" onClick={() => setNavigation('Profile')}><span className="user-avatar">{initials(me.user.name)}</span><span><strong>{me.user.name}</strong><small>{activeOrg?.role}</small></span><ChevronDown size={13} /></button>
          </div>
        </header>

        <main className="page-content">
          {pageError && <div className="alert alert-error" role="alert"><AlertCircle size={17} /><span>{pageError}</span><button onClick={() => setPageError('')} aria-label="Dismiss"><X size={16} /></button></div>}
          {notice && <div className="alert alert-success" role="status"><CheckCircle2 size={17} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss"><X size={16} /></button></div>}
          {busy && <div className="loading-line"><LoaderCircle size={15} /> Syncing workspace…</div>}

          {projectDetail && projectId ? (
            <ProjectWorkspace
              detail={projectDetail}
              projectId={projectId}
              tab={projectTab}
              onTab={setProjectTab}
              versions={versions}
              baseline={baseline}
              documents={documents}
              requests={requests.filter((request) => request.project === projectId)}
              activity={activity}
              onBack={() => setProjectId(null)}
              onCreateVersion={() => void createBaselineVersion()}
              onAddRequirement={() => {
                const current = versions.find((version) => version.id === projectDetail.currentBaseline?.id);
                if (baseline?.version.status === 'draft' || current?.status === 'draft') setModal('requirement');
                else {
                  void runAction(async () => {
                    await api(`/projects/${projectId}/baselines`, {
                      method: 'POST', orgId, body: { label: 'Scope revision', reason: 'Update to the agreed project scope.', sourceType: 'manual' },
                    });
                    await refreshProjectDetail(projectId);
                    setModal('requirement');
                  }, 'Draft baseline created. Add the new scope item for review.');
                }
              }}
              onApprove={() => void approveBaseline()}
              onUpload={() => fileInput.current?.click()}
              onDownload={(id) => {
                const link = document.createElement('a');
                link.href = `${API}/documents/${id}/download`;
                link.download = '';
                link.target = '_blank';
                link.rel = 'noreferrer';
                document.body.appendChild(link);
                link.click();
                link.remove();
              }}
              onRequest={() => setModal('request')}
            />
          ) : (
            <WorkspacePage
              view={view}
              me={me}
              organization={activeOrg?.organization.name ?? ''}
              projects={filteredProjects}
              clients={clients}
              requests={requests}
              summary={requestSummary}
              report={report}
              onOpenProject={(id, tab = 'Scope Baseline') => { setProjectId(id); setProjectTab(tab); }}
              onCreateProject={() => setModal('project')}
              onCreateClient={() => setModal('client')}
              onCreateRequest={() => setModal('request')}
              onLogout={() => void logout()}
            />
          )}

          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void uploadDocument(file);
              event.currentTarget.value = '';
            }}
          />
        </main>
      </div>

      {modal && (
        <Modal title={modal === 'client' ? 'Add a client' : modal === 'project' ? 'Create a project' : modal === 'request' ? 'Submit a change request' : 'Add scope item'} onClose={() => setModal(null)}>
          {modal === 'client' && <ClientForm onSubmit={submitClient} />}
          {modal === 'project' && <ProjectForm clients={clients} onSubmit={submitProject} />}
          {modal === 'request' && <RequestForm projects={projects} projectId={projectId} onSubmit={submitRequest} />}
          {modal === 'requirement' && <RequirementForm onSubmit={addRequirement} />}
        </Modal>
      )}
    </div>
  );
}

function AuthScreen({ mode, error, busy, onModeChange, onSubmit }: {
  mode: 'login' | 'register'; error: string; busy: boolean;
  onModeChange: (mode: 'login' | 'register') => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const [authOpen, setAuthOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [annual, setAnnual] = useState(false);
  const [faq, setFaq] = useState<number | null>(0);
  const [teamSize, setTeamSize] = useState(5);
  const [hours, setHours] = useState(5);
  const savedHours = Math.round(teamSize * (hours * 0.4) * 4);
  const openAuth = (authMode: 'login' | 'register') => {
    onModeChange(authMode);
    setAuthOpen(true);
    setMobileOpen(false);
  };
  const closeAuth = () => {
    setAuthOpen(false);
    onModeChange('login');
  };
  const featureList = [
    { icon: CheckCircle2, color: 'feature-indigo', title: 'Smart Task Management', text: 'Prioritize what matters with AI-powered scheduling that adapts to your day.' },
    { icon: FileText, color: 'feature-purple', title: 'Intelligent Notes', text: 'Capture ideas, find key insights, and keep all your thoughts in one searchable space.' },
    { icon: Brain, color: 'feature-blue', title: 'AI Copilot', text: 'Ask questions, draft replies, and turn long documents into clear action items.' },
    { icon: CalendarDays, color: 'feature-emerald', title: 'Calendar Sync', text: 'Bring your schedule together and make room for focused, uninterrupted work.' },
    { icon: ArrowRight, color: 'feature-amber', title: 'Cross-Device Sync', text: 'Pick up where you left off with your tasks and notes always within reach.' },
  ];
  const faqItems = [
    ['How does the AI assistant help me plan?', 'MindFlow helps you organize priorities, break big goals into manageable tasks, and make a realistic plan for the day. You stay in control of every decision.'],
    ['Is my calendar and personal data secure?', 'Your workspace is private to your account. MindFlow does not sell your personal notes or expose your data to other users.'],
    ['Can I cancel my subscription anytime?', 'You can change your plan or stop using MindFlow whenever you like. There are no long-term commitments to get started.'],
  ];

  return (
    <div className={`mindflow-landing ${darkMode ? 'mindflow-dark' : ''}`}>
      <header className="mindflow-header">
        <a className="mindflow-brand" href="#top" aria-label="MindFlow home"><span className="mindflow-mark"><Brain size={21} fill="currentColor" /></span><span>Mind<span>Flow</span></span></a>
        <button className="mindflow-mobile-toggle" aria-label={mobileOpen ? 'Close menu' : 'Open menu'} onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X size={20} /> : <Menu size={20} />}</button>
        <nav className={`mindflow-nav ${mobileOpen ? 'mindflow-nav-open' : ''}`} aria-label="Main navigation">
          <a href="#features" onClick={() => setMobileOpen(false)}>Features</a><a href="#how-it-works" onClick={() => setMobileOpen(false)}>How it Works</a><a href="#calculator" onClick={() => setMobileOpen(false)}>ROI Calculator</a><a href="#pricing" onClick={() => setMobileOpen(false)}>Pricing</a><a href="#faq" onClick={() => setMobileOpen(false)}>FAQ</a>
          <button className="mindflow-mobile-link" onClick={() => openAuth('login')}>Log In</button><button className="mindflow-mobile-cta" onClick={() => openAuth('register')}>Get Started Free</button>
        </nav>
        <div className="mindflow-header-actions"><button className="theme-toggle" aria-label="Toggle color theme" onClick={() => setDarkMode(!darkMode)}>{darkMode ? '☀' : '☾'}</button><button className="mindflow-login" onClick={() => openAuth('login')}>Log In</button><button className="mindflow-cta small" onClick={() => openAuth('register')}>Get Started Free <ArrowRight size={15} /></button></div>
      </header>

      <main id="top">
        <section className="mindflow-hero">
          <div className="hero-glow glow-one" /><div className="hero-glow glow-two" /><div className="hero-glow glow-three" />
          <div className="mindflow-container hero-container">
            <div className="hero-copy">
              <span className="ai-badge"><i /> <Sparkles size={15} /> Powered by Next-Gen AI 3.0</span>
              <h1>Plan Smarter.<br />Achieve <span>More.</span></h1>
              <p>MindFlow helps you organize your tasks, manage your notes, get AI-powered insights, and stay focused — all in one place.</p>
              <div className="hero-cta-row"><button className="mindflow-cta" onClick={() => openAuth('register')}>Get Started Free <ArrowRight size={18} /></button><button className="mindflow-demo-button" onClick={() => setDemoOpen(true)}><Play size={17} fill="currentColor" /> Watch Demo</button></div>
              <div className="hero-trust"><span><CheckCircle2 size={16} /> No credit card required</span><span><CheckCircle2 size={16} /> Free forever plan</span><span><CheckCircle2 size={16} /> Works on all devices</span></div>
              <div className="social-proof"><div className="avatar-stack"><span>AS</span><span>MK</span><span>JT</span><span>RL</span></div><div><div className="star-rating">★★★★★</div><p>Loved by <strong>10,000+</strong> focused people</p></div></div>
            </div>
          </div>
        </section>

        <section className="mindflow-features section-pad" id="features"><div className="mindflow-container"><div className="section-intro"><span className="section-pill">One space, less switching</span><h2>Everything you need to do your best work</h2><p>Stop switching between five different apps. MindFlow brings your productivity workflow into one beautiful place.</p></div><div className="feature-grid">{featureList.map(({ icon: Icon, color, title, text }) => <article className="mindflow-feature-card" key={title}><span className={`feature-icon ${color}`}><Icon size={22} /></span><h3>{title}</h3><p>{text}</p><a href="#how-it-works">Explore feature <ArrowRight size={14} /></a></article>)}</div></div></section>

        <section className="mindflow-how section-pad" id="how-it-works"><div className="mindflow-container"><div className="section-intro"><span className="section-pill">Simple setup</span><h2>Get started in 3 simple steps</h2><p>Up and running in under 2 minutes. No complex training required.</p></div><div className="steps-grid"><article><span className="step-number">1</span><h3>Sign Up Free</h3><p>Create your account and make a little room for more focused work.</p><div><CheckCircle2 size={14} /> Takes under 30 seconds</div></article><article><span className="step-number">2</span><h3>Set Up Your Space</h3><p>Bring your tasks, notes and daily priorities together in one place.</p><div><CheckCircle2 size={14} /> Easy to make your own</div></article><article><span className="step-number">3</span><h3>Achieve Your Goals</h3><p>Use smart suggestions to plan your day and focus on meaningful work.</p><div><CheckCircle2 size={14} /> Progress at your pace</div></article></div></div></section>

        <section className="mindflow-calculator section-pad" id="calculator"><div className="mindflow-container calculator-layout"><div className="calculator-copy"><span className="calculator-kicker">PRODUCTIVITY CALCULATOR</span><h2>Find a little more time in your day.</h2><p>Make a quick estimate of how many hours your team could get back each month with a more organized workflow.</p><div className="calculator-note"><Clock3 size={16} /> Small improvements add up over time.</div></div><div className="calculator-card"><label><span>Team size</span><strong>{teamSize} {teamSize === 1 ? 'member' : 'members'}</strong></label><input type="range" min="1" max="50" value={teamSize} onChange={(event) => setTeamSize(Number(event.target.value))} aria-label="Team size" /><label><span>Hours spent on routine tasks per week</span><strong>{hours} hours</strong></label><input type="range" min="1" max="20" value={hours} onChange={(event) => setHours(Number(event.target.value))} aria-label="Routine hours per week" /><div className="savings-result"><span><small>ESTIMATED TIME SAVED / MONTH</small><strong>{savedHours} hours</strong></span><span><small>MORE ROOM FOR WHAT MATTERS</small><strong>{Math.round(savedHours / 8)} workdays</strong></span></div><p>Illustrative estimate only, based on a potential 40% reduction in routine work.</p></div></div></section>

        <section className="mindflow-pricing section-pad" id="pricing"><div className="mindflow-container"><div className="section-intro"><span className="section-pill">Simple, flexible pricing</span><h2>A plan for your kind of focus</h2><p>Start for free, and choose what works for you as your needs grow.</p><div className="billing-toggle"><span className={!annual ? 'billing-selected' : ''}>Monthly</span><button role="switch" aria-checked={annual} aria-label="Toggle annual billing" onClick={() => setAnnual(!annual)}><i className={annual ? 'billing-on' : ''} /></button><span className={annual ? 'billing-selected' : ''}>Yearly <em>Save 20%</em></span></div></div><div className="pricing-grid"><article className="pricing-card"><span className="plan-icon"><Sparkles size={18} /></span><h3>Starter</h3><p>For personal projects and everyday planning.</p><div className="plan-price"><strong>$0</strong><span>/ forever</span></div><ul><li><Check size={15} /> Smart task management</li><li><Check size={15} /> Notes and personal workspace</li><li><Check size={15} /> Helpful AI suggestions</li><li><Check size={15} /> Access across your devices</li></ul><button className="pricing-button" onClick={() => openAuth('register')}>Get started free <ArrowRight size={15} /></button></article><article className="pricing-card pricing-featured"><span className="popular-label">MOST POPULAR</span><span className="plan-icon"><Brain size={18} /></span><h3>Pro Focus</h3><p>For power users and busy professionals.</p><div className="plan-price"><strong>${annual ? '9.60' : '12'}</strong><span>/ month</span></div><ul><li><Check size={15} /> Unlimited workspaces</li><li><Check size={15} /> More AI assistant prompts</li><li><Check size={15} /> Calendar integrations</li><li><Check size={15} /> Advanced productivity insights</li></ul><button className="pricing-button pricing-primary" onClick={() => openAuth('register')}>Start your free trial <ArrowRight size={15} /></button></article><article className="pricing-card"><span className="plan-icon"><Users size={18} /></span><h3>Team Business</h3><p>For teams that get more done together.</p><div className="plan-price"><strong>${annual ? '23.20' : '29'}</strong><span>/ user / month</span></div><ul><li><Check size={15} /> Everything in Pro Focus</li><li><Check size={15} /> Shared team workspace</li><li><Check size={15} /> Admin controls and permissions</li><li><Check size={15} /> Priority team support</li></ul><button className="pricing-button" onClick={() => openAuth('register')}>Get started <ArrowRight size={15} /></button></article></div></div></section>

        <section className="mindflow-faq section-pad" id="faq"><div className="mindflow-container faq-container"><div className="section-intro"><span className="section-pill">Good to know</span><h2>Frequently asked questions</h2><p>Have questions? We&apos;re here to help.</p></div><div className="faq-list">{faqItems.map(([question, answer], index) => <article className={`faq-item ${faq === index ? 'faq-open' : ''}`} key={question}><button aria-expanded={faq === index} onClick={() => setFaq(faq === index ? null : index)}><span>{question}</span><ChevronDown size={17} /></button>{faq === index && <p>{answer}</p>}</article>)}</div></div></section>
      </main>

      <footer className="mindflow-footer"><div className="mindflow-container footer-top"><div className="footer-about"><a className="mindflow-brand footer-brand" href="#top"><span className="mindflow-mark"><Brain size={19} fill="currentColor" /></span><span>Mind<span>Flow</span></span></a><p>Your AI productivity partner for clearer plans, calmer days, and more room for the work you love.</p></div><div><h3>Product</h3><a href="#features">Features</a><a href="#pricing">Pricing</a><a href="#how-it-works">How it works</a></div><div><h3>Resources</h3><a href="#faq">FAQ</a><a href="#calculator">Productivity calculator</a><button onClick={() => setDemoOpen(true)}>Watch demo</button></div><div><h3>Get started</h3><button onClick={() => openAuth('login')}>Log in</button><button onClick={() => openAuth('register')}>Create your free account</button><a href="mailto:hello@mindflow.app">Contact</a></div></div><div className="mindflow-container footer-bottom"><span>© 2026 MindFlow. Make room for your best work.</span><span><a href="#faq">Privacy</a><a href="#faq">Terms</a><button onClick={() => setDarkMode(!darkMode)}>Appearance</button></span></div></footer>

      {authOpen && <div className="mindflow-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeAuth()}><section className="mindflow-auth-modal" role="dialog" aria-modal="true" aria-labelledby="mindflow-auth-title"><button className="mindflow-modal-close" onClick={closeAuth} aria-label="Close sign-in"><X size={19} /></button><span className="mindflow-modal-mark"><Brain size={22} fill="currentColor" /></span><p className="section-pill">{mode === 'login' ? 'Welcome back' : 'Your next chapter starts here'}</p><h2 id="mindflow-auth-title">{mode === 'login' ? 'Sign in to MindFlow' : 'Create your free account'}</h2><p className="auth-modal-copy">{mode === 'login' ? 'Pick up where you left off and get back into your flow.' : 'A calmer, more organized day is just a few details away.'}</p>{error && <div className="form-error"><AlertCircle size={15} />{error}</div>}<form className="form-stack" onSubmit={onSubmit}>{mode === 'register' && <Field label="Full name" name="name" placeholder="Your name" required minLength={2} />}<Field label="Email address" name="email" type="email" placeholder="you@example.com" required /><Field label="Password" name="password" type="password" placeholder={mode === 'register' ? 'At least 10 characters' : 'Your password'} required minLength={mode === 'register' ? 10 : 1} />{mode === 'register' && <small className="password-hint">Use upper and lower case letters and at least one number.</small>}<button className="mindflow-cta auth-modal-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : null}{mode === 'login' ? 'Log In' : 'Get Started Free'}<ArrowRight size={16} /></button></form><p className="auth-switch">{mode === 'login' ? 'New to MindFlow?' : 'Already have an account?'} <button onClick={() => onModeChange(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create an account' : 'Log in'}</button></p><div className="mindflow-modal-foot"><LockKeyhole size={13} />Your account is protected with secure sign-in</div></section></div>}
      {demoOpen && <div className="mindflow-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDemoOpen(false)}><section className="mindflow-demo-modal" role="dialog" aria-modal="true" aria-labelledby="demo-title"><button className="mindflow-modal-close" onClick={() => setDemoOpen(false)} aria-label="Close demo"><X size={19} /></button><span className="demo-large-icon"><Play size={24} fill="currentColor" /></span><p className="section-pill">A day in the flow</p><h2 id="demo-title">Your plans, in one peaceful place.</h2><p>Bring tasks and notes together, then use MindFlow&apos;s suggestions to make a thoughtful plan for your day. You decide what matters, and MindFlow helps you stay on track.</p><div className="demo-modal-points"><span><CheckCircle2 size={16} /> See priorities at a glance</span><span><CheckCircle2 size={16} /> Make space for focused work</span><span><CheckCircle2 size={16} /> Celebrate the progress you make</span></div><button className="mindflow-cta" onClick={() => { setDemoOpen(false); openAuth('register'); }}>Get started free <ArrowRight size={16} /></button></section></div>}
    </div>
  );
}

function OrganizationSetup({ error, busy, onSubmit, onLogout }: {
  error: string; busy: boolean; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void; onLogout: () => void;
}) {
  return (
    <main className="auth-screen onboarding-screen">
      <section className="auth-card">
        <a className="product-brand auth-brand" href="#"><span className="product-mark"><Shield size={23} fill="currentColor" /></span><span>Scope<span>Shield</span></span></a>
        <div className="auth-heading"><span className="auth-icon"><BriefcaseBusiness size={22} /></span><p className="eyebrow">One quick step</p><h1>Create your workspace</h1><p>Your projects, clients, and scope records will live in this organization.</p></div>
        {error && <div className="form-error"><AlertCircle size={16} />{error}</div>}
        <form className="form-stack" onSubmit={onSubmit}>
          <Field label="Organization name" name="organization" placeholder="e.g. Summit Web Studio" required minLength={2} />
          <label className="field-label">Default currency<select name="currency" defaultValue="USD"><option value="USD">USD — US Dollar</option><option value="EUR">EUR — Euro</option><option value="GBP">GBP — Pound Sterling</option><option value="NPR">NPR — Nepalese Rupee</option><option value="INR">INR — Indian Rupee</option></select></label>
          <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : null}Create workspace<ArrowRight size={16} /></button>
        </form>
        <button className="text-button" onClick={onLogout}>Sign out</button>
      </section>
      <aside className="auth-aside"><div className="auth-aside-mark"><Shield size={26} fill="currentColor" /></div><p className="eyebrow">Your work stays yours</p><h2>A clear record for every agreement.</h2><p>ScopeShield keeps your approved baseline immutable and gives your team one place to see what changed, who decided, and why.</p></aside>
    </main>
  );
}

function WorkspacePage({ view, me, organization, projects, clients, requests, summary, report, onOpenProject, onCreateProject, onCreateClient, onCreateRequest, onLogout }: {
  view: View; me: Me; organization: string; projects: ProjectSummary[]; clients: Client[]; requests: RequestRow[];
  summary: { open: number; awaitingClientDecision: number; unapprovedHours: number } | null;
  report: { total?: number; rows?: { ref: string; title: string; status: string; hours: number; currency: string }[] } | null;
  onOpenProject: (id: string, tab?: ProjectTab) => void; onCreateProject: () => void; onCreateClient: () => void; onCreateRequest: () => void; onLogout: () => void;
}) {
  const pageTitle = view === 'Overview' ? `Good ${new Date().getHours() < 12 ? 'morning' : 'afternoon'}, ${me.user.name.split(' ')[0]}` : view;
  return (
    <div className="workspace-page">
      <div className="page-heading">
        <div><p className="breadcrumbs">{organization}<ChevronRight size={13} /> Workspace</p><h1>{pageTitle}</h1><p className="page-subtitle">{view === 'Overview' ? 'Here is the current picture across your projects and client work.' : view === 'Profile' ? 'Your account details and sign-in information.' : `Manage ${view.toLowerCase()} for your organization.`}</p></div>
        <div className="heading-actions">
          {(view === 'Overview' || view === 'Projects') && <button className="outline-button" onClick={onCreateProject}><FilePlus2 size={16} /> New project</button>}
          {view === 'Clients' && <button className="primary-button" onClick={onCreateClient}><Plus size={16} /> Add client</button>}
          {view === 'Change Requests' && <button className="primary-button" onClick={onCreateRequest}><Plus size={16} /> New request</button>}
        </div>
      </div>
      {view === 'Overview' && (
        <>
          <div className="metric-grid">
            <Metric icon={FolderKanban} label="Active projects" value={String(projects.filter((project) => project.status === 'active').length)} note={`${projects.length} total projects`} />
            <Metric icon={SlidersHorizontal} label="Open change requests" value={String(summary?.open ?? 0)} note={`${summary?.awaitingClientDecision ?? 0} awaiting client decision`} tone="amber" />
            <Metric icon={Clock3} label="Unapproved work" value={`${(summary?.unapprovedHours ?? 0).toFixed(1)}h`} note="Potential exposure, not approved revenue" tone="rose" />
            <Metric icon={ShieldCheck} label="Scope baselines" value={String(projects.filter((project) => project.currentBaseline).length)} note="Approved and versioned" tone="green" />
          </div>
          <section className="surface-card">
            <SectionHeader title="Projects" subtitle="Your recent project work" action={<button className="inline-link" onClick={() => onOpenProject(projects[0]?.id ?? '')}>View all projects <ArrowRight size={14} /></button>} />
            <ProjectsTable projects={projects.slice(0, 6)} onOpen={onOpenProject} />
          </section>
          <section className="lower-grid">
            <div className="surface-card"><SectionHeader title="Change requests" subtitle="Requests that need attention" action={<button className="inline-link" onClick={onCreateRequest}>Add request <Plus size={14} /></button>} /><RequestList requests={requests.slice(0, 5)} /></div>
            <div className="surface-card integrity-summary"><div className="summary-icon"><ShieldCheck size={20} /></div><div><h3>Your scope, protected</h3><p>Every approved baseline is immutable. New scope gets a new version, and every decision is recorded.</p></div><div className="integrity-stats"><span><strong>{projects.reduce((sum, project) => sum + project.baselineVersionCount, 0)}</strong> baseline versions</span><span><strong>{requests.length}</strong> tracked requests</span></div></div>
          </section>
        </>
      )}
      {view === 'Projects' && <section className="surface-card"><SectionHeader title="All projects" subtitle={`${projects.length} projects in your organization`} /><ProjectsTable projects={projects} onOpen={onOpenProject} /></section>}
      {view === 'Scope Baselines' && <section className="surface-card"><SectionHeader title="Scope baselines" subtitle="Immutable snapshots of what was agreed" /><ProjectsTable projects={projects.filter((project) => project.currentBaseline)} onOpen={(id) => onOpenProject(id, 'Scope Baseline')} emptyText="No approved baselines yet. Open a project to draft its agreed scope." /></section>}
      {view === 'Change Requests' && <section className="surface-card"><SectionHeader title="Change request inbox" subtitle={`${summary?.open ?? 0} requests need review`} /><RequestList requests={requests} /></section>}
      {view === 'Clients' && <section className="surface-card"><SectionHeader title="Clients" subtitle={`${clients.length} client records`} action={<button className="inline-link" onClick={onCreateClient}><Plus size={14} /> Add client</button>} /><ClientTable clients={clients} /></section>}
      {view === 'Reports' && <section className="surface-card"><SectionHeader title="Unapproved work" subtitle="Potential scope exposure. This is not approved revenue." /><div className="report-highlight"><span><Clock3 size={20} /></span><div><strong>{report?.total ?? 0} open items</strong><p>Work that may be outside the approved scope needs a human decision.</p></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Request</th><th>Title</th><th>Status</th><th>Hours</th></tr></thead><tbody>{(report?.rows ?? []).map((row) => <tr key={row.ref}><td className="code-cell">{row.ref}</td><td>{row.title}</td><td><StatusBadge status={row.status} /></td><td>{row.hours}h</td></tr>)}</tbody></table>{!report?.rows?.length && <EmptyState title="No unapproved work reported" text="When a request is submitted, potential scope exposure will appear here." />}</div></section>}
      {view === 'Team' && <section className="surface-card"><SectionHeader title="Team members" subtitle="People with access to this organization" /><div className="team-card"><span className="user-avatar">{initials(me.user.name)}</span><div><strong>{me.user.name}</strong><small>{me.user.email}</small></div><StatusBadge status={me.memberships[0]?.role ?? 'member'} /><span className="team-you">You</span></div><div className="team-note"><Users size={17} /> Invite and manage team roles from your organization settings.</div></section>}
      {view === 'Settings' && <section className="surface-card settings-card"><SectionHeader title="Organization settings" subtitle="Workspace identity and current access" /><div className="settings-row"><span>Organization</span><strong>{organization}</strong></div><div className="settings-row"><span>Signed in as</span><strong>{me.user.name} · {me.user.email}</strong></div><div className="settings-row"><span>Role</span><StatusBadge status={me.memberships[0]?.role ?? 'member'} /></div><div className="settings-row"><span>Workspace plan</span><strong>{me.memberships[0]?.organization.plan ?? 'Standard'}</strong></div></section>}
      {view === 'Profile' && <section className="surface-card settings-card"><SectionHeader title="Your profile" subtitle="Personal account information" /><div className="team-card"><span className="user-avatar">{initials(me.user.name)}</span><div><strong>{me.user.name}</strong><small>{me.user.email}</small></div><span className="team-you">You</span></div><div className="settings-row"><span>Job title</span><strong>{me.user.jobTitle || 'Not set'}</strong></div><div className="settings-row"><span>Organization role</span><StatusBadge status={me.memberships[0]?.role ?? 'member'} /></div><div className="heading-actions"><button className="outline-button" onClick={onLogout}><LogOut size={15} /> Sign out</button></div></section>}
    </div>
  );
}

function ProjectWorkspace({ detail, projectId, tab, onTab, versions, baseline, documents, requests, activity, onBack, onCreateVersion, onAddRequirement, onApprove, onUpload, onDownload, onRequest }: {
  detail: ProjectResponse; projectId: string; tab: ProjectTab; onTab: (tab: ProjectTab) => void; versions: BaselineVersion[];
  baseline: BaselineDetail | null; documents: DocumentRow[]; requests: RequestRow[]; activity: AuditRow[];
  onBack: () => void; onCreateVersion: () => void; onAddRequirement: () => void; onApprove: () => void; onUpload: () => void;
  onDownload: (id: string) => void; onRequest: () => void;
}) {
  const project = detail.project;
  const requirements = baseline?.version.snapshot.requirements ?? [];
  const included = requirements.filter((item) => item.kind === 'requirement');
  const exclusions = requirements.filter((item) => item.kind === 'exclusion');
  const activeDraft = baseline?.version.status === 'draft';

  return (
    <div className="project-page">
      <div className="project-breadcrumb"><button onClick={onBack}><ArrowLeft size={15} /> Projects</button><ChevronRight size={13} /><span>{project.name}</span></div>
      <div className="project-heading">
        <div className="project-title-block"><span className="project-icon"><BriefcaseBusiness size={23} /></span><div><h1>{project.name}</h1><p>{project.description || 'Project scope and delivery workspace'}</p></div></div>
        <div className="project-actions"><button className="outline-button" onClick={onCreateVersion}><FilePlus2 size={16} /> Create new version</button><button className="primary-button" onClick={onAddRequirement}><Plus size={16} /> Add requirement</button></div>
      </div>
      <div className="project-meta">
        <StatusBadge status={project.status} />
        <span><Users size={15} /><small>Client</small><strong>{detail.client?.company || detail.client?.name || 'Client not set'}</strong></span>
        <span><Users size={15} /><small>Project manager</small><strong>{detail.manager?.name || 'Not assigned'}</strong></span>
        <span><CalendarDays size={15} /><small>Due date</small><strong>{dateLabel(project.targetEndDate)}</strong></span>
      </div>
      <div className="project-tabs" role="tablist" aria-label="Project details">
        {(['Overview', 'Scope Baseline', 'Change Requests', 'Timeline', 'Activity'] as ProjectTab[]).map((item) => <button key={item} className={tab === item ? 'project-tab active' : 'project-tab'} onClick={() => onTab(item)} role="tab" aria-selected={tab === item}>{item}</button>)}
      </div>

      {tab === 'Scope Baseline' && (
        <div className="baseline-layout">
          <div className="baseline-main-column">
            <section className="surface-card baseline-table-card">
              <div className="baseline-title-row"><div className="section-icon"><FileText size={19} /></div><div><div className="title-with-badge"><h2>{baseline ? `Approved scope — Baseline v${baseline.version.version}` : 'Scope baseline'}</h2>{baseline?.version.status === 'approved' ? <span className="immutable-tag"><LockKeyhole size={12} /> Locked (Immutable)</span> : <StatusBadge status={baseline?.version.status ?? 'not started'} />}</div><p>{baseline?.version.approvedAt ? `Approved on ${dateLabel(baseline.version.approvedAt)}${detail.client?.contactName ? ` by ${detail.client.contactName}` : ''}` : baseline?.version.status === 'draft' ? 'Draft baseline · Changes are not approved until you approve this version.' : 'No baseline has been approved for this project yet.'}</p></div></div>
              {activeDraft && <div className="draft-callout"><AlertCircle size={16} /><span>This is a draft. Review each item before approving the baseline.</span><button className="primary-button compact-button" onClick={onApprove}><Check size={14} /> Approve baseline</button></div>}
              <h3 className="subsection-heading">Included requirements <span>{included.length}</span></h3>
              <RequirementTable items={included} emptyText="No included requirements. Add scope items to define the work." />
              <p className="table-footnote">{included.length} requirement{included.length === 1 ? '' : 's'} included in this baseline</p>
            </section>
            <section className="surface-card exclusion-card">
              <div className="baseline-title-row"><span className="exclusion-icon"><XCircle size={21} /></span><div><h2>Explicit exclusions <span className="info-dot" title="Items explicitly not included in this scope">i</span></h2></div></div>
              <RequirementTable items={exclusions} exclusions emptyText="No exclusions have been defined for this baseline." />
              <p className="table-footnote">{exclusions.length} exclusion{exclusions.length === 1 ? '' : 's'} defined</p>
            </section>
          </div>
          <div className="baseline-side-column">
            <section className="surface-card integrity-card">
              <div className="side-card-title"><span className="side-icon shield-icon"><ShieldCheck size={19} /></span><h2>Baseline integrity</h2></div>
              <div className={baseline?.version.status === 'approved' ? 'integrity-callout' : 'integrity-callout integrity-draft'}><ShieldCheck size={15} /><div><strong>{baseline?.version.status === 'approved' ? 'Immutable' : baseline?.version.status === 'draft' ? 'Draft in progress' : 'No approved baseline'}</strong><p>{baseline?.version.status === 'approved' ? 'This version is locked and cannot be modified.' : 'Approve a reviewed baseline to lock the agreed scope.'}</p></div></div>
              <h3 className="subsection-heading">Version history</h3>
              {versions.length ? <div className="version-list">{versions.slice(0, 4).map((version) => <div className="version-entry" key={version.id}><span className={`version-dot ${version.isCurrent ? 'current' : ''}`} /><div><strong>v{version.version} {version.isCurrent ? <span>(Current)</span> : null}</strong><small>{version.label}</small><small>{version.approvedAt ? `Approved · ${dateLabel(version.approvedAt)}` : version.status}</small></div><StatusBadge status={version.status} /></div>)}</div> : <p className="empty-inline">Version history appears after the first scope baseline is created.</p>}
              <button className="wide-outline-button" onClick={() => onTab('Timeline')}><FileCheck2 size={14} /> View version history</button>
            </section>
            <section className="surface-card sources-card">
              <div className="side-card-title"><span className="side-icon"><FileText size={18} /></span><h2>Source documents</h2><button className="icon-button small-icon" aria-label="Upload source document" onClick={onUpload}><Plus size={16} /></button></div>
              {documents.length ? <div className="document-list">{documents.map((document) => <div className="document-entry" key={document._id}><span className="document-icon"><FileText size={16} /></span><div className="document-info"><strong>{document.originalName}</strong><small>{formatBytes(document.sizeBytes)} · {dateLabel(document.createdAt)}</small></div><StatusBadge status={document.extractionReview?.reviewedAt ? 'Reviewed' : 'Uploaded'} /><button className="icon-button small-icon" aria-label={`Download ${document.originalName}`} onClick={() => onDownload(document._id)}><ArrowDownToLine size={15} /></button><button className="icon-button small-icon" aria-label="More document actions" title={document.kind}><MoreVertical size={15} /></button></div>)}</div> : <div className="source-empty"><p>No source documents attached yet.</p><button className="inline-link" onClick={onUpload}><Plus size={14} /> Upload source file</button></div>}
            </section>
            <section className="next-steps-card"><span><AlertCircle size={17} /></span><div><strong>Next steps</strong><p>{baseline?.version.status === 'approved' ? 'The current scope is approved and locked. Create a new version only when the scope needs a documented change.' : 'Upload the signed proposal or requirements brief, then review and approve the scope baseline.'}</p></div></section>
          </div>
        </div>
      )}
      {tab === 'Overview' && <div className="project-overview-grid"><section className="surface-card"><SectionHeader title="Project overview" subtitle="At-a-glance delivery and scope" /><div className="project-facts"><Fact label="Client" value={detail.client?.company || detail.client?.name || 'Not set'} /><Fact label="Project manager" value={detail.manager?.name || 'Not assigned'} /><Fact label="Due date" value={dateLabel(project.targetEndDate)} /><Fact label="Contract value" value={money(project.contractAmountMinor, project.currency)} /><Fact label="Estimated effort" value={`${project.estimatedHours} hours`} /><Fact label="Current baseline" value={detail.currentBaseline ? `v${detail.currentBaseline.version} · ${detail.currentBaseline.status}` : 'Not created'} /></div></section><section className="surface-card"><SectionHeader title="Scope at a glance" subtitle="Based on the current approved version" /><div className="scope-glance"><span><CheckCircle2 size={18} />{detail.currentBaseline?.requirementCount ?? 0}<small>Included items</small></span><span><XCircle size={18} />{detail.currentBaseline?.exclusionCount ?? 0}<small>Explicit exclusions</small></span><span><SlidersHorizontal size={18} />{detail.counts.open}<small>Open requests</small></span></div><button className="wide-outline-button" onClick={() => onTab('Scope Baseline')}>Open scope baseline <ArrowRight size={14} /></button></section><section className="surface-card"><SectionHeader title="Recent activity" subtitle="Latest project events" /><ActivityList rows={activity.slice(0, 4)} /></section><section className="surface-card"><SectionHeader title="Change requests" subtitle={`${detail.counts.total} total requests`} action={<button className="inline-link" onClick={onRequest}>New request <Plus size={14} /></button>} /><RequestList requests={requests.slice(0, 4)} emptyText="No change requests on this project." /></section></div>}
      {tab === 'Change Requests' && <section className="surface-card"><SectionHeader title="Change requests" subtitle="Assess new work against the agreed baseline" action={<button className="primary-button" onClick={onRequest}><Plus size={15} /> New request</button>} /><RequestList requests={requests} emptyText="No requests have been submitted for this project." /></section>}
      {tab === 'Timeline' && <section className="surface-card"><SectionHeader title="Baseline version history" subtitle="A versioned history of what was agreed" /><div className="timeline-list">{versions.map((version) => <article className="timeline-entry" key={version.id}><span className={`timeline-marker ${version.isCurrent ? 'current' : ''}`} /><div><div className="timeline-heading"><h3>Baseline v{version.version} {version.isCurrent ? <em>Current</em> : null}</h3><StatusBadge status={version.status} /></div><p>{version.label}{version.reason ? ` · ${version.reason}` : ''}</p><small>{version.approvedAt ? `Approved ${dateLabel(version.approvedAt)}` : `Created ${dateLabel(version.createdAt)}`}</small></div></article>)}</div>{!versions.length && <EmptyState title="No baseline versions" text="Create the first scope baseline to start a traceable history." />}</section>}
      {tab === 'Activity' && <section className="surface-card"><SectionHeader title="Project activity" subtitle="Append-only audit events for this project" /><ActivityList rows={activity} emptyText="No audit events have been recorded for this project yet." /></section>}
      <p className="project-id">Project ID · {projectId}</p>
    </div>
  );
}

function RequirementTable({ items, exclusions = false, emptyText }: { items: Requirement[]; exclusions?: boolean; emptyText: string }) {
  if (!items.length) return <div className="table-empty">{emptyText}</div>;
  return (
    <div className="data-table-wrap">
      <table className="data-table requirement-data-table"><thead><tr><th>{exclusions ? 'ID' : ''}</th><th>{exclusions ? 'Exclusion' : 'Requirement'}</th>{!exclusions && <><th>Category</th><th>Est. effort</th><th>Priority</th></>}</tr></thead>
        <tbody>{items.map((item) => <tr key={item.key}><td className="requirement-key">{exclusions ? <XCircle size={13} /> : <CheckCircle2 size={13} />}<span>{item.key}</span></td><td><strong>{item.title}</strong>{item.description ? <small>{item.description}</small> : null}</td>{!exclusions && <><td><span className="category-pill">{item.category || 'General'}</span></td><td>{item.estimatedHours ? `${item.estimatedHours}h` : '—'}</td><td><span className={`priority-pill priority-${item.priority ?? 'normal'}`}>{item.priority ?? 'Normal'}</span></td></>}</tr>)}</tbody>
      </table>
    </div>
  );
}

function ProjectsTable({ projects, onOpen, emptyText = 'Create a project to start tracking scope and changes.' }: { projects: ProjectSummary[]; onOpen: (id: string, tab?: ProjectTab) => void; emptyText?: string }) {
  if (!projects.length) return <EmptyState title="No projects found" text={emptyText} />;
  return <div className="data-table-wrap"><table className="data-table projects-table"><thead><tr><th>Project</th><th>Client</th><th>Status</th><th>Baseline</th><th>Due date</th><th>Open requests</th><th /></tr></thead><tbody>{projects.map((project) => <tr key={project.id} onClick={() => onOpen(project.id)} className="clickable-row"><td><div className="project-cell"><span className="project-cell-icon"><BriefcaseBusiness size={16} /></span><span><strong>{project.name}</strong><small>{project.code}</small></span></div></td><td>{project.client.name}</td><td><StatusBadge status={project.status} /></td><td>{project.currentBaseline ? `v${project.baselineVersionCount}` : <span className="muted">Not set</span>}</td><td>{dateLabel(project.targetEndDate)}</td><td><span className={project.requests.open ? 'request-count' : 'muted'}>{project.requests.open}</span></td><td><ChevronRight size={16} className="row-chevron" /></td></tr>)}</tbody></table></div>;
}

function RequestList({ requests, emptyText = 'No change requests need attention.' }: { requests: RequestRow[]; emptyText?: string }) {
  if (!requests.length) return <EmptyState title="Nothing to review" text={emptyText} compact />;
  return <div className="request-list">{requests.map((request) => <div className="request-list-row" key={request.id}><span className={`request-dot priority-dot-${request.priority}`} /><div className="request-list-copy"><strong>{request.title}</strong><small>{request.ref} · {request.requesterName || 'Team request'} · {dateLabel(request.createdAt)}</small></div><StatusBadge status={request.status} />{request.classification && <span className="category-pill">{request.classification.replaceAll('_', ' ')}</span>}</div>)}</div>;
}

function ClientTable({ clients }: { clients: Client[] }) {
  if (!clients.length) return <EmptyState title="No clients yet" text="Add a client to connect projects and keep their approval history together." />;
  return <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Client</th><th>Contact</th><th>Email</th><th>Projects</th><th>Status</th></tr></thead><tbody>{clients.map((client) => <tr key={client.id}><td><div className="project-cell"><span className="client-avatar">{initials(client.name)}</span><span><strong>{client.name}</strong><small>{client.company}</small></span></div></td><td>{client.contactName || '—'}</td><td>{client.contactEmail || '—'}</td><td>{client.projects}</td><td><StatusBadge status={client.status} /></td></tr>)}</tbody></table></div>;
}

function ActivityList({ rows, emptyText = 'No recent activity.' }: { rows: AuditRow[]; emptyText?: string }) {
  if (!rows.length) return <EmptyState title="No activity yet" text={emptyText} compact />;
  return <div className="activity-list">{rows.map((row) => <div className="activity-row" key={row.id}><span className="activity-icon"><Activity size={15} /></span><div><strong>{row.entity?.label || row.action.replaceAll('.', ' ')}</strong><small>{row.action.replaceAll('.', ' ')} · {row.actor?.name || 'Team member'}</small></div><time>{dateLabel(row.createdAt)}</time></div>)}</div>;
}

function Metric({ icon: Icon, label, value, note, tone = 'blue' }: { icon: typeof FolderKanban; label: string; value: string; note: string; tone?: string }) {
  return <article className="metric-card"><span className={`metric-icon metric-${tone}`}><Icon size={19} /></span><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><small>{note}</small></article>;
}

function SectionHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) {
  return <div className="section-header"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>;
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
  return <span className={`status-badge status-${normalized}`}>{status.replaceAll('_', ' ')}</span>;
}

function EmptyState({ title, text, compact = false }: { title: string; text: string; compact?: boolean }) {
  return <div className={compact ? 'empty-state empty-compact' : 'empty-state'}><span><BookOpenCheck size={20} /></span><strong>{title}</strong><p>{text}</p></div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="fact-item"><small>{label}</small><strong>{value}</strong></div>;
}

function Field({ label, name, placeholder, type = 'text', required = false, minLength }: {
  label: string; name: string; placeholder?: string; type?: string; required?: boolean; minLength?: number;
}) {
  return <label className="field-label">{label}<input name={name} type={type} placeholder={placeholder} required={required} minLength={minLength} /></label>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><div><p className="eyebrow">ScopeShield workspace</p><h2 id="modal-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{children}</section></div>;
}

function FormActions({ onCancel }: { onCancel: () => void }) {
  return <div className="form-actions"><button type="button" className="outline-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-button">Save <ArrowRight size={15} /></button></div>;
}

function ClientForm({ onSubmit }: { onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const close = () => document.querySelector<HTMLButtonElement>('.modal-header .icon-button')?.click();
  return <form className="form-stack modal-form" onSubmit={onSubmit}><Field label="Client name" name="name" placeholder="Client or contact name" required minLength={2} /><Field label="Company" name="company" placeholder="Company name" /><Field label="Contact person" name="contactName" placeholder="Primary contact" /><Field label="Contact email" name="email" type="email" placeholder="contact@company.com" /><FormActions onCancel={close} /></form>;
}

function ProjectForm({ clients, onSubmit }: { clients: Client[]; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const close = () => document.querySelector<HTMLButtonElement>('.modal-header .icon-button')?.click();
  return <form className="form-stack modal-form" onSubmit={onSubmit}><Field label="Project name" name="name" placeholder="e.g. Corporate website redesign" required minLength={2} /><Field label="Project code" name="code" placeholder="e.g. WEB-01" required minLength={2} /><label className="field-label">Client<select name="clientId" required defaultValue=""><option value="" disabled>Select a client</option>{clients.map((client) => <option value={client.id} key={client.id}>{client.company || client.name}</option>)}</select>{!clients.length && <small className="field-help">Add a client before creating a project.</small>}</label><label className="field-label">Description<textarea name="description" rows={3} placeholder="What is this project delivering?" /></label><FormActions onCancel={close} /></form>;
}

function RequestForm({ projects, projectId, onSubmit }: { projects: ProjectSummary[]; projectId: string | null; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const close = () => document.querySelector<HTMLButtonElement>('.modal-header .icon-button')?.click();
  return <form className="form-stack modal-form" onSubmit={onSubmit}>{!projectId && <label className="field-label">Project<select name="projectId" required defaultValue=""><option value="" disabled>Select a project</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>}<Field label="Request title" name="title" placeholder="What is the client asking for?" required minLength={4} /><label className="field-label">Request details<textarea name="description" rows={4} required minLength={10} placeholder="Describe the requested change and any context." /></label><div className="form-grid-two"><label className="field-label">Source<select name="source" defaultValue="email"><option value="email">Email</option><option value="client_portal">Client portal</option><option value="meeting">Meeting</option><option value="call">Call</option><option value="chat">Chat</option><option value="internal">Internal</option></select></label><label className="field-label">Priority<select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label></div><Field label="Requester" name="requester" placeholder="Client or team member" /><p className="form-note"><ShieldCheck size={15} /> Requests are reviewed against scope; no work is approved automatically.</p><FormActions onCancel={close} /></form>;
}

function RequirementForm({ onSubmit }: { onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const close = () => document.querySelector<HTMLButtonElement>('.modal-header .icon-button')?.click();
  return <form className="form-stack modal-form" onSubmit={onSubmit}><div className="form-grid-two"><label className="field-label">Scope item type<select name="kind" defaultValue="requirement"><option value="requirement">Included requirement</option><option value="exclusion">Explicit exclusion</option></select></label><label className="field-label">Category<select name="category" defaultValue="functional"><option value="functional">Functional</option><option value="design">Design</option><option value="content">Content</option><option value="integration">Integration</option><option value="non_functional">Non-functional</option><option value="exclusion">Exclusion</option></select></label></div><Field label="Title" name="title" placeholder="Describe one clear scope item" required minLength={3} /><label className="field-label">Description<textarea name="description" rows={3} placeholder="Clarify the expected outcome and boundaries." /></label><div className="form-grid-two"><label className="field-label">Estimated effort (hours)<input name="hours" type="number" min="0" step="0.5" defaultValue="0" /></label><label className="field-label">Priority<select name="priority" defaultValue="must"><option value="must">Must</option><option value="should">Should</option><option value="could">Could</option><option value="wont">Won't</option></select></label></div><p className="form-note"><LockKeyhole size={15} /> Scope changes are made in a draft. The approved baseline stays immutable.</p><FormActions onCancel={close} /></form>;
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default App;
