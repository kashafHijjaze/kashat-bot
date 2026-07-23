import React, { useState, useEffect } from 'react';
import { User, Session, SystemLog, EnhancedUser, AdminAnalytics, UserProfile } from '../types';
import { 
  Shield, Users, Smartphone, FileText, Database, ShieldAlert, LogOut, 
  Trash2, Power, Download, RefreshCw, AlertCircle, Search, Filter, 
  Activity, CheckCircle2, XCircle, HardDrive, Clock, BarChart3, 
  Eye, UserCheck, UserX, UserMinus, FileSpreadsheet, Sparkles, Music, Video, Image as ImageIcon
} from 'lucide-react';
import { io } from 'socket.io-client';

interface AdminPanelProps {
  currentUser: User;
  authToken: string;
  onLogout: () => void;
}

export default function AdminPanel({ currentUser, authToken, onLogout }: AdminPanelProps) {
  const [activeTab, setActiveTab] = useState<'analytics' | 'users' | 'sessions' | 'logs' | 'backup'>('analytics');
  
  const [users, setUsers] = useState<EnhancedUser[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Filtering & Sorting
  const [sessionSearch, setSessionSearch] = useState('');
  const [sessionFilter, setSessionFilter] = useState<'all' | 'connected' | 'connecting' | 'disconnected'>('all');
  
  const [userSearch, setUserSearch] = useState('');
  const [userStatusFilter, setUserStatusFilter] = useState<'all' | 'active' | 'suspended' | 'blocked'>('all');
  const [userSortBy, setUserSortBy] = useState<'commands' | 'name' | 'date' | 'active'>('commands');

  const [logSearch, setLogSearch] = useState('');

  // History detail modal for selected user
  const [selectedUserHistory, setSelectedUserHistory] = useState<{ profile: UserProfile; logs: SystemLog[] } | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Fetch full datasets
  const loadAdminData = async () => {
    setLoading(true);
    setError('');
    setSuccessMsg('');
    try {
      const headers = { 'Authorization': `Bearer ${authToken}` };

      const [usersRes, sessionsRes, logsRes, analyticsRes] = await Promise.all([
        fetch('/api/admin/users', { headers }),
        fetch('/api/admin/sessions', { headers }),
        fetch('/api/admin/logs', { headers }),
        fetch('/api/admin/analytics', { headers })
      ]);

      if (!usersRes.ok || !sessionsRes.ok || !logsRes.ok) {
        throw new Error('Failed to retrieve full administrator dataset');
      }

      setUsers(await usersRes.json());
      setSessions(await sessionsRes.json());
      setLogs(await logsRes.json());
      if (analyticsRes.ok) {
        setAnalytics(await analyticsRes.json());
      }
    } catch (err: any) {
      setError(err.message || 'Error occurred while loading admin panels');
    } finally {
      setLoading(false);
    }
  };

  // Silent update function for background sync
  const loadAdminDataSilent = async () => {
    try {
      const headers = { 'Authorization': `Bearer ${authToken}` };
      const [usersRes, sessionsRes, logsRes, analyticsRes] = await Promise.all([
        fetch('/api/admin/users', { headers }),
        fetch('/api/admin/sessions', { headers }),
        fetch('/api/admin/logs', { headers }),
        fetch('/api/admin/analytics', { headers })
      ]);
      if (usersRes.ok && sessionsRes.ok && logsRes.ok) {
        setUsers(await usersRes.json());
        setSessions(await sessionsRes.json());
        setLogs(await logsRes.json());
        if (analyticsRes.ok) setAnalytics(await analyticsRes.json());
      }
    } catch (e) {
      console.warn('Silent background sync warning:', e);
    }
  };

  useEffect(() => {
    loadAdminData();

    const socketUrl = window.location.origin;
    const newSocket = io(socketUrl);

    newSocket.on('connect', () => {
      console.log('Admin Panel connected to real-time socket updates');
      newSocket.emit('join', 'admin');
    });

    newSocket.on('admin-session-update', () => {
      loadAdminDataSilent();
    });

    newSocket.on('admin-notification', () => {
      loadAdminDataSilent();
    });

    newSocket.on('admin-log-update', (newLog: SystemLog) => {
      setLogs((prevLogs) => [newLog, ...prevLogs]);
    });

    const pollInterval = setInterval(() => {
      loadAdminDataSilent();
    }, 15000);

    return () => {
      newSocket.disconnect();
      clearInterval(pollInterval);
    };
  }, [authToken]);

  // Handle Account Status update (Active / Suspended / Blocked)
  const handleUpdateStatus = async (userId: string, newStatus: 'active' | 'suspended' | 'blocked', email: string) => {
    if (userId === currentUser.id) {
      alert("You cannot change status of your own primary admin account.");
      return;
    }
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`/api/admin/users/${userId}/status`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}` 
        },
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok) {
        setSuccessMsg(`Status updated to ${newStatus.toUpperCase()} for ${email}`);
        loadAdminData();
      } else {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update status');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Delete User Account Completely
  const handleDeleteUser = async (userId: string, email: string) => {
    if (userId === currentUser.id) {
      alert("You cannot delete your own primary admin account.");
      return;
    }
    if (!window.confirm(`CRITICAL WARNING: Are you sure you want to permanently delete user account ${email}? This will erase all user profiles and disconnect their WhatsApp session.`)) {
      return;
    }

    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.ok) {
        setSuccessMsg(`User ${email} completely deleted from system.`);
        loadAdminData();
      } else {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete user');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Toggle Role (User <-> Admin)
  const handleToggleRole = async (userId: string, email: string) => {
    if (userId === currentUser.id) {
      alert("You cannot revoke your own administrator privileges.");
      return;
    }
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`/api/admin/users/${userId}/toggle-role`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await res.json();
      if (res.ok) {
        setSuccessMsg(`Role toggled successfully for ${email}`);
        loadAdminData();
      } else {
        throw new Error(data.error || 'Failed to toggle user role');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  // View User Detailed History Modal
  const handleViewUserHistory = async (userId: string) => {
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/history`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedUserHistory(data);
      }
    } catch (e) {
      console.error('Error fetching user history:', e);
    } finally {
      setLoadingHistory(false);
    }
  };

  // Disconnect session
  const handleDisconnectSession = async (userId: string, email: string) => {
    if (!window.confirm(`Terminate WhatsApp connection for ${email}?`)) return;
    setError('');
    setSuccessMsg('');
    try {
      const res = await fetch(`/api/admin/sessions/${userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.ok) {
        setSuccessMsg(`Session terminated for ${email}`);
        loadAdminData();
      } else {
        const data = await res.json();
        throw new Error(data.error || 'Failed to disconnect session');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Filter Users
  const filteredUsers = users.filter((u) => {
    const term = userSearch.toLowerCase();
    const phone = u.whatsappPhone || '';
    const matchesSearch = 
      u.name.toLowerCase().includes(term) ||
      u.email.toLowerCase().includes(term) ||
      u.id.toLowerCase().includes(term) ||
      phone.includes(term);

    const matchesStatus = userStatusFilter === 'all' || (u.accountStatus || 'active') === userStatusFilter;
    return matchesSearch && matchesStatus;
  }).sort((a, b) => {
    if (userSortBy === 'commands') {
      return (b.profile?.totalCommands || 0) - (a.profile?.totalCommands || 0);
    }
    if (userSortBy === 'name') {
      return a.name.localeCompare(b.name);
    }
    if (userSortBy === 'date') {
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    }
    if (userSortBy === 'active') {
      return new Date(b.profile?.lastActive || 0).getTime() - new Date(a.profile?.lastActive || 0).getTime();
    }
    return 0;
  });

  // Filter Sessions
  const filteredSessions = sessions.filter((sess) => {
    const term = sessionSearch.toLowerCase();
    const matchesSearch = 
      sess.email.toLowerCase().includes(term) || 
      (sess.phone && sess.phone.includes(term)) ||
      sess.userId.toLowerCase().includes(term);
    const matchesFilter = sessionFilter === 'all' || sess.status === sessionFilter;
    return matchesSearch && matchesFilter;
  });

  // Filter Logs
  const filteredLogs = logs.filter((log) => {
    const term = logSearch.toLowerCase();
    return (
      log.email.toLowerCase().includes(term) ||
      log.action.toLowerCase().includes(term) ||
      log.message.toLowerCase().includes(term) ||
      log.id.toLowerCase().includes(term)
    );
  });

  return (
    <div className="max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-8 animate-fade-in select-none">
      
      {/* Admin Panel Header */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-6 relative overflow-hidden shadow-xl">
        <div className="absolute top-0 right-0 w-64 h-full bg-red-500/5 blur-3xl rounded-full pointer-events-none" />
        <div className="flex items-center gap-4 z-10">
          <div className="w-14 h-14 bg-red-500/10 text-red-400 border border-red-500/20 rounded-2xl flex items-center justify-center shadow-lg">
            <Shield className="w-7 h-7" />
          </div>
          <div className="space-y-1">
            <h2 className="text-xl font-black text-zinc-100 flex items-center gap-2">
              Hijjaze Bot Admin Console
            </h2>
            <p className="text-xs text-zinc-500 font-mono tracking-tight">Logged in as {currentUser.email} • Master Privileges</p>
          </div>
        </div>

        <div className="flex items-center gap-2 z-10">
          <button
            onClick={loadAdminData}
            disabled={loading}
            className="p-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-xl transition-all shadow-md active:scale-95"
            title="Refresh database state"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onLogout}
            className="flex items-center gap-2 px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-red-400 text-xs font-bold rounded-xl border border-zinc-800 transition-all shadow-md active:scale-95"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </div>

      {/* Tabs Menu */}
      <div className="flex flex-wrap gap-2 border-b border-zinc-900 pb-px">
        <button
          onClick={() => setActiveTab('analytics')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-xs font-bold transition-all ${
            activeTab === 'analytics'
              ? 'border-red-500 text-red-400 bg-red-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <BarChart3 className="w-4 h-4" />
          Analytics Dashboard
        </button>

        <button
          onClick={() => setActiveTab('users')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-xs font-bold transition-all ${
            activeTab === 'users'
              ? 'border-red-500 text-red-400 bg-red-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Users className="w-4 h-4" />
          User Profiles ({users.length})
        </button>

        <button
          onClick={() => setActiveTab('sessions')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-xs font-bold transition-all ${
            activeTab === 'sessions'
              ? 'border-red-500 text-red-400 bg-red-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Smartphone className="w-4 h-4" />
          WhatsApp Sessions ({sessions.length})
        </button>

        <button
          onClick={() => setActiveTab('logs')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-xs font-bold transition-all ${
            activeTab === 'logs'
              ? 'border-red-500 text-red-400 bg-red-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <FileText className="w-4 h-4" />
          Telemetry Logs ({logs.length})
        </button>

        <button
          onClick={() => setActiveTab('backup')}
          className={`flex items-center gap-2 px-5 py-3 border-b-2 text-xs font-bold transition-all ${
            activeTab === 'backup'
              ? 'border-red-500 text-red-400 bg-red-500/5'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Database className="w-4 h-4" />
          Backups & Export
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2.5 p-4 bg-red-950/20 border border-red-900/50 rounded-xl text-red-400 text-xs">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="flex items-center gap-2.5 p-4 bg-emerald-950/20 border border-emerald-900/40 rounded-xl text-emerald-400 text-xs animate-fade-in">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* TAB 1: SYSTEM ANALYTICS */}
      {activeTab === 'analytics' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Total Registered Users</span>
              <div className="text-3xl font-black text-zinc-100">{analytics?.totalUsers || users.length}</div>
              <span className="text-[10px] text-emerald-400 block font-mono">+{analytics?.newUsersToday || 0} registered today</span>
            </div>

            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Active WhatsApp Sessions</span>
              <div className="text-3xl font-black text-emerald-400">{analytics?.activeSessions || 0}</div>
              <span className="text-[10px] text-zinc-500 block">Online & paired now</span>
            </div>

            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Total Executed Commands</span>
              <div className="text-3xl font-black text-zinc-100">{analytics?.totalCommands || 0}</div>
              <span className="text-[10px] text-zinc-500 block">Across all active accounts</span>
            </div>

            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Total AI Requests</span>
              <div className="text-3xl font-black text-purple-400">{analytics?.totalAiRequests || 0}</div>
              <span className="text-[10px] text-zinc-500 block">GPT & Gemini queries</span>
            </div>

            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Total Downloads</span>
              <div className="text-3xl font-black text-blue-400">{analytics?.totalDownloads || 0}</div>
              <span className="text-[10px] text-zinc-500 block">🎵 {analytics?.totalAudioDownloads || 0} Audio • 🎬 {analytics?.totalVideoDownloads || 0} Video</span>
            </div>

            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Images Generated</span>
              <div className="text-3xl font-black text-amber-400">{analytics?.totalImagesGenerated || 0}</div>
              <span className="text-[10px] text-zinc-500 block">Stickers & AI Art</span>
            </div>

            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Most Active User</span>
              <div className="text-sm font-black text-zinc-200 truncate">{analytics?.mostActiveUser || 'N/A'}</div>
            </div>

            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 space-y-1 shadow-md">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Top Bot Command</span>
              <div className="text-lg font-black font-mono text-red-400 truncate">
                {analytics?.mostUsedCommand ? `.${analytics.mostUsedCommand}` : 'N/A'}
              </div>
            </div>
          </div>

          {/* Command Usage Breakdown */}
          {analytics?.globalCommandCounts && Object.keys(analytics.globalCommandCounts).length > 0 && (
            <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 space-y-4">
              <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-red-400" />
                Global Command Popularity Distribution
              </h3>

              <div className="space-y-3">
                {Object.entries(analytics.globalCommandCounts)
                  .sort((a, b) => Number(b[1]) - Number(a[1]))
                  .slice(0, 8)
                  .map(([cmd, count]) => {
                    const counts = Object.values(analytics.globalCommandCounts).map(v => Number(v));
                    const maxVal = counts.length > 0 ? Math.max(...counts) : 1;
                    const pct = Math.round((Number(count) / (maxVal || 1)) * 100);
                    return (
                      <div key={cmd} className="space-y-1">
                        <div className="flex justify-between text-xs font-mono">
                          <span className="text-zinc-300 font-bold">.{cmd}</span>
                          <span className="text-zinc-500">{count} uses</span>
                        </div>
                        <div className="w-full bg-zinc-900 h-2 rounded-full overflow-hidden">
                          <div className="bg-red-500 h-full rounded-full transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: USER DIRECTORY & MANAGEMENT */}
      {activeTab === 'users' && (
        <div className="bg-zinc-950 border border-zinc-900 rounded-2xl overflow-hidden divide-y divide-zinc-900 shadow-xl">
          <div className="p-5 bg-zinc-900/30 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-base font-bold text-zinc-200">Registered Accounts & Profiles</h3>
              <p className="text-xs text-zinc-500">Manage user accounts, suspend/block permissions, and audit command activity.</p>
            </div>

            {/* Filter controls */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search name, email, phone..."
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  className="w-full sm:w-56 pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-200 text-xs focus:outline-none focus:border-red-500 transition-colors"
                />
              </div>

              <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-xl">
                <Filter className="w-3.5 h-3.5 text-zinc-500" />
                <select
                  value={userStatusFilter}
                  onChange={(e: any) => setUserStatusFilter(e.target.value)}
                  className="bg-transparent text-xs text-zinc-300 font-bold focus:outline-none cursor-pointer"
                >
                  <option value="all">All Account Statuses</option>
                  <option value="active">Active Only</option>
                  <option value="suspended">Suspended Only</option>
                  <option value="blocked">Blocked Only</option>
                </select>
              </div>

              <select
                value={userSortBy}
                onChange={(e: any) => setUserSortBy(e.target.value)}
                className="bg-zinc-900 border border-zinc-800 px-3 py-2 text-xs text-zinc-300 font-bold rounded-xl focus:outline-none cursor-pointer"
              >
                <option value="commands">Sort by Total Commands</option>
                <option value="name">Sort by Name</option>
                <option value="date">Sort by Registration Date</option>
                <option value="active">Sort by Last Active</option>
              </select>
            </div>
          </div>

          {filteredUsers.length === 0 ? (
            <div className="p-12 text-center text-zinc-500 space-y-2">
              <Users className="w-10 h-10 mx-auto text-zinc-700" />
              <p className="text-xs">No registered user profiles matched current filter query.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-zinc-400">
                <thead className="bg-zinc-900/50 text-zinc-500 uppercase tracking-wider text-[10px] font-bold">
                  <tr>
                    <th className="p-4">User Identity</th>
                    <th className="p-4">WhatsApp Phone</th>
                    <th className="p-4">Account Status</th>
                    <th className="p-4">Role</th>
                    <th className="p-4">Total Commands</th>
                    <th className="p-4">Most Used</th>
                    <th className="p-4">Registered</th>
                    <th className="p-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {filteredUsers.map((u) => {
                    const status = u.accountStatus || 'active';
                    return (
                      <tr key={u.id} className="hover:bg-zinc-900/20 transition-colors">
                        <td className="p-4">
                          <div className="flex items-center gap-3">
                            {u.profile?.avatarUrl ? (
                              <img src={u.profile.avatarUrl} alt="Avatar" className="w-9 h-9 rounded-xl object-cover border border-zinc-800 shrink-0" />
                            ) : (
                              <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-xs font-black uppercase shrink-0 ${
                                u.role === 'admin' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-zinc-800 text-zinc-300'
                              }`}>
                                {u.name.charAt(0)}
                              </div>
                            )}
                            <div>
                              <span className="font-bold text-zinc-200 block">{u.name}</span>
                              <span className="text-[10px] text-zinc-500 block font-mono">{u.email}</span>
                            </div>
                          </div>
                        </td>

                        <td className="p-4 font-mono font-bold text-zinc-300">
                          {u.whatsappPhone ? `+${u.whatsappPhone}` : <span className="text-zinc-650 font-normal">Unpaired</span>}
                        </td>

                        <td className="p-4">
                          <span className={`px-2 py-0.5 text-[9px] font-extrabold uppercase rounded border ${
                            status === 'active' 
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                              : status === 'suspended'
                              ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                              : 'bg-red-500/10 text-red-400 border-red-500/20'
                          }`}>
                            {status}
                          </span>
                        </td>

                        <td className="p-4">
                          <span className={`px-2 py-0.5 text-[9px] font-bold uppercase rounded ${
                            u.role === 'admin' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-zinc-900 text-zinc-400'
                          }`}>
                            {u.role}
                          </span>
                        </td>

                        <td className="p-4 font-mono font-bold text-zinc-200">
                          {u.profile?.totalCommands || 0}
                        </td>

                        <td className="p-4 font-mono text-zinc-400">
                          {u.profile?.mostUsedCommand ? `.${u.profile.mostUsedCommand}` : 'None'}
                        </td>

                        <td className="p-4 font-mono text-zinc-500 text-[10px]">
                          {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : 'N/A'}
                        </td>

                        <td className="p-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* View History */}
                            <button
                              onClick={() => handleViewUserHistory(u.id)}
                              className="p-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-lg border border-zinc-800 transition-all"
                              title="View Activity History"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>

                            {/* Status controls */}
                            {status === 'active' ? (
                              <button
                                onClick={() => handleUpdateStatus(u.id, 'suspended', u.email)}
                                className="p-1.5 bg-zinc-900 hover:bg-amber-500/10 text-zinc-400 hover:text-amber-400 rounded-lg border border-zinc-800 transition-all"
                                title="Suspend Account"
                              >
                                <UserMinus className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleUpdateStatus(u.id, 'active', u.email)}
                                className="p-1.5 bg-zinc-900 hover:bg-emerald-500/10 text-zinc-400 hover:text-emerald-400 rounded-lg border border-zinc-800 transition-all"
                                title="Activate Account"
                              >
                                <UserCheck className="w-3.5 h-3.5" />
                              </button>
                            )}

                            {/* Block Account */}
                            {status !== 'blocked' && (
                              <button
                                onClick={() => handleUpdateStatus(u.id, 'blocked', u.email)}
                                className="p-1.5 bg-zinc-900 hover:bg-red-500/10 text-zinc-400 hover:text-red-400 rounded-lg border border-zinc-800 transition-all"
                                title="Block Account Completely"
                              >
                                <UserX className="w-3.5 h-3.5" />
                              </button>
                            )}

                            {/* Delete User */}
                            <button
                              onClick={() => handleDeleteUser(u.id, u.email)}
                              className="p-1.5 bg-zinc-900 hover:bg-red-500/20 text-zinc-500 hover:text-red-400 rounded-lg border border-zinc-800 transition-all"
                              title="Delete User Account"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: SESSIONS */}
      {activeTab === 'sessions' && (
        <div className="bg-zinc-950 border border-zinc-900 rounded-2xl overflow-hidden divide-y divide-zinc-900 shadow-xl">
          <div className="p-5 bg-zinc-900/30 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-base font-bold text-zinc-200">System WhatsApp Sessions</h3>
              <p className="text-xs text-zinc-500">Manage credentials for linked WhatsApp sessions.</p>
            </div>

            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search email, phone..."
                  value={sessionSearch}
                  onChange={(e) => setSessionSearch(e.target.value)}
                  className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-200 text-xs focus:outline-none focus:border-red-500 transition-colors"
                />
              </div>

              <select
                value={sessionFilter}
                onChange={(e: any) => setSessionFilter(e.target.value)}
                className="bg-zinc-900 border border-zinc-800 px-3 py-2 text-xs text-zinc-300 font-bold rounded-xl focus:outline-none cursor-pointer"
              >
                <option value="all">All Statuses</option>
                <option value="connected">Connected</option>
                <option value="connecting">Connecting</option>
                <option value="disconnected">Disconnected</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-zinc-400">
              <thead className="bg-zinc-900/50 text-zinc-500 uppercase tracking-wider text-[10px] font-bold">
                <tr>
                  <th className="p-4">Owner Account</th>
                  <th className="p-4">WhatsApp Phone</th>
                  <th className="p-4">State</th>
                  <th className="p-4">Paired Time</th>
                  <th className="p-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {filteredSessions.map((sess) => (
                  <tr key={sess.userId} className="hover:bg-zinc-900/20 transition-colors">
                    <td className="p-4 font-bold text-zinc-200">{sess.email}</td>
                    <td className="p-4 font-mono font-bold text-zinc-300">
                      {sess.phone ? `+${sess.phone}` : <span className="text-zinc-650 font-normal">Unpaired</span>}
                    </td>
                    <td className="p-4">
                      <span className={`px-2 py-0.5 text-[9px] font-extrabold uppercase rounded-full ${
                        sess.status === 'connected' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-500'
                      }`}>
                        {sess.status}
                      </span>
                    </td>
                    <td className="p-4 font-mono text-zinc-500">
                      {sess.pairedAt ? new Date(sess.pairedAt).toLocaleString() : 'N/A'}
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {sess.status === 'connected' && (
                          <a
                            href={`/api/admin/download-creds/${sess.userId}?token=${authToken}`}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1.5 bg-zinc-900 hover:bg-emerald-500/10 text-zinc-400 hover:text-emerald-400 rounded-lg border border-zinc-800 transition-all"
                            title="Download creds.json"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <button
                          onClick={() => handleDisconnectSession(sess.userId, sess.email)}
                          className="p-1.5 bg-zinc-900 hover:bg-red-500/10 text-zinc-500 hover:text-red-400 rounded-lg border border-zinc-800 transition-all"
                          title="Terminate WhatsApp Session"
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: TELEMETRY LOGS */}
      {activeTab === 'logs' && (
        <div className="bg-zinc-950 border border-zinc-900 rounded-2xl overflow-hidden flex flex-col h-[520px]">
          <div className="p-5 bg-zinc-900/30 flex items-center justify-between shrink-0">
            <h3 className="text-base font-bold text-zinc-200">Telemetry Connection Logs</h3>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
              <input
                type="text"
                placeholder="Filter logs..."
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                className="pl-9 pr-4 py-1.5 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-200 text-xs focus:outline-none focus:border-red-500"
              />
            </div>
          </div>

          <div className="flex-1 p-4 overflow-y-auto bg-black/50 font-mono text-xs text-zinc-400 space-y-2 border-t border-zinc-900">
            {filteredLogs.map((log) => (
              <div key={log.id} className="hover:bg-zinc-900/40 p-2 rounded flex items-start gap-3">
                <span className="text-zinc-650 shrink-0 select-none">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                <span className="px-1.5 py-0.5 font-bold text-[9px] rounded uppercase bg-zinc-850 text-zinc-300 shrink-0">
                  {log.action}
                </span>
                <span className="text-zinc-500 font-bold shrink-0">{log.email}:</span>
                <span className="text-zinc-300 break-all">{log.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 5: BACKUP & EXPORTS */}
      {activeTab === 'backup' && (
        <div className="p-8 bg-zinc-950 border border-zinc-900 rounded-2xl space-y-6 max-w-2xl">
          <div className="space-y-1">
            <h3 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
              <Database className="w-5 h-5 text-red-400" />
              Data Exports & System Backups
            </h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Export registered user accounts and profiles metadata or download raw JSON backups.
            </p>
          </div>

          <div className="p-5 bg-zinc-900/40 border border-zinc-900 rounded-xl space-y-4">
            <h4 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
              Export User Accounts Data
            </h4>
            <div className="flex flex-wrap gap-3">
              <a
                href={`/api/admin/users/export?format=csv&token=${authToken}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs rounded-xl transition-all shadow-md active:scale-95"
              >
                <Download className="w-4 h-4" />
                Export Users as CSV
              </a>
              <a
                href={`/api/admin/users/export?format=json&token=${authToken}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 font-bold text-xs rounded-xl transition-all active:scale-95"
              >
                <Download className="w-4 h-4" />
                Export Users as JSON
              </a>
            </div>
          </div>

          <div className="p-5 bg-zinc-900/40 border border-zinc-900 rounded-xl space-y-4">
            <h4 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-red-400" />
              Full System Raw Backup
            </h4>
            <div>
              <a
                href={`/api/admin/backup?token=${authToken}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 px-5 py-3 bg-red-500 hover:bg-red-400 text-zinc-950 font-black text-xs rounded-xl transition-all shadow-md active:scale-95"
              >
                <Download className="w-4 h-4" />
                Download Complete System Backup JSON
              </a>
            </div>
          </div>
        </div>
      )}

      {/* USER HISTORY MODAL */}
      {selectedUserHistory && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-4">
              <div className="space-y-0.5">
                <h3 className="text-base font-bold text-zinc-100">{selectedUserHistory.profile.name}</h3>
                <p className="text-xs text-zinc-500 font-mono">{selectedUserHistory.profile.email} • ID: {selectedUserHistory.profile.userId}</p>
              </div>
              <button
                onClick={() => setSelectedUserHistory(null)}
                className="p-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 rounded-lg"
              >
                ✕
              </button>
            </div>

            {/* Profile Statistics Summary */}
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div className="p-3 bg-zinc-900/50 rounded-xl border border-zinc-900">
                <span className="text-zinc-500 block">Total Commands</span>
                <span className="text-base font-black text-zinc-100">{selectedUserHistory.profile.totalCommands || 0}</span>
              </div>
              <div className="p-3 bg-zinc-900/50 rounded-xl border border-zinc-900">
                <span className="text-zinc-500 block">AI Requests</span>
                <span className="text-base font-black text-purple-400">{selectedUserHistory.profile.totalAiRequests || 0}</span>
              </div>
              <div className="p-3 bg-zinc-900/50 rounded-xl border border-zinc-900">
                <span className="text-zinc-500 block">Downloads</span>
                <span className="text-base font-black text-blue-400">{selectedUserHistory.profile.totalDownloads || 0}</span>
              </div>
            </div>

            {/* Recent Commands Feed */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-zinc-300">Recent Command Log Feed</h4>
              <div className="max-h-48 overflow-y-auto bg-zinc-900/30 p-3 rounded-xl border border-zinc-900 space-y-2 font-mono text-xs">
                {selectedUserHistory.profile.recentCommands && selectedUserHistory.profile.recentCommands.length > 0 ? (
                  selectedUserHistory.profile.recentCommands.map((c, i) => (
                    <div key={i} className="flex justify-between items-center text-zinc-400 text-[11px]">
                      <span className="font-bold text-emerald-400">.{c.command} ({c.category})</span>
                      <span className="text-zinc-600">{new Date(c.timestamp).toLocaleString()}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-zinc-600 text-[11px]">No recent command logs available.</p>
                )}
              </div>
            </div>

            {/* Account Telemetry Logs */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-zinc-300">Account System Logs</h4>
              <div className="max-h-48 overflow-y-auto bg-zinc-900/30 p-3 rounded-xl border border-zinc-900 space-y-2 font-mono text-[11px]">
                {selectedUserHistory.logs.map((l) => (
                  <div key={l.id} className="text-zinc-400">
                    <span className="text-zinc-600">[{new Date(l.timestamp).toLocaleTimeString()}]</span>{' '}
                    <span className="text-red-400 font-bold">{l.action}:</span> {l.message}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setSelectedUserHistory(null)}
                className="px-4 py-2 bg-zinc-900 text-zinc-300 text-xs font-bold rounded-xl border border-zinc-800 hover:bg-zinc-800"
              >
                Close History
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
